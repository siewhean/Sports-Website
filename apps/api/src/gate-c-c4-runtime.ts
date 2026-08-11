import { createHash, randomUUID } from "node:crypto";
import type {
  GateCRepairActionRecord,
  GateCRepairActionView,
  GateCRepairPublicationReceipt,
  GateCRepairPublicationRequest,
  GateCRepairRevisionCreateRequest,
  GateCRepairRevisionCreateResponse,
  GateCRepairRevisionView,
  GateCRepairScheduleAdjustment,
  GateCRepairWorkspaceView,
} from "@matchday/contracts";
import {
  buildRepairPublicationPlan,
  calculateAffectedMatchClosure,
  type AffectedMatchClosure,
  type RepairPublicationDecision,
  type RepairPublicationPlan,
} from "@matchday/domain";
import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";

type AccessRow = {
  competition_id: string;
  organisation_id: string;
  competition_status: string;
};

type CorrectionSourceRow = {
  correction_id: string;
  competition_id: string;
  division_id: string;
  match_id: string;
  result_version: number;
  current_result_version: number;
  schedule_version: number;
  source_projection_version: number;
  format_revision_id: string;
};

type MatchRow = {
  match_id: string;
  division_id: string;
  state: "pending" | "ready" | "in_progress" | "final" | "corrected";
  home_entry_id: string | null;
  away_entry_id: string | null;
  home_control: "automatic" | "manual";
  away_control: "automatic" | "manual";
  operationally_locked: boolean;
};

type DependencyRow = {
  source_match_id: string;
  downstream_match_id: string;
  slot: "home" | "away";
  outcome: "winner" | "loser";
};

type OutcomeRow = {
  match_id: string;
  home_entry_id: string | null;
  away_entry_id: string | null;
  home_score: number | null;
  away_score: number | null;
};

type RepairCaseRow = {
  id: string;
  competition_id: string;
  corrected_division_id: string;
  corrected_match_id: string;
  correction_transaction_id: string;
  source_result_version: number;
  source_schedule_version: number;
  source_projection_version: number;
  analysis_fingerprint: string;
  analysis_fingerprint_input: string;
  created_by_account_id: string;
  created_at: Date | string;
};

type RepairRevisionRow = {
  id: string;
  repair_case_id: string;
  competition_id: string;
  revision: number;
  parent_revision_id: string | null;
  status: "draft" | "ready" | "published" | "abandoned";
  source_result_version: number;
  source_schedule_version: number;
  source_projection_version: number;
  analysis_fingerprint: string;
  publication_fingerprint: string | null;
  created_by_account_id: string;
  created_at: Date | string;
};

type RepairActionRow = {
  id: string;
  repair_revision_id: string;
  repair_case_id: string;
  competition_id: string;
  ordinal: number;
  match_id: string;
  division_id: string;
  slot: "home" | "away";
  source_action: GateCRepairActionRecord["source_action"];
  current_entry_id: string | null;
  proposed_entry_id: string | null;
  dependency_path: GateCRepairActionRecord["dependency_path"] | string;
  reason: string;
  created_at: Date | string;
  decision: GateCRepairActionRecord["decision"];
  selected_entry_id: string | null;
  decision_reason: string | null;
  current_entry_name: string | null;
  proposed_entry_name: string | null;
  selected_entry_name: string | null;
  match_code: string | null;
};

type AdjustmentRow = {
  match_id: string;
  division_id: string;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  playing_area_id: string | null;
  reason: string;
};

function persistedDependencyPath(path: AffectedMatchClosure["actions"][number]["dependencyPath"]): readonly {
  source_match_id: string;
  downstream_match_id: string;
  slot: "home" | "away";
  outcome: "winner" | "loser";
}[] {
  return path.map((step) => ({
    source_match_id: step.sourceMatchId,
    downstream_match_id: step.downstreamMatchId,
    slot: step.slot,
    outcome: step.outcome,
  }));
}

export type GateCC4PublicationResult = Readonly<{
  scheduleRevisionId: string;
  scheduleVersion: number;
  resultVersion: number;
  publishedAt: string;
  projections: readonly Readonly<{
    divisionId: string;
    publicProjectionVersionId: string;
    projectionVersion: number;
  }>[];
}>;

export type GateCC4PublicationPort = Readonly<{
  publish(
    tx: PostgresJsSql,
    input: Readonly<{
      actor: Phase3Actor;
      requestId: string;
      competitionId: string;
      repairCase: RepairCaseRow;
      repairRevision: RepairRevisionRow;
      plan: RepairPublicationPlan;
      adjustments: readonly GateCRepairScheduleAdjustment[];
      expectedScheduleVersion: number;
      expectedResultVersion: number;
    }>,
  ): Promise<GateCC4PublicationResult>;
}>;

function first<T>(rows: readonly T[], code: string, message: string): T {
  const row = rows[0];
  if (!row) throw new ApiError(404, code, message);
  return row;
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function json<T>(value: T | string): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Gate C C4 fingerprint input contains an unsupported value");
  return encoded;
}

