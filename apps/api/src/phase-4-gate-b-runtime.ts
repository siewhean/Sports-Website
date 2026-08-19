import type {
  Phase4PatchableSetupStep,
  Phase4SetupAutosaveRequest,
  Phase4SetupAutosaveResponse,
  Phase4SetupPatchRequest,
  Phase4SetupPatchResponse,
  Phase4SetupSettingsReference,
  Phase4SetupStepId,
  Phase4SetupValues,
} from "@matchday/contracts";
import { deriveAssistedSetupProgress, validateAssistedSetupStep } from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import type { ScheduleEnqueuePort } from "@matchday/scheduler";
import { ApiError, ErrorCode, type ApiErrorCode } from "./errors.js";
import type { Phase3Actor, Phase3Runtime } from "./phase-3-runtime.js";
import { Phase4Runtime, type Phase4AiOptions, type Phase4PublicProjectionPort } from "./phase-4-runtime.js";
import {
  decodePhase4Json,
  phase4SetupDocumentFromStorage,
  phase4SetupDomainValues,
  phase4SetupValuesFromStorage,
  type Phase4SetupStorageRow,
} from "./phase-4-setup-domain.js";

type JsonObject = Record<string, unknown>;
type MutableSetupValues = { -readonly [Key in keyof Phase4SetupValues]: Phase4SetupValues[Key] };

type CompetitionAccess = {
  id: string;
  organisation_id: string;
  sport_code: string;
  status: string;
  revision: number;
  capacity_revision: number;
  timezone: string;
  starts_on: string;
  ends_on: string;
};

type ActivePack = {
  sport_code: string;
  version: string;
  schema_version: number;
  definition: JsonObject | string;
  definition_hash: string;
};

function first<T>(rows: readonly T[], code: ApiErrorCode = ErrorCode.NOT_FOUND, message = "Not found"): T {
  const row = rows[0];
  if (!row) throw new ApiError(404, code, message);
  return row;
}

function mapGateBError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/idempotency key/i.test(message))
    throw new ApiError(409, ErrorCode.IDEMPOTENCY_MISMATCH, "Idempotency key was reused with different input");
  if (/revision conflict|immediately preceding|expected.*revision/i.test(message))
    throw new ApiError(409, ErrorCode.REVISION_CONFLICT, "The setup changed; refresh and retry");
  if (/archived/i.test(message))
    throw new ApiError(409, ErrorCode.COMPETITION_ARCHIVED, "Archived competitions are immutable");
  if (/locked after the first match|sport is locked/i.test(message))
    throw new ApiError(409, ErrorCode.COMPETITION_SPORT_LOCKED, "The sport cannot change after the first match starts");
  if (/permission|access|member/i.test(message)) throw new ApiError(403, ErrorCode.ACCESS_DENIED, "Access denied");
  if (/invalid|requires|must|cannot|stale|unsupported/i.test(message))
    throw new ApiError(422, ErrorCode.DOMAIN_VALIDATION_FAILED, "Request violates the current setup state");
  throw error;
}

function nextStepAfter(stepId: Phase4SetupStepId): Phase4SetupStepId {
  const order: readonly Phase4SetupStepId[] = [
    "basics",
    "capacity",
    "settings",
    "entries",
    "format_preferences",
    "format_recommendations",
    "schedule_review",
    "review_publish",
  ];
  const index = order.indexOf(stepId);
  return order[index + 1] ?? stepId;
}

function savedCompletedAt(document: ReturnType<typeof phase4SetupDocumentFromStorage>): Record<string, string> {
  return Object.fromEntries(
    document.steps.flatMap((step) => (step.completed_at ? [[step.id, step.completed_at] as const] : [])),
  );
}

function recommendedSlot(definition: JsonObject, sportCode: string): number {
  const value = Number(definition.recommendedSlotMinutes);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new ApiError(422, ErrorCode.SPORT_PACK_INVALID, `The active ${sportCode} pack has no valid recommended slot`);
  return value;
}

