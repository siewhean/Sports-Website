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
import { ApiError, ErrorCode } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import {
  RepairRepository,
  CompetitionRepository,
  PublicationRepository,
  PublicProjectionRepository,
  type RepairCaseRecord,
  type RepairRevisionRecord,
  type CorrectionSourceRecord,
} from "./repositories/index.js";

type AccessRow = {
  competition_id: string;
  organisation_id: string;
  competition_status: string;
};

type RepairCaseRow = RepairCaseRecord;
type RepairRevisionRow = RepairRevisionRecord;
type CorrectionSourceRow = CorrectionSourceRecord;

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
    throw new ApiError(422, ErrorCode.REPAIR_ADJUSTMENT_UNKNOWN_MATCH, "Adjustment match is not affected");
  if (affected.some((action) => ["protected_started_match", "protected_finalised_match"].includes(action.action))) {
    throw new ApiError(
      409,
      ErrorCode.REPAIR_ADJUSTMENT_PROTECTED,
      "Started or finalised matches cannot be rescheduled here",
    );
  }
  if (affected.some((action) => action.divisionId !== adjustment.division_id)) {
    throw new ApiError(
      422,
      ErrorCode.REPAIR_ADJUSTMENT_DIVISION_MISMATCH,
      "Adjustment division does not match the affected match",
    );
  }
  if (adjustment.reason.trim().length < 3) {
    throw new ApiError(422, ErrorCode.REPAIR_ADJUSTMENT_REASON_REQUIRED, "Schedule adjustment requires a reason");
  }
  const hasStart = Boolean(adjustment.starts_at);
  const hasEnd = Boolean(adjustment.ends_at);
  if (hasStart !== hasEnd) {
    throw new ApiError(
      422,
      ErrorCode.REPAIR_ADJUSTMENT_TIME_PAIR_REQUIRED,
      "Start and end time must be changed together",
    );
  }
  if (!hasStart && !adjustment.playing_area_id) {
    throw new ApiError(422, ErrorCode.REPAIR_ADJUSTMENT_EMPTY, "Schedule adjustment must change time or playing area");
  }
  if (hasStart && Date.parse(adjustment.ends_at!) <= Date.parse(adjustment.starts_at!)) {
    throw new ApiError(422, ErrorCode.REPAIR_ADJUSTMENT_TIME_INVALID, "Adjusted match must end after it starts");
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
  private readonly repairRepo: RepairRepository;
  private readonly competitionRepo: CompetitionRepository;
  private readonly publicationRepo: PublicationRepository;
  private readonly publicProjectionRepo: PublicProjectionRepository;

  constructor(
    private readonly sql: PostgresJsSql,
    private readonly publicationPort?: GateCC4PublicationPort,
    private readonly now: () => Date = () => new Date(),
    repairRepo?: RepairRepository,
    competitionRepo?: CompetitionRepository,
    publicationRepo?: PublicationRepository,
    publicProjectionRepo?: PublicProjectionRepository,
  ) {
    this.repairRepo = repairRepo ?? new RepairRepository(sql);
    this.competitionRepo = competitionRepo ?? new CompetitionRepository(sql);
    this.publicationRepo = publicationRepo ?? new PublicationRepository(sql);
    this.publicProjectionRepo = publicProjectionRepo ?? new PublicProjectionRepository(sql);
  }

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
    const access = await this.competitionRepo.findCompetitionAccess(
      competitionId,
      actor.accountId,
      ["owner", "organiser"],
      tx,
    );
    if (!access) {
      throw new ApiError(404, ErrorCode.COMPETITION_ACCESS_DENIED, "Competition access denied");
    }
    if (mutable && access.competition_status === "archived") {
      throw new ApiError(409, ErrorCode.COMPETITION_ARCHIVED, "Archived competitions are immutable");
    }
    return access;
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
    await this.repairRepo.insertAuditEvent(
      {
        occurredAt: this.now(),
        requestId,
        actorAccountId: actor.accountId,
        organisationId: access.organisation_id,
        action,
        targetType,
        targetId,
        reason,
        metadata: payload,
      },
      tx,
    );
    await this.repairRepo.insertOutboxEvent(
      {
        aggregateType: targetType,
        aggregateId: targetId,
        eventType: action,
        payload,
        idempotencyKey: `gate-c-c4:${action}:${requestId}:${targetId}`,
        createdAt: this.now(),
      },
      tx,
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
    const source = await this.repairRepo.findSourceCorrection(correctionTransactionId, competitionId, tx);
    if (!source) {
      throw new ApiError(404, ErrorCode.CORRECTION_NOT_FOUND, "Correction transaction not found");
    }
    if (source.result_version !== source.current_result_version) {
      throw new ApiError(
        409,
        ErrorCode.REPAIR_SOURCE_STALE,
        "A newer result version exists; analyse the latest correction",
      );
    }

    const matches = await this.repairRepo.findMatchesForAnalysis(source.format_revision_id, tx);
    const dependencies = await this.repairRepo.findDependenciesForAnalysis(source.format_revision_id, tx);
    const outcomes = await this.repairRepo.findOutcomesForAnalysis(
      source.format_revision_id,
      source.result_version,
      tx,
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
      const inserted = await this.repairRepo.insertAction(
        {
          repairRevisionId: revision.id,
          repairCaseId: repairCase.id,
          competitionId: repairCase.competition_id,
          ordinal: index + 1,
          matchId: action.matchId,
          divisionId: action.divisionId,
          slot: action.slot,
          sourceAction: action.action,
          currentEntryId: action.currentEntryId,
          proposedEntryId: action.proposedEntryId,
          dependencyPath: persistedDependencyPath(action.dependencyPath),
          reason: action.reason,
        },
        tx,
      );
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
      await this.repairRepo.insertDecision(
        {
          repairActionId: inserted.id,
          repairRevisionId: revision.id,
          repairCaseId: repairCase.id,
          competitionId: repairCase.competition_id,
          matchId: action.matchId,
          divisionId: action.divisionId,
          slot: action.slot,
          decision: resolved.decision,
          selectedEntryId: persistedDecision.selected_entry_id,
          reason: resolved.reason,
          clientEventId,
          requestFingerprint: decisionFingerprint(persistedDecision),
          decidedByAccountId: actor.accountId,
        },
        tx,
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
      await this.repairRepo.insertAdjustment(
        {
          repairRevisionId: revision.id,
          repairCaseId: repairCase.id,
          competitionId: repairCase.competition_id,
          matchId: adjustment.match_id,
          divisionId: adjustment.division_id,
          playingAreaId: adjustment.playing_area_id ?? null,
          startsAt: adjustment.starts_at ?? null,
          endsAt: adjustment.ends_at ?? null,
          reason: adjustment.reason,
          decidedByAccountId: actor.accountId,
        },
        tx,
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
      let repairCase = await this.repairRepo.findCaseByMatchAndResultVersion(
        competitionId,
        analysis.source.match_id,
        analysis.source.result_version,
        "for_share",
        tx,
      );
      if (repairCase) {
        if (
          repairCase.analysis_fingerprint !== analysis.analysisFingerprint ||
          repairCase.analysis_fingerprint_input !== analysis.closure.analysisFingerprintInput
        ) {
          throw new ApiError(
            409,
            ErrorCode.REPAIR_ANALYSIS_MISMATCH,
            "Existing repair analysis differs from current source facts",
          );
        }
        return repairCase.id;
      }

      repairCase = await this.repairRepo.createCase(
        {
          competitionId,
          correctedDivisionId: analysis.source.division_id,
          correctedMatchId: analysis.source.match_id,
          correctionTransactionId: analysis.source.correction_id,
          sourceResultVersion: analysis.source.result_version,
          sourceScheduleVersion: analysis.source.schedule_version,
          sourceProjectionVersion: analysis.source.source_projection_version,
          analysisFingerprint: analysis.analysisFingerprint,
          analysisFingerprintInput: analysis.closure.analysisFingerprintInput,
          createdByAccountId: actor.accountId,
        },
        tx,
      );
      const plan = buildRepairPublicationPlan(analysis.closure, []);
      const status = plan.ready ? "ready" : "draft";
      const publication = plan.ready ? publicationFingerprint(plan, []) : null;
      const revision = await this.repairRepo.appendRevision(
        {
          repairCaseId: repairCase.id,
          expectedSourceResultVersion: repairCase.source_result_version,
          expectedSourceScheduleVersion: repairCase.source_schedule_version,
          expectedAnalysisFingerprint: repairCase.analysis_fingerprint,
          parentRevisionId: null,
          nextStatus: status,
          nextPublicationFingerprint: publication,
          actorAccountId: actor.accountId,
        },
        tx,
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
      const repairCase = await this.repairRepo.findCaseById(repairId, competitionId, "for_share", tx);
      if (!repairCase) {
        throw new ApiError(404, ErrorCode.REPAIR_CASE_NOT_FOUND, "Repair case not found");
      }
      if (request.status === "abandoned") {
        throw new ApiError(
          422,
          ErrorCode.REPAIR_REVISION_STATUS_INVALID,
          "Use the abandon command for abandoned repairs",
        );
      }
      if (
        request.expected_result_version !== repairCase.source_result_version ||
        request.expected_schedule_version !== repairCase.source_schedule_version ||
        request.expected_analysis_fingerprint !== repairCase.analysis_fingerprint
      ) {
        throw new ApiError(409, ErrorCode.REPAIR_SOURCE_STALE, "Repair revision source versions are stale");
      }
      const analysis = await this.loadAnalysis(tx, competitionId, repairCase.correction_transaction_id);
      if (
        analysis.analysisFingerprint !== repairCase.analysis_fingerprint ||
        analysis.closure.analysisFingerprintInput !== repairCase.analysis_fingerprint_input
      ) {
        throw new ApiError(
          409,
          ErrorCode.REPAIR_ANALYSIS_STALE,
          "Affected-match analysis changed; create a new repair case",
        );
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
          throw new ApiError(
            422,
            ErrorCode.REPAIR_ADJUSTMENT_DUPLICATE,
            "Only one schedule adjustment is allowed per match",
          );
        }
        adjustmentKeys.add(adjustment.match_id);
        return validateAdjustment(adjustment, analysis.closure);
      });
      if (request.status === "ready" && !plan.ready) {
        throw new ApiError(409, ErrorCode.REPAIR_DECISIONS_INCOMPLETE, "Required organiser decisions are unresolved");
      }
      const fingerprint = request.status === "ready" ? publicationFingerprint(plan, adjustments) : null;
      const revision = await this.repairRepo.appendRevision(
        {
          repairCaseId: repairCase.id,
          expectedSourceResultVersion: repairCase.source_result_version,
          expectedSourceScheduleVersion: repairCase.source_schedule_version,
          expectedAnalysisFingerprint: repairCase.analysis_fingerprint,
          parentRevisionId: request.parent_revision_id,
          nextStatus: request.status,
          nextPublicationFingerprint: fingerprint,
          actorAccountId: actor.accountId,
        },
        tx,
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
      throw new ApiError(409, ErrorCode.REPAIR_REVISION_RACE, "A newer repair revision was created concurrently");
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
    if (!publicationPort)
      throw new ApiError(503, ErrorCode.REPAIR_PUBLICATION_UNAVAILABLE, "Repair publisher is unavailable");
    return this.transaction(async (tx) => {
      const access = await this.access(tx, actor, request.competition_id);
      // Acquire PostgreSQL advisory transaction lock (pg_advisory_xact_lock with key 'gate-c:repair-publication:' + competition_id)
      await this.repairRepo.acquirePublicationLock(request.competition_id, tx);
      const requestFingerprint = hash(stableJson(request));
      const duplicate = await this.repairRepo.findPublicationReceiptByIdempotencyKey(
        request.competition_id,
        request.publication_idempotency_key,
        tx,
      );
      if (duplicate) {
        if (duplicate.request_fingerprint !== requestFingerprint) {
          throw new ApiError(
            409,
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            "Publication key was reused with different content",
          );
        }
        return {
          ...json<GateCRepairPublicationReceipt>(duplicate.response as string | GateCRepairPublicationReceipt),
          duplicate: true,
        };
      }
      const repairCase = await this.repairRepo.findCaseById(request.repair_id, request.competition_id, "for_share", tx);
      if (!repairCase) {
        throw new ApiError(404, ErrorCode.REPAIR_CASE_NOT_FOUND, "Repair case not found");
      }
      const revision = await this.repairRepo.findRevisionById(
        request.repair_revision_id,
        repairCase.id,
        request.competition_id,
        "for_share",
        tx,
      );
      if (!revision) {
        throw new ApiError(404, ErrorCode.REPAIR_REVISION_NOT_FOUND, "Repair revision not found");
      }
      if (revision.status !== "ready" || !revision.publication_fingerprint) {
        throw new ApiError(409, ErrorCode.REPAIR_REVISION_NOT_READY, "Repair revision is not ready to publish");
      }
      if (
        request.expected_result_version !== repairCase.source_result_version ||
        request.expected_schedule_version !== repairCase.source_schedule_version ||
        request.expected_analysis_fingerprint !== repairCase.analysis_fingerprint
      ) {
        throw new ApiError(409, ErrorCode.REPAIR_SOURCE_STALE, "Repair publication source versions are stale");
      }
      const publication = await this.publicationRepo.getVersions(request.competition_id, "for_update", tx);
      if (!publication) {
        throw new ApiError(404, ErrorCode.PUBLICATION_NOT_FOUND, "Competition publication state not found");
      }
      if (
        publication.schedule_version !== request.expected_schedule_version ||
        publication.result_version !== request.expected_result_version
      ) {
        throw new ApiError(409, ErrorCode.REPAIR_PUBLICATION_STALE, "Public result or schedule version changed");
      }
      const analysis = await this.loadAnalysis(tx, request.competition_id, repairCase.correction_transaction_id);
      if (analysis.analysisFingerprint !== revision.analysis_fingerprint) {
        throw new ApiError(409, ErrorCode.REPAIR_ANALYSIS_STALE, "Affected-match analysis changed before publication");
      }
      const persisted = await this.repairRepo.findPersistedActionsAndDecisions(revision.id, tx);
      const plan = buildRepairPublicationPlan(
        analysis.closure,
        persisted
          .filter(
            (
              decision,
            ): decision is typeof decision & {
              decision: Exclude<GateCRepairActionRecord["decision"], null>;
            } => decision.source_action !== "no_change" && decision.decision !== null,
          )
          .map((decision) => ({
            matchId: decision.match_id,
            slot: decision.slot,
            decision: decision.decision,
            ...(decision.selected_entry_id !== null ? { selectedEntryId: decision.selected_entry_id } : {}),
            reason: decision.reason,
          })),
      );
      if (!plan.ready)
        throw new ApiError(409, ErrorCode.REPAIR_DECISIONS_INCOMPLETE, "Required decisions remain unresolved");
      const adjustments = (await this.repairRepo.findAdjustmentsByRevisionId(revision.id, tx)).map((adjustment) => ({
        match_id: adjustment.match_id,
        division_id: adjustment.division_id,
        starts_at: adjustment.starts_at ? instant(adjustment.starts_at) : null,
        ends_at: adjustment.ends_at ? instant(adjustment.ends_at) : null,
        playing_area_id: adjustment.playing_area_id,
        reason: adjustment.reason,
      }));
      if (publicationFingerprint(plan, adjustments) !== revision.publication_fingerprint) {
        throw new ApiError(409, ErrorCode.REPAIR_PUBLICATION_FINGERPRINT_MISMATCH, "Retained repair decisions changed");
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
      const stored = await this.repairRepo.insertPublicationReceipt(
        {
          competitionId: request.competition_id,
          repairCaseId: repairCase.id,
          repairRevisionId: revision.id,
          requestFingerprint,
          idempotencyKey: request.publication_idempotency_key,
          scheduleRevisionId: result.scheduleRevisionId,
          scheduleVersion: result.scheduleVersion,
          resultVersion: result.resultVersion,
          analysisFingerprint: revision.analysis_fingerprint,
          response: receipt,
          publishedByAccountId: actor.accountId,
          publishedAt: result.publishedAt,
        },
        tx,
      );
      for (const projection of result.projections) {
        await this.repairRepo.insertPublicationProjectionVersions(
          {
            publicationReceiptId: stored.id,
            competitionId: request.competition_id,
            divisionId: projection.divisionId,
            publicProjectionVersionId: projection.publicProjectionVersionId,
          },
          tx,
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
      return receipt;
    });
  }

  async readWorkspace(actor: Phase3Actor, competitionId: string, repairId: string): Promise<GateCRepairWorkspaceView> {
    await this.access(this.sql, actor, competitionId, false);
    const repairCase = await this.repairRepo.findCaseById(repairId, competitionId, "none", this.sql);
    if (!repairCase) {
      throw new ApiError(404, ErrorCode.REPAIR_CASE_NOT_FOUND, "Repair case not found");
    }
    const revision = await this.repairRepo.findLatestRevision(repairCase.id, undefined, "none", this.sql);
    const actionRows = revision ? await this.repairRepo.findActionsByRevisionId(revision.id, undefined, this.sql) : [];
    const adjustments = revision ? await this.repairRepo.findAdjustmentsByRevisionId(revision.id, this.sql) : [];
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
    const publication = await this.publicationRepo.getVersions(competitionId, "none", this.sql);
    if (!publication) {
      throw new ApiError(404, ErrorCode.PUBLICATION_NOT_FOUND, "Competition publication state not found");
    }
    const projectionRows = await this.publicProjectionRepo.findLatestProjectionVersionsByCompetitionId(
      competitionId,
      this.sql,
    );
    const audit = await this.repairRepo.findAuditEventsForRepair(competitionId, repairCase.id, this.sql);
    const affectedDivisionIds = [...new Set(actions.map((action) => action.division_id))].sort();
    const latestStatus = revision?.status;
    const receiptExists = await this.repairRepo.hasPublicationReceipt(repairCase.id, this.sql);
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