function publicationFingerprint(
  plan: RepairPublicationPlan,
  adjustments: readonly GateCRepairScheduleAdjustment[],
): string {
  return hash(
    stableJson({
      schema_version: 1,
      plan: JSON.parse(plan.publicationFingerprintInput),
      schedule_adjustments: [...adjustments]
        .map((adjustment) => ({
          division_id: adjustment.division_id,
          ends_at: adjustment.ends_at ?? null,
          match_id: adjustment.match_id,
          playing_area_id: adjustment.playing_area_id ?? null,
          reason: adjustment.reason.trim(),
          starts_at: adjustment.starts_at ?? null,
        }))
        .sort((left, right) => left.match_id.localeCompare(right.match_id)),
    }),
  );
}

function decisionFingerprint(decision: {
  client_event_id: string;
  match_id: string;
  slot: string;
  decision: string;
  selected_entry_id?: string | null;
  reason: string;
}): string {
  return hash(
    stableJson({
      client_event_id: decision.client_event_id,
      decision: decision.decision,
      match_id: decision.match_id,
      reason: decision.reason.trim(),
      selected_entry_id: decision.selected_entry_id ?? null,
      slot: decision.slot,
    }),
  );
}

function validateAdjustment(
  adjustment: GateCRepairScheduleAdjustment,
  closure: AffectedMatchClosure,
): GateCRepairScheduleAdjustment {
  const affected = closure.actions.filter((action) => action.matchId === adjustment.match_id);
  if (affected.length === 0)
    throw new ApiError(422, "REPAIR_ADJUSTMENT_UNKNOWN_MATCH", "Adjustment match is not affected");
  if (affected.some((action) => ["protected_started_match", "protected_finalised_match"].includes(action.action))) {
    throw new ApiError(409, "REPAIR_ADJUSTMENT_PROTECTED", "Started or finalised matches cannot be rescheduled here");
  }
  if (affected.some((action) => action.divisionId !== adjustment.division_id)) {
    throw new ApiError(
      422,
      "REPAIR_ADJUSTMENT_DIVISION_MISMATCH",
      "Adjustment division does not match the affected match",
    );
  }
  if (adjustment.reason.trim().length < 3) {
    throw new ApiError(422, "REPAIR_ADJUSTMENT_REASON_REQUIRED", "Schedule adjustment requires a reason");
  }
  const hasStart = Boolean(adjustment.starts_at);
  const hasEnd = Boolean(adjustment.ends_at);
  if (hasStart !== hasEnd) {
    throw new ApiError(422, "REPAIR_ADJUSTMENT_TIME_PAIR_REQUIRED", "Start and end time must be changed together");
  }
  if (!hasStart && !adjustment.playing_area_id) {
    throw new ApiError(422, "REPAIR_ADJUSTMENT_EMPTY", "Schedule adjustment must change time or playing area");
  }
  if (hasStart && Date.parse(adjustment.ends_at!) <= Date.parse(adjustment.starts_at!)) {
    throw new ApiError(422, "REPAIR_ADJUSTMENT_TIME_INVALID", "Adjusted match must end after it starts");
  }
  return {
    ...adjustment,
    reason: adjustment.reason.trim(),
    ...(hasStart
      ? {
          starts_at: new Date(adjustment.starts_at!).toISOString(),
          ends_at: new Date(adjustment.ends_at!).toISOString(),
        }
      : { starts_at: null, ends_at: null }),
    playing_area_id: adjustment.playing_area_id ?? null,
  };
}