export class GateBPhase4Runtime extends Phase4Runtime {
  constructor(
    private readonly gateSql: PostgresJsSql,
    phase3: Phase3Runtime,
    enqueue: ScheduleEnqueuePort,
    ai: Phase4AiOptions,
    private readonly gateNow: () => Date = () => new Date(),
    publicProjection?: Phase4PublicProjectionPort,
  ) {
    super(gateSql, phase3, enqueue, ai, gateNow, publicProjection);
  }

  override async autosaveSetupDraft(
    actor: Phase3Actor,
    competitionId: string,
    request: Phase4SetupAutosaveRequest,
    requestId: string,
    options: { materialiseSelectedFormat?: boolean } = {},
  ): Promise<Phase4SetupAutosaveResponse> {
    if (request.transition.kind === "save_step" && request.transition.step.step_id === "basics") {
      return this.persistEditableStep(
        "save",
        actor,
        competitionId,
        request.expected_revision,
        request.transition.step,
        request.idempotency_key,
        requestId,
      );
    }
    return super.autosaveSetupDraft(actor, competitionId, request, requestId, options);
  }

  async patchSetupDraft(
    actor: Phase3Actor,
    competitionId: string,
    request: Phase4SetupPatchRequest,
    requestId: string,
  ): Promise<Phase4SetupPatchResponse> {
    return this.persistEditableStep(
      "patch",
      actor,
      competitionId,
      request.expected_revision,
      request.step,
      request.idempotency_key,
      requestId,
    );
  }

  private async access(tx: PostgresJsSql, competitionId: string, actor: Phase3Actor): Promise<CompetitionAccess> {
    const access = first(
      await tx.unsafe<CompetitionAccess>(
        `SELECT c.id,c.organisation_id,c.sport_code,c.status,c.revision,c.capacity_revision,c.timezone,
                c.starts_on::text,c.ends_on::text
         FROM competitions c JOIN organisation_memberships membership ON membership.organisation_id=c.organisation_id
         WHERE c.id=$1 AND membership.account_id=$2 AND membership.status='active'
           AND membership.role IN ('owner','organiser') FOR UPDATE OF c`,
        [competitionId, actor.accountId],
      ),
      ErrorCode.COMPETITION_ACCESS_DENIED,
      "Competition access denied",
    );
    if (access.status === "archived")
      throw new ApiError(409, ErrorCode.COMPETITION_ARCHIVED, "Archived competitions are immutable");
    return access;
  }

  private async setupRow(tx: PostgresJsSql, competitionId: string): Promise<Phase4SetupStorageRow> {
    return first(
      await tx.unsafe<Phase4SetupStorageRow>(
        `SELECT draft.*,competition.status competition_status
         FROM setup_drafts draft JOIN competitions competition ON competition.id=draft.competition_id
         WHERE draft.competition_id=$1 FOR UPDATE OF draft`,
        [competitionId],
      ),
      ErrorCode.SETUP_DRAFT_NOT_FOUND,
      "Setup draft not found",
    );
  }

  private async settingsReferences(
    tx: PostgresJsSql,
    competitionId: string,
  ): Promise<readonly Phase4SetupSettingsReference[]> {
    return tx.unsafe<Phase4SetupSettingsReference>(
      `SELECT settings.competition_id,'competition' scope,NULL::uuid division_id,
              settings.revision settings_revision,
              CASE WHEN settings.customised THEN 'customised' ELSE 'recommended' END mode,
              pack.schema_version pack_schema_version,pack.version pack_version,
              pack.definition_hash pack_definition_hash
       FROM competition_sport_settings settings
       JOIN sport_pack_versions pack ON pack.sport_code=settings.sport_code AND pack.version=settings.pack_version
       WHERE settings.competition_id=$1
       UNION ALL
       SELECT settings.competition_id,'division',settings.division_id,settings.revision,
              CASE WHEN settings.settings_override='{}'::jsonb THEN 'recommended' ELSE 'customised' END,
              pack.schema_version,pack.version,pack.definition_hash
       FROM division_sport_settings settings
       JOIN sport_pack_versions pack ON pack.sport_code=settings.sport_code AND pack.version=settings.pack_version
       WHERE settings.competition_id=$1
       ORDER BY scope,division_id NULLS FIRST`,
      [competitionId],
    );
  }

