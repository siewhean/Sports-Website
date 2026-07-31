import type {
  Phase4SetupAutosaveRequest,
  Phase4SetupAutosaveResponse,
  Phase4SetupDocument,
  Phase4SetupPatchRequest,
  Phase4SetupPatchResponse,
} from "@matchday/contracts";
import type { PostgresJsSql } from "@matchday/identity";
import type { ScheduleEnqueuePort } from "@matchday/scheduler";
import { ApiError } from "./errors.js";
import { GateCC4Operations } from "./gate-c-c4-operations.js";
import { GateCC4PostgresPublicationPort } from "./gate-c-c4-postgres-publisher.js";
import { GateCC4Runtime } from "./gate-c-c4-runtime.js";
import type { Phase2Runtime } from "./phase-2-runtime.js";
import type { Phase3Actor, Phase3Runtime } from "./phase-3-runtime.js";
import { GateBPhase4Runtime } from "./phase-4-gate-b-runtime.js";
import type { Phase4AiOptions, Phase4PublicProjectionPort } from "./phase-4-runtime.js";
import {
  decodePhase4Json,
  phase4SetupDocumentFromStorage,
  type Phase4SetupStorageRow,
} from "./phase-4-setup-domain.js";

type ReadAccess = {
  organisation_id: string;
  status: string;
  membership_role: "owner" | "organiser" | "viewer";
};

type WritableOrganisation = {
  id: string;
  name: string;
  role: "owner" | "organiser";
};

export type OrganisationBootstrapReceipt = WritableOrganisation & {
  created: boolean;
};

function first<T>(rows: readonly T[], code: string, message: string): T {
  const row = rows[0];
  if (!row) throw new ApiError(404, code, message);
  return row;
}

function readOnlyDocument(document: Phase4SetupDocument): Phase4SetupDocument {
  return {
    ...document,
    permission: "read",
    read_only: true,
    autosave: { ...document.autosave, status: "read_only" },
  };
}

export class ReliableGateBPhase4Runtime extends GateBPhase4Runtime {
  readonly gateCC4: GateCC4Runtime;
  readonly gateCC4Operations: GateCC4Operations;

  constructor(
    private readonly reliableSql: PostgresJsSql,
    phase3: Phase3Runtime,
    enqueue: ScheduleEnqueuePort,
    ai: Phase4AiOptions,
    private readonly reliableNow: () => Date = () => new Date(),
    publicProjection?: Phase4PublicProjectionPort,
    gateCC4ProjectionRuntime?: Pick<Phase2Runtime, "writePublicProjection">,
    gateCC4PublicOrigin = "http://localhost:3000",
  ) {
    super(reliableSql, phase3, enqueue, ai, reliableNow, publicProjection);
    this.gateCC4 = new GateCC4Runtime(
      reliableSql,
      gateCC4ProjectionRuntime
        ? new GateCC4PostgresPublicationPort(gateCC4ProjectionRuntime, reliableNow)
        : undefined,
      reliableNow,
    );
    this.gateCC4Operations = new GateCC4Operations(reliableSql, gateCC4PublicOrigin, reliableNow);
  }

