import type {
  Phase4FormatDraftView,
  Phase4SetupAutosaveRequest,
  Phase4SetupAutosaveResponse,
  Phase4SetupDocument,
  Phase4SetupPatchRequest,
  Phase4SetupPatchResponse,
} from "@matchday/contracts";
import { calculateFormatMetrics, type FormatGraph } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import type { ScheduleEnqueuePort } from "@matchday/scheduler";
import { ApiError } from "./errors.js";
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

function first<T>(rows: readonly T[], code: string, message: string): T {
  const row = rows[0];
  if (!row) throw new ApiError(404, code, message);
  return row;
}

export function readOnlySetupDocument(document: Phase4SetupDocument): Phase4SetupDocument {
  return {
    ...document,
    permission: "read",
    read_only: true,
    autosave: {
      ...document.autosave,
      status: document.status === "expired" ? "expired" : "read_only",
    },
  };
}

export function normalizeSetupAutosaveResponse(response: Phase4SetupAutosaveResponse): Phase4SetupAutosaveResponse {
  if (response.outcome === "conflict") {
    return response.current.read_only ? { ...response, current: readOnlySetupDocument(response.current) } : response;
  }
  return response.document.read_only ? { ...response, document: readOnlySetupDocument(response.document) } : response;
}

export function correctFormatDraftMetrics(draft: Phase4FormatDraftView): Phase4FormatDraftView {
  const metrics = calculateFormatMetrics(draft.document.graph as FormatGraph);
  return {
    ...draft,
    metrics: {
      match_count: metrics.matchCount,
      guaranteed_matches: metrics.guaranteedMatches,
      maximum_matches: metrics.maximumMatches,
    },
  };
}

export class ReliableGateBPhase4Runtime extends GateBPhase4Runtime {
  constructor(
    private readonly reliableSql: PostgresJsSql,
    phase3: Phase3Runtime,
    enqueue: ScheduleEnqueuePort,
    ai: Phase4AiOptions,
    now: () => Date = () => new Date(),
    publicProjection?: Phase4PublicProjectionPort,
  ) {
    super(reliableSql, phase3, enqueue, ai, now, publicProjection);
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
    return normalizeSetupAutosaveResponse(await super.autosaveSetupDraft(actor, competitionId, request, requestId));
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

  override async readFormatBuilder(...args: Parameters<GateBPhase4Runtime["readFormatBuilder"]>) {
    const workspace = await super.readFormatBuilder(...args);
    return {
      ...workspace,
      draft: workspace.draft ? correctFormatDraftMetrics(workspace.draft) : null,
    };
  }

  override async saveFormatRevision(...args: Parameters<GateBPhase4Runtime["saveFormatRevision"]>) {
    return correctFormatDraftMetrics(await super.saveFormatRevision(...args));
  }

  override async applyFormatTemplate(...args: Parameters<GateBPhase4Runtime["applyFormatTemplate"]>) {
    return correctFormatDraftMetrics(await super.applyFormatTemplate(...args));
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
        return readOnlySetupDocument(phase4SetupDocumentFromStorage(row));
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
    return access.membership_role === "viewer" ? readOnlySetupDocument(document) : document;
  }
}