  private async activePack(tx: PostgresJsSql, sportCode: string): Promise<ActivePack> {
    return first(
      await tx.unsafe<ActivePack>(
        `SELECT sport_code,version,schema_version,definition,definition_hash
         FROM sport_pack_versions WHERE sport_code=$1 AND status='active'
         ORDER BY activated_at DESC NULLS LAST,created_at DESC,version DESC LIMIT 1 FOR SHARE`,
        [sportCode],
      ),
      ErrorCode.SPORT_PACK_NOT_FOUND,
      "The selected sport has no active settings pack",
    );
  }

  private async pinnedCompetitionPack(tx: PostgresJsSql, competitionId: string): Promise<ActivePack> {
    return first(
      await tx.unsafe<ActivePack>(
        `SELECT pack.sport_code,pack.version,pack.schema_version,pack.definition,pack.definition_hash
         FROM competition_sport_settings settings
         JOIN sport_pack_versions pack
           ON pack.sport_code=settings.sport_code AND pack.version=settings.pack_version
         WHERE settings.competition_id=$1
         FOR SHARE OF pack`,
        [competitionId],
      ),
      ErrorCode.SPORT_PACK_NOT_FOUND,
      "The competition's pinned settings pack was not found",
    );
  }

  private async applyCanonicalBasics(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    access: CompetitionAccess,
    previous: Phase4SetupValues,
    next: MutableSetupValues,
    requestId: string,
  ): Promise<void> {
    const basics = next.basics;
    if (!basics) throw new ApiError(422, ErrorCode.SETUP_STEP_INVALID, "Basics are required");
    const issues = validateAssistedSetupStep("basics", phase4SetupDomainValues(next));
    if (issues.length > 0) throw new ApiError(422, ErrorCode.SETUP_STEP_INVALID, issues[0]!.message);

    const oldBasics = previous.basics;
    const sportChanged = access.sport_code !== basics.sport_code;
    const capacityInputsChanged =
      sportChanged ||
      access.timezone !== basics.time_zone ||
      access.starts_on !== basics.starts_on ||
      access.ends_on !== basics.ends_on;
    const newPack = sportChanged ? await this.activePack(tx, basics.sport_code) : null;
    const oldPack = sportChanged ? await this.pinnedCompetitionPack(tx, access.id) : null;
    let capacityDefaultsChanged = false;

    if (sportChanged && newPack && oldPack) {
      const newDefinition = decodePhase4Json<JsonObject>(newPack.definition);
      const oldDefinition = decodePhase4Json<JsonObject>(oldPack.definition);
      const newRecommendedSlot = recommendedSlot(newDefinition, basics.sport_code);
      const oldRecommendedSlot = recommendedSlot(oldDefinition, access.sport_code);
      const changed = await tx.unsafe<{ id: string }>(
        `UPDATE playing_areas SET slot_minutes=$2,revision=revision+1,updated_at=$3
         WHERE competition_id=$1 AND (slot_minutes IS NULL OR slot_minutes=$4) RETURNING id`,
        [access.id, newRecommendedSlot, this.gateNow(), oldRecommendedSlot],
      );
      capacityDefaultsChanged = changed.length > 0;
    }

    // Sport-setting scope triggers compare their sport against the canonical
    // competition row, so the competition must be updated first.
    await tx.unsafe(
      `UPDATE competitions SET name=$2,sport_code=$3,venue=$4,address=$5,locality=$6,country_code=$7,
         starts_on=$8::date,ends_on=$9::date,timezone=$10,locale=$11,
         capacity_revision=capacity_revision+CASE WHEN $12::boolean THEN 1 ELSE 0 END,
         revision=revision+1,updated_at=$13 WHERE id=$1`,
      [
        access.id,
        basics.name.trim(),
        basics.sport_code,
        basics.location.venue.trim(),
        basics.location.address.trim(),
        basics.location.locality?.trim() || null,
        basics.location.country_code,
        basics.starts_on,
        basics.ends_on,
        basics.time_zone,
        basics.locale,
        capacityInputsChanged || capacityDefaultsChanged,
        this.gateNow(),
      ],
    );

    if (sportChanged && newPack) {
      const definition = decodePhase4Json<JsonObject>(newPack.definition);
      await tx.unsafe(
        `UPDATE competition_sport_settings SET sport_code=$2,pack_version=$3,pack_schema_version=$4,
           recommended_snapshot=$5::jsonb,settings_override='{}'::jsonb,customised=false,
           revision=revision+1,updated_by=$6,updated_at=$7 WHERE competition_id=$1`,
        [
          access.id,
          basics.sport_code,
          newPack.version,
          newPack.schema_version,
          definition.recommendedSettings ?? {},
          actor.accountId,
          this.gateNow(),
        ],
      );
      await tx.unsafe(
        `UPDATE division_sport_settings SET sport_code=$2,pack_version=$3,settings_override='{}'::jsonb,
           revision=revision+1,updated_by=$4,updated_at=$5 WHERE competition_id=$1`,
        [access.id, basics.sport_code, newPack.version, actor.accountId, this.gateNow()],
      );
      next.settings = await this.settingsReferences(tx, access.id);
    }

    if (capacityInputsChanged || capacityDefaultsChanged) next.capacity = null;
    if (
      sportChanged ||
      oldBasics?.entry_count !== basics.entry_count ||
      oldBasics?.division_count !== basics.division_count ||
      capacityInputsChanged
    ) {
      next.format_recommendations = null;
      next.schedule_review = null;
      next.review_publish = null;
    }

    await tx.unsafe(
      `INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,after_state)
       VALUES($1,$2,'account',$3,'competition.setup_basics.updated','competition',$4,$5::jsonb)`,
      [requestId, actor.accountId, access.organisation_id, access.id, basics],
    );
    await tx.unsafe(
      `INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
       VALUES('competition',$1,'competition.setup_basics.updated',$2::jsonb,$3)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        access.id,
        { competition_id: access.id, sport_code: basics.sport_code },
        `phase4:setup-basics:${requestId}:${access.id}`,
      ],
    );
  }

  private async replay(
    tx: PostgresJsSql,
    access: CompetitionAccess,
    expectedRevision: number,
    step: Phase4PatchableSetupStep,
    idempotencyKey: string,
    operation: "setup.patch" | "setup.save",
  ): Promise<Phase4SetupPatchResponse | Phase4SetupAutosaveResponse | null> {
    const receipt = (
      await tx.unsafe<{ operation: string; response: Phase4SetupStorageRow | string }>(
        `SELECT operation,response FROM phase4_mutation_receipts
         WHERE organisation_id=$1 AND idempotency_key=$2`,
        [access.organisation_id, idempotencyKey],
      )
    )[0];
    if (!receipt) return null;
    const saved = decodePhase4Json<Phase4SetupStorageRow>(receipt.response);
    if (saved.competition_id !== access.id) {
      const current = await this.setupRow(tx, access.id);
      return {
        outcome: "idempotency_mismatch",
        document: phase4SetupDocumentFromStorage(current),
      };
    }
    saved.competition_status = access.status;
    const savedValues = phase4SetupValuesFromStorage(saved);
    const equal = Boolean(
      (
        await tx.unsafe<{ equal: boolean }>(`SELECT $1::jsonb=$2::jsonb equal`, [savedValues[step.step_id], step.value])
      )[0]?.equal,
    );
    const same = receipt.operation === operation && saved.revision === expectedRevision + 1 && equal;
    const document = phase4SetupDocumentFromStorage(saved);
    return same ? { outcome: "idempotent_replay", document } : { outcome: "idempotency_mismatch", document };
  }

  private async persistEditableStep(
    mode: "patch" | "save",
    actor: Phase3Actor,
    competitionId: string,
    expectedRevision: number,
    step: Phase4PatchableSetupStep,
    idempotencyKey: string,
    requestId: string,
  ): Promise<Phase4SetupPatchResponse | Phase4SetupAutosaveResponse> {
    if (!this.gateSql.begin) throw new Error("Phase 4 setup mutations require a transaction-capable PostgreSQL client");
    try {
      return await this.gateSql.begin(async (tx) => {
        const access = await this.access(tx, competitionId, actor);
        const replay = await this.replay(
          tx,
          access,
          expectedRevision,
          step,
          idempotencyKey,
          mode === "patch" ? "setup.patch" : "setup.save",
        );
        if (replay) return replay;

        const row = await this.setupRow(tx, competitionId);
        const current = phase4SetupDocumentFromStorage(row);
        if (row.status === "expired" || this.gateNow().getTime() >= new Date(row.expires_at).getTime())
          return { outcome: "expired", document: current };
        if (row.status !== "active") return { outcome: "read_only", document: current };
        if (row.revision !== expectedRevision) return { outcome: "conflict", current };

        const previous = phase4SetupValuesFromStorage(row);
        const next = structuredClone(previous) as MutableSetupValues;
        (next as Record<string, unknown>)[step.step_id] = step.value;
        if (step.step_id === "basics") await this.applyCanonicalBasics(tx, actor, access, previous, next, requestId);
        else {
          const issues = validateAssistedSetupStep(step.step_id, phase4SetupDomainValues(next));
          if (issues.length > 0) throw new ApiError(422, ErrorCode.SETUP_STEP_INVALID, issues[0]!.message);
        }

        const progress = deriveAssistedSetupProgress(phase4SetupDomainValues(next));
        const targetStep = mode === "patch" ? row.current_step : nextStepAfter(step.step_id);
        const selected = progress.steps.find((item) => item.id === targetStep);
        if (!selected || selected.prerequisiteStepIds.some((id) => !progress.completedSteps.includes(id)))
          throw new ApiError(422, ErrorCode.SETUP_PREREQUISITE_MISSING, "Complete prerequisite setup steps first");
        const completedAt = savedCompletedAt(current);
        for (const id of progress.completedSteps) completedAt[id] ??= this.gateNow().toISOString();
        const validation = {
          valid: progress.steps.every((item) => item.errors.length === 0),
          pending: false,
          issues: progress.steps.flatMap((item) => item.errors),
          completed_at_by_step: completedAt,
        };
        const functionName = mode === "patch" ? "phase4_patch_setup_draft" : "phase4_save_setup_draft";
        const result =
          mode === "patch"
            ? first(
                await tx.unsafe<{ value: Phase4SetupStorageRow | string }>(
                  `SELECT ${functionName}($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10) value`,
                  [
                    access.organisation_id,
                    competitionId,
                    actor.accountId,
                    expectedRevision,
                    step.step_id,
                    next,
                    progress.completedSteps,
                    validation,
                    idempotencyKey,
                    requestId,
                  ],
                ),
                ErrorCode.SETUP_PATCH_FAILED,
                "Setup patch failed",
              ).value
            : first(
                await tx.unsafe<{ value: Phase4SetupStorageRow | string }>(
                  `SELECT ${functionName}($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11) value`,
                  [
                    access.organisation_id,
                    competitionId,
                    actor.accountId,
                    expectedRevision,
                    targetStep,
                    progress.completedSteps,
                    next,
                    validation,
                    "active",
                    idempotencyKey,
                    requestId,
                  ],
                ),
                ErrorCode.SETUP_SAVE_FAILED,
                "Setup save failed",
              ).value;
        const saved = decodePhase4Json<Phase4SetupStorageRow>(result);
        saved.competition_status = access.status;
        return { outcome: "saved", document: phase4SetupDocumentFromStorage(saved) };
      });
    } catch (error: unknown) {
      mapGateBError(error);
    }
  }
}