  async ensureWritableOrganisation(
    actor: Phase3Actor,
    requestId: string,
  ): Promise<OrganisationBootstrapReceipt> {
    if (!this.reliableSql.begin) {
      throw new Error("Organiser workspace provisioning requires a transaction-capable PostgreSQL client");
    }
    return this.reliableSql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `organisation-bootstrap:${actor.accountId}`,
      ]);
      const existing = (
        await tx.unsafe<WritableOrganisation>(
          `SELECT organisation.id,organisation.name,membership.role
           FROM organisation_memberships membership
           JOIN organisations organisation ON organisation.id=membership.organisation_id
           WHERE membership.account_id=$1
             AND membership.status='active'
             AND membership.role IN ('owner','organiser')
           ORDER BY lower(organisation.name),organisation.id
           LIMIT 1`,
          [actor.accountId],
        )
      )[0];
      if (existing) return { ...existing, created: false };

      const account = first(
        await tx.unsafe<{ display_name: string }>(
          `SELECT display_name FROM accounts WHERE id=$1 AND status='active' FOR SHARE`,
          [actor.accountId],
        ),
        "ACCOUNT_NOT_ACTIVE",
        "An active account is required to create an organiser workspace",
      );
      const occurredAt = this.reliableNow();
      const workspaceName = `${account.display_name.trim() || "My"} workspace`;
      const organisation = first(
        await tx.unsafe<{ id: string; name: string }>(
          `INSERT INTO organisations(name,slug,created_at,updated_at)
           VALUES($1,$2,$3,$3)
           RETURNING id,name`,
          [workspaceName, `workspace-${actor.accountId}`, occurredAt],
        ),
        "ORGANISATION_CREATE_FAILED",
        "The organiser workspace could not be created",
      );
      await tx.unsafe(
        `INSERT INTO organisation_memberships(
           organisation_id,account_id,role,status,created_at,updated_at
         ) VALUES($1,$2,'owner','active',$3,$3)`,
        [organisation.id, actor.accountId, occurredAt],
      );
      await tx.unsafe(
        `INSERT INTO audit_events(
           occurred_at,request_id,actor_account_id,actor_type,organisation_id,
           action,target_type,target_id,after_state,metadata
         ) VALUES($1,$2,$3,'account',$4,'organisation.created','organisation',$5,$6::jsonb,$7::jsonb)`,
        [
          occurredAt,
          requestId,
          actor.accountId,
          organisation.id,
          organisation.id,
          { name: organisation.name, role: "owner" },
          { bootstrap: true },
        ],
      );
      first(
        await tx.unsafe<{ id: string }>(
          `INSERT INTO outbox_events(
             aggregate_type,aggregate_id,event_type,payload,idempotency_key,created_at,available_at
           ) VALUES('organisation',$1,'organisation.created',$2::jsonb,$3,$4,$4)
           RETURNING id`,
          [
            organisation.id,
            { organisation_id: organisation.id, owner_account_id: actor.accountId, bootstrap: true },
            `organisation.bootstrap:${actor.accountId}`,
            occurredAt,
          ],
        ),
        "ORGANISATION_OUTBOX_FAILED",
        "The organiser workspace evidence could not be recorded",
      );
      return { id: organisation.id, name: organisation.name, role: "owner", created: true };
    });
  }

  private async readAccess(sql: PostgresJsSql, actor: Phase3Actor, competitionId: string): Promise<ReadAccess> {
    return first(
      await sql.unsafe<ReadAccess>(
        `SELECT competition.organisation_id,competition.status,membership.role membership_role
         FROM competitions competition
         JOIN organisation_memberships membership
           ON membership.organisation_id=competition.organisation_id
         WHERE competition.id=$1
           AND membership.account_id=$2
           AND membership.status='active'
           AND membership.role IN ('owner','organiser','viewer')`,
        [competitionId, actor.accountId],
      ),
      "COMPETITION_ACCESS_DENIED",
      "Competition access denied",
    );
  }

  private async assertSetupWrite(actor: Phase3Actor, competitionId: string): Promise<ReadAccess> {
    const access = await this.readAccess(this.reliableSql, actor, competitionId);
    if (access.membership_role === "viewer")
      throw new ApiError(403, "COMPETITION_ACCESS_DENIED", "Competition access denied");
    if (access.status === "archived")
      throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
    return access;
  }

  override async autosaveSetupDraft(
    actor: Phase3Actor,
    competitionId: string,
    request: Phase4SetupAutosaveRequest,
    requestId: string,
  ): Promise<Phase4SetupAutosaveResponse> {
    if (request.transition.kind === "save_step" && request.transition.step.step_id === "basics")
      await this.assertSetupWrite(actor, competitionId);
    return super.autosaveSetupDraft(actor, competitionId, request, requestId);
  }

  override async patchSetupDraft(
    actor: Phase3Actor,
    competitionId: string,
    request: Phase4SetupPatchRequest,
    requestId: string,
  ): Promise<Phase4SetupPatchResponse> {
    await this.assertSetupWrite(actor, competitionId);
    return super.patchSetupDraft(actor, competitionId, request, requestId);
  }

  async resumeSetupDraft(
    actor: Phase3Actor,
    competitionId: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<Phase4SetupDocument> {
    if (!this.reliableSql.begin)
      throw new Error("Phase 4 setup resume requires a transaction-capable PostgreSQL client");
    return this.reliableSql.begin(async (tx) => {
      const access = await this.readAccess(tx, actor, competitionId);
      if (access.membership_role === "viewer") {
        const row = first(
          await tx.unsafe<Phase4SetupStorageRow>(
            `SELECT draft.*,competition.status competition_status
             FROM setup_drafts draft
             JOIN competitions competition ON competition.id=draft.competition_id
             WHERE draft.competition_id=$1`,
            [competitionId],
          ),
          "SETUP_DRAFT_NOT_FOUND",
          "Setup draft not found",
        );
        return readOnlyDocument(phase4SetupDocumentFromStorage(row));
      }
      if (access.status === "archived")
        throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
      const resumed = first(
        await tx.unsafe<{ value: Phase4SetupStorageRow | string }>(
          `SELECT phase4_resume_setup_draft($1,$2,$3,$4,$5) value`,
          [access.organisation_id, competitionId, actor.accountId, idempotencyKey, requestId],
        ),
        "SETUP_RESUME_FAILED",
        "Setup draft could not be resumed",
      );
      const row = decodePhase4Json<Phase4SetupStorageRow>(resumed.value);
      row.competition_status = access.status;
      return phase4SetupDocumentFromStorage(row);
    });
  }

  override async readSetupDraft(actor: Phase3Actor, competitionId: string): Promise<Phase4SetupDocument> {
    const access = await this.readAccess(this.reliableSql, actor, competitionId);
    const row = first(
      await this.reliableSql.unsafe<Phase4SetupStorageRow>(
        `SELECT draft.*,competition.status competition_status
         FROM setup_drafts draft
         JOIN competitions competition ON competition.id=draft.competition_id
         WHERE draft.competition_id=$1`,
        [competitionId],
      ),
      "SETUP_DRAFT_NOT_FOUND",
      "Setup draft not found",
    );
    const document = phase4SetupDocumentFromStorage(row);
    return access.membership_role === "viewer" ? readOnlyDocument(document) : document;
  }
}