export class GateCC4Runtime {
  constructor(
    private readonly sql: PostgresJsSql,
    private readonly publicationPort?: GateCC4PublicationPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async transaction<T>(operation: (tx: PostgresJsSql) => Promise<T>): Promise<T> {
    if (!this.sql.begin) throw new Error("Gate C C4 mutations require a transaction-capable PostgreSQL client");
    return this.sql.begin(operation);
  }

  private async access(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    competitionId: string,
    mutable = true,
  ): Promise<AccessRow> {
    const row = first(
      await tx.unsafe<AccessRow>(
        `SELECT competition.id AS competition_id,competition.organisation_id,
                competition.status AS competition_status
         FROM competitions competition
         JOIN organisation_memberships membership
           ON membership.organisation_id=competition.organisation_id
         WHERE competition.id=$1 AND membership.account_id=$2 AND membership.status='active'
           AND membership.role IN ('owner','organiser')`,
        [competitionId, actor.accountId],
      ),
      "COMPETITION_ACCESS_DENIED",
      "Competition access denied",
    );
    if (mutable && row.competition_status === "archived") {
      throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
    }
    return row;
  }

  private async evidence(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    access: AccessRow,
    requestId: string,
    action: string,
    targetType: string,
    targetId: string,
    reason: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.unsafe(
      `INSERT INTO audit_events(
         occurred_at,request_id,actor_account_id,actor_type,organisation_id,
         action,target_type,target_id,reason,metadata
       ) VALUES($1,$2,$3,'account',$4,$5,$6,$7,$8,$9::jsonb)`,
      [this.now(), requestId, actor.accountId, access.organisation_id, action, targetType, targetId, reason, payload],
    );
    await tx.unsafe(
      `INSERT INTO outbox_events(
         aggregate_type,aggregate_id,event_type,payload,idempotency_key,created_at,available_at
       ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$6)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [targetType, targetId, action, payload, `gate-c-c4:${action}:${requestId}:${targetId}`, this.now()],
    );
  }

  private async loadAnalysis(
    tx: PostgresJsSql,
    competitionId: string,
    correctionTransactionId: string,
  ): Promise<{
    source: CorrectionSourceRow;
    closure: AffectedMatchClosure;
    analysisFingerprint: string;
  }> {
    const source = first(
      await tx.unsafe<CorrectionSourceRow>(
        `SELECT correction.id AS correction_id,correction.competition_id,correction.division_id,
                correction.match_id,correction.result_version,
                publication.result_version AS current_result_version,publication.schedule_version,
                COALESCE((SELECT max(projection.projection_version)
                  FROM public_projection_versions projection
                  WHERE projection.competition_id=correction.competition_id
                    AND projection.division_id=correction.division_id),0) AS source_projection_version,
                match.format_revision_id
         FROM score_correction_transactions correction
         JOIN competition_publications publication ON publication.competition_id=correction.competition_id
         JOIN matches match ON match.id=correction.match_id
         WHERE correction.id=$1 AND correction.competition_id=$2
         FOR UPDATE OF correction,publication`,
        [correctionTransactionId, competitionId],
      ),
      "CORRECTION_NOT_FOUND",
      "Correction transaction not found",
    );
    if (source.result_version !== source.current_result_version) {
      throw new ApiError(409, "REPAIR_SOURCE_STALE", "A newer result version exists; analyse the latest correction");
    }

    const matches = await tx.unsafe<MatchRow>(
      `SELECT match.id AS match_id,match.division_id,match.state,match.home_entry_id,match.away_entry_id,
              COALESCE(home_slot.control,'automatic') AS home_control,
              COALESCE(away_slot.control,'automatic') AS away_control,
              EXISTS(SELECT 1 FROM schedule_assignment_locks lock WHERE lock.match_id=match.id) AS operationally_locked
       FROM matches match
       LEFT JOIN advancement_slots home_slot ON home_slot.match_id=match.id AND home_slot.slot='home'
       LEFT JOIN advancement_slots away_slot ON away_slot.match_id=match.id AND away_slot.slot='away'
       WHERE match.format_revision_id=$1
       ORDER BY match.ordinal,match.id`,
      [source.format_revision_id],
    );
    const dependencies = await tx.unsafe<DependencyRow>(
      `SELECT source_match_id,match_id AS downstream_match_id,slot,outcome
       FROM match_dependencies WHERE format_revision_id=$1
       ORDER BY source_match_id,match_id,slot`,
      [source.format_revision_id],
    );
    const outcomes = await tx.unsafe<OutcomeRow>(
      `SELECT DISTINCT ON (match.id) match.id AS match_id,match.home_entry_id,match.away_entry_id,
              snapshot.home_score,snapshot.away_score
       FROM matches match
       LEFT JOIN match_result_snapshots snapshot
         ON snapshot.match_id=match.id AND snapshot.result_version<=$2
       WHERE match.format_revision_id=$1
       ORDER BY match.id,snapshot.result_version DESC NULLS LAST`,
      [source.format_revision_id, source.result_version],
    );

    const closure = calculateAffectedMatchClosure({
      competitionId,
      correctedMatchId: source.match_id,
      sourceResultVersion: source.result_version,
      sourceScheduleVersion: source.schedule_version,
      matches: matches.map((match) => ({
        matchId: match.match_id,
        divisionId: match.division_id,
        state: match.state,
        homeEntryId: match.home_entry_id,
        awayEntryId: match.away_entry_id,
        homeControl: match.home_control,
        awayControl: match.away_control,
        operationallyLocked: match.operationally_locked,
      })),
      dependencies: dependencies.map((dependency) => ({
        sourceMatchId: dependency.source_match_id,
        downstreamMatchId: dependency.downstream_match_id,
        slot: dependency.slot,
        outcome: dependency.outcome,
      })),
      proposedOutcomes: outcomes.map((outcome) => {
        const winnerEntryId =
          outcome.home_score === null || outcome.away_score === null || outcome.home_score === outcome.away_score
            ? null
            : outcome.home_score > outcome.away_score
              ? outcome.home_entry_id
              : outcome.away_entry_id;
        const loserEntryId =
          winnerEntryId === null
            ? null
            : winnerEntryId === outcome.home_entry_id
              ? outcome.away_entry_id
              : outcome.home_entry_id;
        return { matchId: outcome.match_id, winnerEntryId, loserEntryId };
      }),
    });
    return { source, closure, analysisFingerprint: hash(closure.analysisFingerprintInput) };
  }

  private async persistActionsAndDecisions(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    repairCase: RepairCaseRow,
    revision: RepairRevisionRow,
    closure: AffectedMatchClosure,
    plan: RepairPublicationPlan,
    decisionCommands: GateCRepairRevisionCreateRequest["decisions"],
  ): Promise<void> {
    const explicit = new Map(
      decisionCommands.map((decision) => [`${decision.match_id}\u0000${decision.slot}`, decision]),
    );
    const resolution = new Map(plan.resolutions.map((item) => [`${item.matchId}\u0000${item.slot}`, item]));

    for (const [index, action] of closure.actions.entries()) {
      const [inserted] = await tx.unsafe<{ id: string }>(
        `INSERT INTO schedule_repair_actions(
           repair_revision_id,repair_case_id,competition_id,ordinal,match_id,division_id,slot,
           source_action,current_entry_id,proposed_entry_id,dependency_path,reason
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         RETURNING id`,
        [
          revision.id,
          repairCase.id,
          repairCase.competition_id,
          index + 1,
          action.matchId,
          action.divisionId,
          action.slot,
          action.action,
          action.currentEntryId,
          action.proposedEntryId,
          persistedDependencyPath(action.dependencyPath),
          action.reason,
        ],
      );
      if (!inserted) throw new Error("Repair action was not persisted");
      const key = `${action.matchId}\u0000${action.slot}`;
      const resolved = resolution.get(key);
      if (!resolved) continue;
      const command = explicit.get(key);
      const clientEventId = command?.client_event_id ?? randomUUID();
      const persistedDecision = {
        client_event_id: clientEventId,
        match_id: action.matchId,
        slot: action.slot,
        decision: resolved.decision,
        selected_entry_id: resolved.decision === "set_manual_entry" ? resolved.resolvedEntryId : null,
        reason: resolved.reason,
      };
      await tx.unsafe(
        `INSERT INTO schedule_repair_decisions(
           repair_action_id,repair_revision_id,repair_case_id,competition_id,match_id,division_id,slot,
           decision,selected_entry_id,reason,client_event_id,request_fingerprint,decided_by_account_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          inserted.id,
          revision.id,
          repairCase.id,
          repairCase.competition_id,
          action.matchId,
          action.divisionId,
          action.slot,
          resolved.decision,
          persistedDecision.selected_entry_id,
          resolved.reason,
          clientEventId,
          decisionFingerprint(persistedDecision),
          actor.accountId,
        ],
      );
    }
  }

  private async persistAdjustments(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    repairCase: RepairCaseRow,
    revision: RepairRevisionRow,
    adjustments: readonly GateCRepairScheduleAdjustment[],
  ): Promise<void> {
    for (const adjustment of adjustments) {
      await tx.unsafe(
        `INSERT INTO schedule_repair_match_adjustments(
           repair_revision_id,repair_case_id,competition_id,match_id,division_id,
           playing_area_id,starts_at,ends_at,reason,decided_by_account_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          revision.id,
          repairCase.id,
          repairCase.competition_id,
          adjustment.match_id,
          adjustment.division_id,
          adjustment.playing_area_id ?? null,
          adjustment.starts_at ?? null,
          adjustment.ends_at ?? null,
          adjustment.reason,
          actor.accountId,
        ],
      );
    }
  }

  async analyseCorrection(
    actor: Phase3Actor,
    competitionId: string,
    correctionTransactionId: string,
    requestId: string,
  ): Promise<GateCRepairWorkspaceView> {
    const repairId = await this.transaction(async (tx) => {
      const access = await this.access(tx, actor, competitionId);
      const analysis = await this.loadAnalysis(tx, competitionId, correctionTransactionId);
      let repairCase = (
        await tx.unsafe<RepairCaseRow>(
          `SELECT * FROM schedule_repair_cases
           WHERE competition_id=$1 AND corrected_match_id=$2 AND source_result_version=$3
           FOR KEY SHARE`,
          [competitionId, analysis.source.match_id, analysis.source.result_version],
        )
      )[0];
      if (repairCase) {
        if (
          repairCase.analysis_fingerprint !== analysis.analysisFingerprint ||
          repairCase.analysis_fingerprint_input !== analysis.closure.analysisFingerprintInput
        ) {
          throw new ApiError(
            409,
            "REPAIR_ANALYSIS_MISMATCH",
            "Existing repair analysis differs from current source facts",
          );
        }
        return repairCase.id;
      }

      repairCase = first(
        await tx.unsafe<RepairCaseRow>(
          `INSERT INTO schedule_repair_cases(
             competition_id,corrected_division_id,corrected_match_id,correction_transaction_id,
             source_result_version,source_schedule_version,source_projection_version,
             analysis_fingerprint,analysis_fingerprint_input,created_by_account_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [
            competitionId,
            analysis.source.division_id,
            analysis.source.match_id,
            analysis.source.correction_id,
            analysis.source.result_version,
            analysis.source.schedule_version,
            analysis.source.source_projection_version,
            analysis.analysisFingerprint,
            analysis.closure.analysisFingerprintInput,
            actor.accountId,
          ],
        ),
        "REPAIR_CASE_CREATE_FAILED",
        "Repair case was not created",
      );
      const plan = buildRepairPublicationPlan(analysis.closure, []);
      const status = plan.ready ? "ready" : "draft";
      const publication = plan.ready ? publicationFingerprint(plan, []) : null;
      const revision = first(
        await tx.unsafe<RepairRevisionRow>(
          `SELECT * FROM gate_c_append_schedule_repair_revision($1,$2,$3,$4,NULL,$5,$6,$7)`,
          [
            repairCase.id,
            repairCase.source_result_version,
            repairCase.source_schedule_version,
            repairCase.analysis_fingerprint,
            status,
            publication,
            actor.accountId,
          ],
        ),
        "REPAIR_REVISION_CREATE_FAILED",
        "Initial repair revision was not created",
      );
      await this.persistActionsAndDecisions(tx, actor, repairCase, revision, analysis.closure, plan, []);
      await this.evidence(tx, actor, access, requestId, "repair.created", "schedule_repair_case", repairCase.id, null, {
        competition_id: competitionId,
        corrected_match_id: repairCase.corrected_match_id,
        result_version: repairCase.source_result_version,
        schedule_version: repairCase.source_schedule_version,
        affected_match_count: analysis.closure.actions.length,
      });
      return repairCase.id;
    });
    return this.readWorkspace(actor, competitionId, repairId);
  }

