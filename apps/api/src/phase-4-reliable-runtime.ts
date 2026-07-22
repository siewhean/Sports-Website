import type {
  Phase4FormatDraftView,
  Phase4SetupAutosaveRequest,
  Phase4SetupAutosaveResponse,
  Phase4SetupDocument,
  Phase4SetupPatchRequest,
  Phase4SetupPatchResponse,
  Phase4SetupRecommendationSelection,
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

function truthfulSetupDocument(document: Phase4SetupDocument): Phase4SetupDocument {
  return document.read_only ? readOnlySetupDocument(document) : document;
}

export function normalizeSetupAutosaveResponse(response: Phase4SetupAutosaveResponse): Phase4SetupAutosaveResponse {
  if (response.outcome === "conflict") {
    return { ...response, current: truthfulSetupDocument(response.current) };
  }
  return { ...response, document: truthfulSetupDocument(response.document) };
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

export function canonicalRecommendationSelection(
  current: Phase4SetupRecommendationSelection,
  requested: Phase4SetupRecommendationSelection,
): Phase4SetupRecommendationSelection {
  const requestedId = requested.selected_recommendation_id;
  if (requestedId === null)
    throw new ApiError(422, "FORMAT_RECOMMENDATION_REQUIRED", "Select a format recommendation before continuing");
  const candidate = [
    ...current.recommendations,
    ...(current.requires_changes ? [current.requires_changes] : []),
  ].find((item) => item.id === requestedId);
  if (!candidate)
    throw new ApiError(409, "STALE_FORMAT_REFERENCE", "The selected format recommendation is no longer available");
  if (candidate.capacity_status === "requires_changes" && !requested.acknowledged_capacity_shortfall) {
    throw new ApiError(
      422,
      "CAPACITY_SHORTFALL_ACKNOWLEDGEMENT_REQUIRED",
      "Acknowledge the capacity shortfall before selecting this format",
    );
  }
  return {
    ...current,
    selected_recommendation_id: requestedId,
    acknowledged_capacity_shortfall:
      candidate.capacity_status === "requires_changes" && requested.acknowledged_capacity_shortfall,
  };
}

export class ReliableGateBPhase4Runtime extends GateBPhase4Runtime {
  constructor(
    private readonly reliableSql: PostgresJsSql,
    private readonly reliablePhase3: Phase3Runtime,
    enqueue: ScheduleEnqueuePort,
    ai: Phase4AiOptions,
    now: () => Date = () => new Date(),
    private readonly reliablePublicProjection?: Phase4PublicProjectionPort,
  ) {
    super(reliableSql, reliablePhase3, enqueue, ai, now, reliablePublicProjection);
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

  private async assertScheduleSourcesCurrentWithoutLockOverlay(tx: PostgresJsSql, jobId: string): Promise<void> {
    const current = (
      await tx.unsafe<{ current: boolean }>(
        `SELECT (
          (job.input_snapshot->>'source_revision')::integer=competition.revision
          AND (job.input_snapshot->>'capacity_revision')::integer=competition.capacity_revision
          AND job.input_snapshot->>'capacity_hash'=phase4_capacity_hash(competition.id)
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(job.input_snapshot->'matches') item
            LEFT JOIN matches match
              ON match.id=(item->>'match_id')::uuid AND match.competition_id=job.competition_id
            LEFT JOIN format_revisions format ON format.id=match.format_revision_id
            WHERE match.id IS NULL OR format.status<>'published'
          )
          AND (
            SELECT count(DISTINCT item->>'division_id')
            FROM jsonb_array_elements(job.input_snapshot->'matches') item
          )=(SELECT count(*) FROM divisions division WHERE division.competition_id=job.competition_id)
          AND NOT EXISTS (
            SELECT 1 FROM divisions division
            WHERE division.competition_id=job.competition_id AND
              COALESCE((
                SELECT jsonb_agg(entry.id::text ORDER BY entry.id::text)
                FROM division_entries entry
                WHERE entry.division_id=division.id AND entry.status IN ('confirmed','active')
              ),'[]'::jsonb) IS DISTINCT FROM COALESCE((
                SELECT jsonb_agg(possible_entries.entry_id ORDER BY possible_entries.entry_id)
                FROM (
                  SELECT DISTINCT possible.value #>> '{}' entry_id
                  FROM jsonb_array_elements(job.input_snapshot->'matches') item
                  CROSS JOIN LATERAL jsonb_array_elements(item->'possible_entry_ids') possible(value)
                  WHERE item->>'division_id'=division.id::text
                ) possible_entries
              ),'[]'::jsonb)
          )
        ) current
        FROM schedule_generation_jobs job
        JOIN competitions competition ON competition.id=job.competition_id
        WHERE job.id=$1`,
        [jobId],
      )
    )[0]?.current;
    if (!current) {
      throw new ApiError(
        409,
        "STALE_SCHEDULE_INPUT",
        "Capacity, entries, or published formats changed; generate a new schedule",
      );
    }
  }

  private async canonicalizeSetupRequest(
    actor: Phase3Actor,
    competitionId: string,
    request: Phase4SetupAutosaveRequest,
  ): Promise<Phase4SetupAutosaveRequest> {
    if (request.transition.kind !== "save_step" || request.transition.step.step_id !== "format_recommendations") {
      return request;
    }
    const current = await this.readSetupDraft(actor, competitionId);
    const currentSelection = current.values.format_recommendations;
    if (!currentSelection)
      throw new ApiError(409, "STALE_FORMAT_REFERENCE", "Format recommendations must be regenerated");
    return {
      ...request,
      transition: {
        kind: "save_step",
        step: {
          step_id: "format_recommendations",
          value: canonicalRecommendationSelection(currentSelection, request.transition.step.value),
        },
      },
    };
  }

  override async autosaveSetupDraft(
    actor: Phase3Actor,
    competitionId: string,
    request: Phase4SetupAutosaveRequest,
    requestId: string,
  ): Promise<Phase4SetupAutosaveResponse> {
    if (request.transition.kind === "save_step" && request.transition.step.step_id === "basics")
      await this.assertSetupWrite(actor, competitionId);
    const canonicalRequest = await this.canonicalizeSetupRequest(actor, competitionId, request);
    return normalizeSetupAutosaveResponse(
      await super.autosaveSetupDraft(actor, competitionId, canonicalRequest, requestId),
    );
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

  override async readFormatBuilder(actor: Phase3Actor, competitionId: string, divisionId: string) {
    const workspace = await super.readFormatBuilder(actor, competitionId, divisionId);
    if (workspace.draft) {
      return { ...workspace, draft: correctFormatDraftMetrics(workspace.draft) };
    }

    const published = workspace.revisions.find((revision) => revision.status === "published");
    if (!published) return workspace;

    const capacity = await this.reliablePhase3.capacity(actor, competitionId);
    const metrics = calculateFormatMetrics(published.document.graph as FormatGraph);
    const available = capacity.effective.availableMatchSlots;
    const required = metrics.matchCount;
    const selected: Phase4FormatDraftView = {
      competition_id: published.competition_id,
      division_id: published.division_id,
      draft_id: published.revision_id,
      parent_revision_id: published.parent_revision_id,
      root_revision_id: published.root_revision_id,
      revision: published.revision,
      status: published.status,
      created_at: published.created_at,
      updated_at: published.published_at ?? published.created_at,
      permission: "view",
      read_only: true,
      definition_hash: published.definition_hash,
      document: published.document,
      metrics: {
        match_count: metrics.matchCount,
        guaranteed_matches: metrics.guaranteedMatches,
        maximum_matches: metrics.maximumMatches,
      },
      capacity: {
        available_match_slots: available,
        required_match_slots: required,
        spare_match_slots: available - required,
        status: available < required ? "does_not_fit" : available === required ? "tight" : "comfortable",
        evidence_revision: capacity.revision,
      },
      validation: {
        pending: false,
        validated_definition_hash: published.definition_hash,
        issues: [],
      },
    };
    return { ...workspace, draft: selected };
  }

  override async saveFormatRevision(...args: Parameters<GateBPhase4Runtime["saveFormatRevision"]>) {
    return correctFormatDraftMetrics(await super.saveFormatRevision(...args));
  }

  override async applyFormatTemplate(...args: Parameters<GateBPhase4Runtime["applyFormatTemplate"]>) {
    return correctFormatDraftMetrics(await super.applyFormatTemplate(...args));
  }

  override async publishScheduleRevision(
    actor: Phase3Actor,
    revisionId: string,
    input: { idempotency_key: string; expected_revision: number },
    requestId: string,
  ) {
    if (!this.reliableSql.begin)
      throw new Error("Phase 4 schedule publication requires a transaction-capable PostgreSQL client");
    const outcome = await this.reliableSql.begin(async (tx) => {
      const revision = first(
        await tx.unsafe<{
          competition_id: string;
          revision: number;
          status: string;
          source_job_id: string | null;
        }>(`SELECT competition_id,revision,status,source_job_id FROM schedule_revisions WHERE id=$1 FOR UPDATE`, [
          revisionId,
        ]),
        "SCHEDULE_REVISION_NOT_FOUND",
        "Schedule revision not found",
      );
      const access = await this.readAccess(tx, actor, revision.competition_id);
      if (access.membership_role === "viewer")
        throw new ApiError(403, "COMPETITION_ACCESS_DENIED", "Competition access denied");
      if (access.status === "archived")
        throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
      if (!this.reliablePublicProjection)
        throw new ApiError(500, "PUBLIC_PROJECTION_UNAVAILABLE", "Public schedule projection is unavailable");

      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2,0))`, [
        access.organisation_id,
        input.idempotency_key,
      ]);
      const requestHash = first(
        await tx.unsafe<{ hash: string }>(`SELECT phase4_sha256_json($1::jsonb) hash`, [
          { revision_id: revisionId, ...input },
        ]),
        "HASH_FAILED",
        "Hash failed",
      ).hash;
      const receipt = (
        await tx.unsafe<{ operation: string; request_hash: string }>(
          `SELECT operation,request_hash FROM phase4_mutation_receipts
           WHERE organisation_id=$1 AND idempotency_key=$2`,
          [access.organisation_id, input.idempotency_key],
        )
      )[0];
      if (receipt) {
        if (receipt.operation !== "schedule.publish" || receipt.request_hash !== requestHash) {
          throw new ApiError(409, "IDEMPOTENCY_MISMATCH", "Idempotency key was reused with different input");
        }
      } else {
        if (revision.revision !== input.expected_revision || revision.status !== "ready_for_review") {
          throw new ApiError(409, "REVISION_CONFLICT", "Only the current review-ready schedule can be published");
        }
        if (revision.source_job_id) {
          await this.assertScheduleSourcesCurrentWithoutLockOverlay(tx, revision.source_job_id);
        }
        await tx.unsafe(`SELECT phase4_publish_schedule_revision($1,$2,$3)`, [revisionId, actor.accountId, requestId]);
        await tx.unsafe(
          `UPDATE competitions SET status=CASE WHEN status='draft' THEN 'active' ELSE status END,updated_at=now()
           WHERE id=$1`,
          [revision.competition_id],
        );
        await tx.unsafe(
          `INSERT INTO phase4_mutation_receipts(organisation_id,idempotency_key,operation,request_hash,response)
           VALUES($1,$2,'schedule.publish',$3,$4::jsonb)`,
          [access.organisation_id, input.idempotency_key, requestHash, { revision_id: revisionId }],
        );
      }
      const publication = first(
        await tx.unsafe<{ schedule_version: number; result_version: number }>(
          `SELECT schedule_version,result_version FROM competition_publications WHERE competition_id=$1`,
          [revision.competition_id],
        ),
        "PUBLICATION_NOT_FOUND",
        "Publication state not found",
      );
      await this.reliablePublicProjection.writePublicProjection(
        tx,
        revision.competition_id,
        publication.schedule_version,
        publication.result_version,
      );
      return {
        scheduleVersion: publication.schedule_version,
        idempotentReplay: Boolean(receipt),
      };
    });
    return {
      ...(await super.readScheduleRevision(actor, revisionId)),
      schedule_version: outcome.scheduleVersion,
      idempotent_replay: outcome.idempotentReplay,
    };
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
      return truthfulSetupDocument(phase4SetupDocumentFromStorage(row));
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
    const document = truthfulSetupDocument(phase4SetupDocumentFromStorage(row));
    return access.membership_role === "viewer" ? readOnlySetupDocument(document) : document;
  }
}