  async createRevision(
    actor: Phase3Actor,
    competitionId: string,
    repairId: string,
    request: GateCRepairRevisionCreateRequest,
    requestId: string,
  ): Promise<GateCRepairRevisionCreateResponse> {
    const revisionId = await this.transaction(async (tx) => {
      const access = await this.access(tx, actor, competitionId);
      const repairCase = first(
        await tx.unsafe<RepairCaseRow>(
          `SELECT * FROM schedule_repair_cases WHERE id=$1 AND competition_id=$2 FOR KEY SHARE`,
          [repairId, competitionId],
        ),
        "REPAIR_CASE_NOT_FOUND",
        "Repair case not found",
      );
      if (request.status === "abandoned") {
        throw new ApiError(422, "REPAIR_REVISION_STATUS_INVALID", "Use the abandon command for abandoned repairs");
      }
      if (
        request.expected_result_version !== repairCase.source_result_version ||
        request.expected_schedule_version !== repairCase.source_schedule_version ||
        request.expected_analysis_fingerprint !== repairCase.analysis_fingerprint
      ) {
        throw new ApiError(409, "REPAIR_SOURCE_STALE", "Repair revision source versions are stale");
      }
      const analysis = await this.loadAnalysis(tx, competitionId, repairCase.correction_transaction_id);
      if (
        analysis.analysisFingerprint !== repairCase.analysis_fingerprint ||
        analysis.closure.analysisFingerprintInput !== repairCase.analysis_fingerprint_input
      ) {
        throw new ApiError(409, "REPAIR_ANALYSIS_STALE", "Affected-match analysis changed; create a new repair case");
      }
      const plan = buildRepairPublicationPlan(
        analysis.closure,
        request.decisions.map<RepairPublicationDecision>((decision) => ({
          matchId: decision.match_id,
          slot: decision.slot,
          decision: decision.decision,
          ...(decision.selected_entry_id !== undefined ? { selectedEntryId: decision.selected_entry_id } : {}),
          reason: decision.reason,
        })),
      );
      const adjustmentKeys = new Set<string>();
      const adjustments = request.schedule_adjustments.map((adjustment) => {
        if (adjustmentKeys.has(adjustment.match_id)) {
          throw new ApiError(422, "REPAIR_ADJUSTMENT_DUPLICATE", "Only one schedule adjustment is allowed per match");
        }
        adjustmentKeys.add(adjustment.match_id);
        return validateAdjustment(adjustment, analysis.closure);
      });
      if (request.status === "ready" && !plan.ready) {
        throw new ApiError(409, "REPAIR_DECISIONS_INCOMPLETE", "Required organiser decisions are unresolved");
      }
      const fingerprint = request.status === "ready" ? publicationFingerprint(plan, adjustments) : null;
      const revision = first(
        await tx.unsafe<RepairRevisionRow>(
          `SELECT * FROM gate_c_append_schedule_repair_revision($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            repairCase.id,
            repairCase.source_result_version,
            repairCase.source_schedule_version,
            repairCase.analysis_fingerprint,
            request.parent_revision_id,
            request.status,
            fingerprint,
            actor.accountId,
          ],
        ),
        "REPAIR_REVISION_CREATE_FAILED",
        "Repair revision was not created",
      );
      await this.persistActionsAndDecisions(tx, actor, repairCase, revision, analysis.closure, plan, request.decisions);
      await this.persistAdjustments(tx, actor, repairCase, revision, adjustments);
      await this.evidence(
        tx,
        actor,
        access,
        requestId,
        "repair.revision_created",
        "schedule_repair_revision",
        revision.id,
        null,
        {
          competition_id: competitionId,
          repair_case_id: repairCase.id,
          revision: revision.revision,
          status: revision.status,
          unresolved_count: plan.unresolved.length,
        },
      );
      return revision.id;
    });

    const workspace = await this.readWorkspace(actor, competitionId, repairId);
    if (workspace.latest_revision?.repair_revision_id !== revisionId) {
      throw new ApiError(409, "REPAIR_REVISION_RACE", "A newer repair revision was created concurrently");
    }
    return {
      revision: workspace.latest_revision,
      actions: workspace.actions,
      unresolved_action_keys: workspace.unresolved_action_keys,
      publication_ready: workspace.publication_ready,
    };
  }

  async publishRevision(
    actor: Phase3Actor,
    request: GateCRepairPublicationRequest,
    requestId: string,
  ): Promise<GateCRepairPublicationReceipt> {
    const publicationPort = this.publicationPort;
    if (!publicationPort) throw new ApiError(503, "REPAIR_PUBLICATION_UNAVAILABLE", "Repair publisher is unavailable");
    return this.transaction(async (tx) => {
      const access = await this.access(tx, actor, request.competition_id);
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended('gate-c:repair-publication:'||$1,0))`, [
        request.competition_id,
      ]);
      const requestFingerprint = hash(stableJson(request));
      const duplicate = (
        await tx.unsafe<{
          request_fingerprint: string;
          response: GateCRepairPublicationReceipt | string;
        }>(
          `SELECT request_fingerprint,response FROM schedule_repair_publication_receipts
           WHERE competition_id=$1 AND idempotency_key=$2`,
          [request.competition_id, request.publication_idempotency_key],
        )
      )[0];
      if (duplicate) {
        if (duplicate.request_fingerprint !== requestFingerprint) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "Publication key was reused with different content");
        }
        return { ...json<GateCRepairPublicationReceipt>(duplicate.response), duplicate: true };
      }
      const repairCase = first(
        await tx.unsafe<RepairCaseRow>(
          `SELECT * FROM schedule_repair_cases WHERE id=$1 AND competition_id=$2 FOR KEY SHARE`,
          [request.repair_id, request.competition_id],
        ),
        "REPAIR_CASE_NOT_FOUND",
        "Repair case not found",
      );
      const revision = first(
        await tx.unsafe<RepairRevisionRow>(
          `SELECT * FROM schedule_repair_revisions
           WHERE id=$1 AND repair_case_id=$2 AND competition_id=$3 FOR KEY SHARE`,
          [request.repair_revision_id, repairCase.id, request.competition_id],
        ),
        "REPAIR_REVISION_NOT_FOUND",
        "Repair revision not found",
      );
      if (revision.status !== "ready" || !revision.publication_fingerprint) {
        throw new ApiError(409, "REPAIR_REVISION_NOT_READY", "Repair revision is not ready to publish");
      }
      if (
        request.expected_result_version !== repairCase.source_result_version ||
        request.expected_schedule_version !== repairCase.source_schedule_version ||
        request.expected_analysis_fingerprint !== repairCase.analysis_fingerprint
      ) {
        throw new ApiError(409, "REPAIR_SOURCE_STALE", "Repair publication source versions are stale");
      }
      const publication = first(
        await tx.unsafe<{ schedule_version: number; result_version: number }>(
          `SELECT schedule_version,result_version FROM competition_publications
           WHERE competition_id=$1 FOR UPDATE`,
          [request.competition_id],
        ),
        "PUBLICATION_NOT_FOUND",
        "Competition publication state not found",
      );
      if (
        publication.schedule_version !== request.expected_schedule_version ||
        publication.result_version !== request.expected_result_version
      ) {
        throw new ApiError(409, "REPAIR_PUBLICATION_STALE", "Public result or schedule version changed");
      }
      const analysis = await this.loadAnalysis(tx, request.competition_id, repairCase.correction_transaction_id);
      if (analysis.analysisFingerprint !== revision.analysis_fingerprint) {
        throw new ApiError(409, "REPAIR_ANALYSIS_STALE", "Affected-match analysis changed before publication");
      }
      const persisted = await tx.unsafe<{
        match_id: string;
        slot: "home" | "away";
        source_action: GateCRepairActionRecord["source_action"];
        decision: RepairPublicationDecision["decision"];
        selected_entry_id: string | null;
        reason: string;
      }>(
        `SELECT action.match_id,action.slot,action.source_action,decision.decision,decision.selected_entry_id,decision.reason
         FROM schedule_repair_actions action
         JOIN schedule_repair_decisions decision ON decision.repair_action_id=action.id
         WHERE action.repair_revision_id=$1
         ORDER BY action.ordinal`,
        [revision.id],
      );
      const plan = buildRepairPublicationPlan(
        analysis.closure,
        persisted
          .filter((decision) => decision.source_action !== "no_change")
          .map((decision) => ({
            matchId: decision.match_id,
            slot: decision.slot,
            decision: decision.decision,
            ...(decision.selected_entry_id !== null ? { selectedEntryId: decision.selected_entry_id } : {}),
            reason: decision.reason,
          })),
      );
      if (!plan.ready) throw new ApiError(409, "REPAIR_DECISIONS_INCOMPLETE", "Required decisions remain unresolved");
      const adjustments = (
        await tx.unsafe<AdjustmentRow>(
          `SELECT match_id,division_id,starts_at,ends_at,playing_area_id,reason
           FROM schedule_repair_match_adjustments WHERE repair_revision_id=$1 ORDER BY match_id`,
          [revision.id],
        )
      ).map((adjustment) => ({
        match_id: adjustment.match_id,
        division_id: adjustment.division_id,
        starts_at: adjustment.starts_at ? instant(adjustment.starts_at) : null,
        ends_at: adjustment.ends_at ? instant(adjustment.ends_at) : null,
        playing_area_id: adjustment.playing_area_id,
        reason: adjustment.reason,
      }));
      if (publicationFingerprint(plan, adjustments) !== revision.publication_fingerprint) {
        throw new ApiError(409, "REPAIR_PUBLICATION_FINGERPRINT_MISMATCH", "Retained repair decisions changed");
      }
      const result = await publicationPort.publish(tx, {
        actor,
        requestId,
        competitionId: request.competition_id,
        repairCase,
        repairRevision: revision,
        plan,
        adjustments,
        expectedScheduleVersion: request.expected_schedule_version,
        expectedResultVersion: request.expected_result_version,
      });
      const receipt: GateCRepairPublicationReceipt = {
        competition_id: request.competition_id,
        repair_id: repairCase.id,
        repair_revision_id: revision.id,
        schedule_version: result.scheduleVersion,
        result_version: result.resultVersion,
        projection_version: Math.max(...result.projections.map((projection) => projection.projectionVersion)),
        schedule_revision_id: result.scheduleRevisionId,
        analysis_fingerprint: revision.analysis_fingerprint,
        duplicate: false,
        published_at: result.publishedAt,
      };
      const [stored] = await tx.unsafe<{ id: string }>(
        `INSERT INTO schedule_repair_publication_receipts(
           competition_id,repair_case_id,repair_revision_id,request_fingerprint,idempotency_key,
           schedule_revision_id,schedule_version,result_version,analysis_fingerprint,response,published_by_account_id,
           published_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
         RETURNING id`,
        [
          request.competition_id,
          repairCase.id,
          revision.id,
          requestFingerprint,
          request.publication_idempotency_key,
          result.scheduleRevisionId,
          result.scheduleVersion,
          result.resultVersion,
          revision.analysis_fingerprint,
          receipt,
          actor.accountId,
          result.publishedAt,
        ],
      );
      if (!stored) throw new Error("Repair publication receipt was not retained");
      for (const projection of result.projections) {
        await tx.unsafe(
          `INSERT INTO schedule_repair_publication_projection_versions(
             publication_receipt_id,competition_id,division_id,public_projection_version_id
           ) VALUES($1,$2,$3,$4)`,
          [stored.id, request.competition_id, projection.divisionId, projection.publicProjectionVersionId],
        );
      }
      await this.evidence(
        tx,
        actor,
        access,
        requestId,
        "repair.published",
        "schedule_repair_publication_receipt",
        stored.id,
        null,
        {
          competition_id: request.competition_id,
          repair_case_id: repairCase.id,
          repair_revision_id: revision.id,
          schedule_version: result.scheduleVersion,
          result_version: result.resultVersion,
        },
      );
      await tx.unsafe(
        `INSERT INTO outbox_events(
           aggregate_type,aggregate_id,event_type,payload,idempotency_key,created_at,available_at
         ) VALUES('competition',$1,'public_projection.published',$2::jsonb,$3,$4,$4)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          request.competition_id,
          {
            competition_id: request.competition_id,
            projection: "schedule",
            previous_published_version: publication.schedule_version,
            published_version: result.scheduleVersion,
            publication_state: "published",
            correlation_id: `edge-purge:${request.competition_id}:schedule:${String(publication.schedule_version)}`,
          },
          `edge-purge:${request.competition_id}:schedule:${String(publication.schedule_version)}`,
          this.now(),
        ],
      );
      return receipt;
    });
  }

  async readWorkspace(actor: Phase3Actor, competitionId: string, repairId: string): Promise<GateCRepairWorkspaceView> {
    await this.access(this.sql, actor, competitionId, false);
    const repairCase = first(
      await this.sql.unsafe<RepairCaseRow>(`SELECT * FROM schedule_repair_cases WHERE id=$1 AND competition_id=$2`, [
        repairId,
        competitionId,
      ]),
      "REPAIR_CASE_NOT_FOUND",
      "Repair case not found",
    );
    const revision = (
      await this.sql.unsafe<RepairRevisionRow>(
        `SELECT * FROM schedule_repair_revisions WHERE repair_case_id=$1 ORDER BY revision DESC LIMIT 1`,
        [repairCase.id],
      )
    )[0];
    const actionRows = revision
      ? await this.sql.unsafe<RepairActionRow>(
          `SELECT action.*,decision.decision,decision.selected_entry_id,decision.reason AS decision_reason,
                  current_entry.name AS current_entry_name,proposed_entry.name AS proposed_entry_name,
                  selected_entry.name AS selected_entry_name,match.code AS match_code
           FROM schedule_repair_actions action
           LEFT JOIN schedule_repair_decisions decision ON decision.repair_action_id=action.id
           LEFT JOIN division_entries current_entry ON current_entry.id=action.current_entry_id
           LEFT JOIN division_entries proposed_entry ON proposed_entry.id=action.proposed_entry_id
           LEFT JOIN division_entries selected_entry ON selected_entry.id=decision.selected_entry_id
           LEFT JOIN matches match ON match.id=action.match_id
             AND match.competition_id=action.competition_id AND match.division_id=action.division_id
           WHERE action.repair_revision_id=$1 ORDER BY action.ordinal`,
          [revision.id],
        )
      : [];
    const adjustments = revision
      ? await this.sql.unsafe<AdjustmentRow>(
          `SELECT match_id,division_id,starts_at,ends_at,playing_area_id,reason
           FROM schedule_repair_match_adjustments WHERE repair_revision_id=$1 ORDER BY match_id`,
          [revision.id],
        )
      : [];
    const adjustmentByMatch = new Map(adjustments.map((adjustment) => [adjustment.match_id, adjustment]));
    const actions: GateCRepairActionView[] = actionRows.map((action) => {
      const resolvedEntryId =
        action.decision === "accept_proposed"
          ? action.proposed_entry_id
          : action.decision === "set_manual_entry"
            ? action.selected_entry_id
            : action.decision
              ? action.current_entry_id
              : null;
      const adjustment = adjustmentByMatch.get(action.match_id);
      return {
        repair_action_id: action.id,
        repair_revision_id: action.repair_revision_id,
        ordinal: action.ordinal,
        match_id: action.match_id,
        division_id: action.division_id,
        slot: action.slot,
        source_action: action.source_action,
        decision: action.decision,
        current_entry_id: action.current_entry_id,
        proposed_entry_id: action.proposed_entry_id,
        resolved_entry_id: resolvedEntryId,
        reason: action.decision_reason ?? action.reason,
        dependency_path: json(action.dependency_path),
        created_at: instant(action.created_at),
        match_code: action.match_code,
        current_entry_name: action.current_entry_name,
        proposed_entry_name: action.proposed_entry_name,
        resolved_entry_name:
          action.decision === "accept_proposed"
            ? action.proposed_entry_name
            : action.decision === "set_manual_entry"
              ? action.selected_entry_name
              : action.decision
                ? action.current_entry_name
                : null,
        adjustment: adjustment
          ? {
              match_id: adjustment.match_id,
              division_id: adjustment.division_id,
              starts_at: adjustment.starts_at ? instant(adjustment.starts_at) : null,
              ends_at: adjustment.ends_at ? instant(adjustment.ends_at) : null,
              playing_area_id: adjustment.playing_area_id,
              reason: adjustment.reason,
            }
          : null,
      };
    });
    const unresolved = actions
      .filter((action) => action.decision === null && !["no_change", "automatic_update"].includes(action.source_action))
      .map((action) => `${action.match_id}:${action.slot}`);
    const publication = first(
      await this.sql.unsafe<{ schedule_version: number; result_version: number }>(
        `SELECT schedule_version,result_version FROM competition_publications WHERE competition_id=$1`,
        [competitionId],
      ),
      "PUBLICATION_NOT_FOUND",
      "Competition publication state not found",
    );
    const projectionRows = await this.sql.unsafe<{ division_id: string; projection_version: number }>(
      `SELECT division_id,max(projection_version)::integer AS projection_version
       FROM public_projection_versions WHERE competition_id=$1 GROUP BY division_id ORDER BY division_id`,
      [competitionId],
    );
    const audit = await this.sql.unsafe<{
      occurred_at: Date | string;
      actor_account_id: string | null;
      action: string;
      target_type: string;
      target_id: string;
      reason: string | null;
    }>(
      `SELECT occurred_at,actor_account_id,action,target_type,target_id,reason
       FROM audit_events
       WHERE organisation_id=(SELECT organisation_id FROM competitions WHERE id=$1)
         AND (target_id=$2 OR metadata->>'repair_case_id'=$2)
       ORDER BY occurred_at,target_id`,
      [competitionId, repairCase.id],
    );
    const affectedDivisionIds = [...new Set(actions.map((action) => action.division_id))].sort();
    const latestStatus = revision?.status;
    const receiptExists = Boolean(
      (
        await this.sql.unsafe<{ present: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM schedule_repair_publication_receipts WHERE repair_case_id=$1) AS present`,
          [repairCase.id],
        )
      )[0]?.present,
    );
    const caseStatus = receiptExists
      ? "published"
      : latestStatus === "abandoned"
        ? "abandoned"
        : revision
          ? "drafted"
          : "open";
    const latestRevision: GateCRepairRevisionView | null = revision
      ? {
          repair_revision_id: revision.id,
          repair_id: repairCase.id,
          revision: revision.revision,
          status: revision.status,
          source_result_version: revision.source_result_version,
          source_schedule_version: revision.source_schedule_version,
          analysis_fingerprint: revision.analysis_fingerprint,
          analysis_fingerprint_input: repairCase.analysis_fingerprint_input,
          created_at: instant(revision.created_at),
          created_by_account_id: revision.created_by_account_id,
        }
      : null;
    return {
      repair: {
        repair_id: repairCase.id,
        competition_id: repairCase.competition_id,
        corrected_match_id: repairCase.corrected_match_id,
        source_result_version: repairCase.source_result_version,
        source_schedule_version: repairCase.source_schedule_version,
        status: caseStatus,
        analysis: {
          schema_version: 1,
          competition_id: repairCase.competition_id,
          corrected_match_id: repairCase.corrected_match_id,
          source_result_version: repairCase.source_result_version,
          source_schedule_version: repairCase.source_schedule_version,
          affected_division_ids: affectedDivisionIds,
          actions: actions.map((action) => ({
            match_id: action.match_id,
            division_id: action.division_id,
            slot: action.slot,
            current_entry_id: action.current_entry_id,
            proposed_entry_id: action.proposed_entry_id,
            match_state:
              action.source_action === "protected_started_match"
                ? "in_progress"
                : action.source_action === "protected_finalised_match"
                  ? "final"
                  : "pending",
            control: action.source_action === "protected_manual_slot" ? "manual" : "automatic",
            action: action.source_action,
            reason: action.reason,
            dependency_path: action.dependency_path,
          })),
          analysis_fingerprint_input: repairCase.analysis_fingerprint_input,
        },
        created_at: instant(repairCase.created_at),
        created_by_account_id: repairCase.created_by_account_id,
      },
      latest_revision: latestRevision,
      actions,
      unresolved_action_keys: unresolved,
      publication_ready: Boolean(revision?.status === "ready" && unresolved.length === 0),
      current_result_version: publication.result_version,
      published_schedule_version: publication.schedule_version,
      public_projection_versions: Object.fromEntries(
        projectionRows.map((projection) => [projection.division_id, projection.projection_version]),
      ),
      audit: audit.map((entry) => ({ ...entry, occurred_at: instant(entry.occurred_at) })),
    };
  }
}
