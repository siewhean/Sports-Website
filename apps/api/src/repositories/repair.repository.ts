import type { LockMode, SqlExecutor } from "./types.js";
import type { GateCRepairActionRecord } from "@matchday/contracts";

export type RepairCaseRecord = {
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

export type RepairRevisionRecord = {
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

export type RepairActionRecord = {
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

export type RepairAdjustmentRecord = {
  match_id: string;
  division_id: string;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  playing_area_id: string | null;
  reason: string;
};

export type CorrectionSourceRecord = {
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

export type AffectedMatchRecord = {
  match_id: string;
  division_id: string;
  state: "pending" | "ready" | "in_progress" | "final" | "corrected";
  home_entry_id: string | null;
  away_entry_id: string | null;
  home_control: "automatic" | "manual";
  away_control: "automatic" | "manual";
  operationally_locked: boolean;
};

export type MatchDependencyRecord = {
  source_match_id: string;
  downstream_match_id: string;
  slot: "home" | "away";
  outcome: "winner" | "loser";
};

export type MatchOutcomeRecord = {
  match_id: string;
  home_entry_id: string | null;
  away_entry_id: string | null;
  home_score: number | null;
  away_score: number | null;
};

export type PendingRepairCaseRecord = {
  result_repair_case_id: string;
  correction_transaction_id: string;
  corrected_match_id: string;
  corrected_match_code: string;
  division_id: string;
  division_name: string;
  source_result_version: number;
  created_at: Date | string;
};

export type RepairQueueItemRecord = {
  repair_id: string;
  corrected_match_id: string;
  corrected_match_code: string;
  division_id: string;
  division_name: string;
  source_result_version: number;
  source_schedule_version: number;
  source_projection_version: number;
  analysis_fingerprint: string;
  latest_revision_id: string | null;
  latest_revision: number | null;
  latest_status: "draft" | "ready" | "published" | "abandoned" | null;
  affected_action_count: number;
  unresolved_action_count: number;
  created_at: Date | string;
};

export type AuditEventRecord = {
  occurred_at: Date | string;
  actor_account_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
};

export class RepairRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findCaseById(
    id: string,
    competitionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<RepairCaseRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR KEY SHARE" : "";
    const rows = await executor.unsafe<RepairCaseRecord>(
      `SELECT * FROM schedule_repair_cases WHERE id = $1 AND competition_id = $2${lockClause}`,
      [id, competitionId],
    );
    return rows[0] ?? null;
  }

  async findCaseByMatchAndResultVersion(
    competitionId: string,
    correctedMatchId: string,
    sourceResultVersion: number,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<RepairCaseRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR KEY SHARE" : "";
    const rows = await executor.unsafe<RepairCaseRecord>(
      `SELECT * FROM schedule_repair_cases
       WHERE competition_id = $1 AND corrected_match_id = $2 AND source_result_version = $3${lockClause}`,
      [competitionId, correctedMatchId, sourceResultVersion],
    );
    return rows[0] ?? null;
  }

  async findCaseByCorrectionId(
    correctionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<RepairCaseRecord | null> {
    const rows = await executor.unsafe<RepairCaseRecord>(
      `SELECT * FROM schedule_repair_cases WHERE correction_transaction_id = $1`,
      [correctionId],
    );
    return rows[0] ?? null;
  }

  async createCase(
    input: {
      competitionId: string;
      correctedDivisionId: string;
      correctedMatchId: string;
      correctionTransactionId: string;
      sourceResultVersion: number;
      sourceScheduleVersion: number;
      sourceProjectionVersion: number;
      analysisFingerprint: string;
      analysisFingerprintInput: string;
      createdByAccountId: string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<RepairCaseRecord> {
    const rows = await executor.unsafe<RepairCaseRecord>(
      `INSERT INTO schedule_repair_cases(
         competition_id, corrected_division_id, corrected_match_id, correction_transaction_id,
         source_result_version, source_schedule_version, source_projection_version,
         analysis_fingerprint, analysis_fingerprint_input, created_by_account_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (correction_transaction_id) DO UPDATE SET competition_id = EXCLUDED.competition_id
       RETURNING *`,
      [
        input.competitionId,
        input.correctedDivisionId,
        input.correctedMatchId,
        input.correctionTransactionId,
        input.sourceResultVersion,
        input.sourceScheduleVersion,
        input.sourceProjectionVersion,
        input.analysisFingerprint,
        input.analysisFingerprintInput,
        input.createdByAccountId,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to create repair case");
    return row;
  }

  async findRevisionById(
    id: string,
    repairCaseId: string,
    competitionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<RepairRevisionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR KEY SHARE" : "";
    const rows = await executor.unsafe<RepairRevisionRecord>(
      `SELECT * FROM schedule_repair_revisions WHERE id = $1 AND repair_case_id = $2 AND competition_id = $3${lockClause}`,
      [id, repairCaseId, competitionId],
    );
    return rows[0] ?? null;
  }

  async findLatestRevision(
    repairCaseId: string,
    competitionId?: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<RepairRevisionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR KEY SHARE" : "";
    const whereClause = competitionId
      ? "WHERE repair_case_id = $1 AND competition_id = $2"
      : "WHERE repair_case_id = $1";
    const params = competitionId ? [repairCaseId, competitionId] : [repairCaseId];

    const rows = await executor.unsafe<RepairRevisionRecord>(
      `SELECT * FROM schedule_repair_revisions
       ${whereClause}
       ORDER BY revision DESC LIMIT 1${lockClause}`,
      params,
    );
    return rows[0] ?? null;
  }

  async appendRevision(
    input: {
      repairCaseId: string;
      expectedSourceResultVersion: number;
      expectedSourceScheduleVersion: number;
      expectedAnalysisFingerprint: string;
      parentRevisionId?: string | null;
      nextStatus: "draft" | "ready" | "published" | "abandoned";
      nextPublicationFingerprint?: string | null;
      actorAccountId: string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<RepairRevisionRecord> {
    const params = [
      input.repairCaseId,
      input.expectedSourceResultVersion,
      input.expectedSourceScheduleVersion,
      input.expectedAnalysisFingerprint,
      input.parentRevisionId ?? null,
      input.nextStatus,
      input.nextPublicationFingerprint ?? null,
      input.actorAccountId,
    ];
    const rows = await executor.unsafe<RepairRevisionRecord>(
      `SELECT * FROM gate_c_append_schedule_repair_revision($1, $2, $3, $4, $5, $6, $7, $8)`,
      params,
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to append repair revision");
    return row;
  }

  async insertAction(
    input: {
      repairRevisionId: string;
      repairCaseId: string;
      competitionId: string;
      ordinal: number;
      matchId: string;
      divisionId: string;
      slot: "home" | "away";
      sourceAction: string;
      currentEntryId: string | null;
      proposedEntryId: string | null;
      dependencyPath: unknown;
      reason: string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ id: string }> {
    const rows = await executor.unsafe<{ id: string }>(
      `INSERT INTO schedule_repair_actions(
         repair_revision_id, repair_case_id, competition_id, ordinal, match_id, division_id, slot,
         source_action, current_entry_id, proposed_entry_id, dependency_path, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       RETURNING id`,
      [
        input.repairRevisionId,
        input.repairCaseId,
        input.competitionId,
        input.ordinal,
        input.matchId,
        input.divisionId,
        input.slot,
        input.sourceAction,
        input.currentEntryId,
        input.proposedEntryId,
        typeof input.dependencyPath === "string" ? input.dependencyPath : JSON.stringify(input.dependencyPath),
        input.reason,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to insert repair action");
    return row;
  }

  async insertDecision(
    input: {
      repairActionId: string;
      repairRevisionId: string;
      repairCaseId: string;
      competitionId: string;
      matchId: string;
      divisionId: string;
      slot: "home" | "away";
      decision: string;
      selectedEntryId: string | null;
      reason: string;
      clientEventId: string;
      requestFingerprint: string;
      decidedByAccountId: string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<void> {
    await executor.unsafe(
      `INSERT INTO schedule_repair_decisions(
         repair_action_id, repair_revision_id, repair_case_id, competition_id, match_id, division_id, slot,
         decision, selected_entry_id, reason, client_event_id, request_fingerprint, decided_by_account_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.repairActionId,
        input.repairRevisionId,
        input.repairCaseId,
        input.competitionId,
        input.matchId,
        input.divisionId,
        input.slot,
        input.decision,
        input.selectedEntryId,
        input.reason,
        input.clientEventId,
        input.requestFingerprint,
        input.decidedByAccountId,
      ],
    );
  }

  async insertAdjustment(
    input: {
      repairRevisionId: string;
      repairCaseId: string;
      competitionId: string;
      matchId: string;
      divisionId: string;
      playingAreaId: string | null;
      startsAt: Date | string | null;
      endsAt: Date | string | null;
      reason: string;
      decidedByAccountId: string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<void> {
    await executor.unsafe(
      `INSERT INTO schedule_repair_match_adjustments(
         repair_revision_id, repair_case_id, competition_id, match_id, division_id,
         playing_area_id, starts_at, ends_at, reason, decided_by_account_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.repairRevisionId,
        input.repairCaseId,
        input.competitionId,
        input.matchId,
        input.divisionId,
        input.playingAreaId ?? null,
        input.startsAt ?? null,
        input.endsAt ?? null,
        input.reason,
        input.decidedByAccountId,
      ],
    );
  }

  async findActionsByRevisionId(
    revisionId: string,
    competitionId?: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly RepairActionRecord[]> {
    const whereClause = competitionId
      ? "WHERE action.repair_revision_id = $1 AND action.competition_id = $2"
      : "WHERE action.repair_revision_id = $1";
    const params = competitionId ? [revisionId, competitionId] : [revisionId];

    return executor.unsafe<RepairActionRecord>(
      `SELECT action.*,
              match.code AS match_code,
              decision.decision,
              decision.selected_entry_id,
              decision.reason AS decision_reason,
              current_entry.name AS current_entry_name,
              proposed_entry.name AS proposed_entry_name,
              selected_entry.name AS selected_entry_name
       FROM schedule_repair_actions action
       LEFT JOIN schedule_repair_decisions decision ON decision.repair_action_id = action.id
       LEFT JOIN division_entries current_entry ON current_entry.id = action.current_entry_id
       LEFT JOIN division_entries proposed_entry ON proposed_entry.id = action.proposed_entry_id
       LEFT JOIN division_entries selected_entry ON selected_entry.id = decision.selected_entry_id
       LEFT JOIN matches match ON match.id = action.match_id
         AND match.competition_id = action.competition_id AND match.division_id = action.division_id
       ${whereClause}
       ORDER BY action.ordinal ASC`,
      params,
    );
  }

  async findPersistedActionsAndDecisions(
    revisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<
    readonly {
      match_id: string;
      slot: "home" | "away";
      source_action: GateCRepairActionRecord["source_action"];
      decision: GateCRepairActionRecord["decision"];
      selected_entry_id: string | null;
      reason: string;
    }[]
  > {
    return executor.unsafe<{
      match_id: string;
      slot: "home" | "away";
      source_action: GateCRepairActionRecord["source_action"];
      decision: GateCRepairActionRecord["decision"];
      selected_entry_id: string | null;
      reason: string;
    }>(
      `SELECT action.match_id, action.slot, action.source_action, decision.decision, decision.selected_entry_id, decision.reason
       FROM schedule_repair_actions action
       JOIN schedule_repair_decisions decision ON decision.repair_action_id = action.id
       WHERE action.repair_revision_id = $1
       ORDER BY action.ordinal ASC`,
      [revisionId],
    );
  }

  async findActionDivisions(
    revisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly { division_id: string }[]> {
    return executor.unsafe<{ division_id: string }>(
      `SELECT DISTINCT division_id FROM schedule_repair_actions
       WHERE repair_revision_id = $1
       ORDER BY division_id`,
      [revisionId],
    );
  }

  async findAdjustmentsByRevisionId(
    revisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly RepairAdjustmentRecord[]> {
    return executor.unsafe<RepairAdjustmentRecord>(
      `SELECT match_id, division_id, starts_at, ends_at, playing_area_id, reason
       FROM schedule_repair_match_adjustments
       WHERE repair_revision_id = $1
       ORDER BY match_id ASC`,
      [revisionId],
    );
  }

  async findSourceCorrection(
    correctionTransactionId: string,
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<CorrectionSourceRecord | null> {
    const rows = await executor.unsafe<CorrectionSourceRecord>(
      `SELECT correction.id AS correction_id, correction.competition_id, correction.division_id,
              correction.match_id, correction.result_version,
              publication.result_version AS current_result_version,
              publication.schedule_version,
              COALESCE((SELECT max(projection.projection_version)
                FROM public_projection_versions projection
                WHERE projection.competition_id = correction.competition_id
                  AND projection.division_id = correction.division_id), 0) AS source_projection_version,
              match.format_revision_id
       FROM score_correction_transactions correction
       JOIN competition_publications publication ON publication.competition_id = correction.competition_id
       JOIN matches match ON match.id = correction.match_id
       WHERE correction.id = $1 AND correction.competition_id = $2
       FOR UPDATE OF correction, publication`,
      [correctionTransactionId, competitionId],
    );
    return rows[0] ?? null;
  }

  async findMatchesForAnalysis(
    formatRevisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly AffectedMatchRecord[]> {
    return executor.unsafe<AffectedMatchRecord>(
      `SELECT match.id AS match_id, match.division_id, match.state, match.home_entry_id, match.away_entry_id,
              COALESCE(home_slot.control, 'automatic') AS home_control,
              COALESCE(away_slot.control, 'automatic') AS away_control,
              EXISTS(SELECT 1 FROM schedule_assignment_locks lock WHERE lock.match_id = match.id) AS operationally_locked
       FROM matches match
       LEFT JOIN advancement_slots home_slot ON home_slot.match_id = match.id AND home_slot.slot = 'home'
       LEFT JOIN advancement_slots away_slot ON away_slot.match_id = match.id AND away_slot.slot = 'away'
       WHERE match.format_revision_id = $1
       ORDER BY match.ordinal, match.id`,
      [formatRevisionId],
    );
  }

  async findDependenciesForAnalysis(
    formatRevisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly MatchDependencyRecord[]> {
    return executor.unsafe<MatchDependencyRecord>(
      `SELECT source_match_id, match_id AS downstream_match_id, slot, outcome
       FROM match_dependencies WHERE format_revision_id = $1
       ORDER BY source_match_id, match_id, slot`,
      [formatRevisionId],
    );
  }

  async findOutcomesForAnalysis(
    formatRevisionId: string,
    maxResultVersion: number,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly MatchOutcomeRecord[]> {
    return executor.unsafe<MatchOutcomeRecord>(
      `SELECT DISTINCT ON (match.id) match.id AS match_id, match.home_entry_id, match.away_entry_id,
              snapshot.home_score, snapshot.away_score
       FROM matches match
       LEFT JOIN match_result_snapshots snapshot
         ON snapshot.match_id = match.id AND snapshot.result_version <= $2
       WHERE match.format_revision_id = $1
       ORDER BY match.id, snapshot.result_version DESC NULLS LAST`,
      [formatRevisionId, maxResultVersion],
    );
  }

  async findAffectedDivisionState(
    competitionId: string,
    divisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<{
    matches: readonly AffectedMatchRecord[];
    dependencies: readonly MatchDependencyRecord[];
  }> {
    const [matches, dependencies] = await Promise.all([
      executor.unsafe<AffectedMatchRecord>(
        `SELECT match.id AS match_id, match.division_id,
                state.state, state.home_entry_id, state.away_entry_id,
                state.home_control, state.away_control,
                (schedule_match.starts_at IS NOT NULL AND schedule_match.starts_at <= now() + interval '2 hours') AS operationally_locked
         FROM matches match
         JOIN match_participant_states state ON state.match_id = match.id
         LEFT JOIN scheduled_matches schedule_match ON schedule_match.match_id = match.id
         WHERE match.competition_id = $1 AND match.division_id = $2
         ORDER BY match.id ASC`,
        [competitionId, divisionId],
      ),
      executor.unsafe<MatchDependencyRecord>(
        `SELECT source_match_id, downstream_match_id, slot, outcome
         FROM match_dependencies
         WHERE competition_id = $1 AND division_id = $2
         ORDER BY downstream_match_id, slot`,
        [competitionId, divisionId],
      ),
    ]);
    return { matches, dependencies };
  }

  async findMatchOutcomeRows(
    competitionId: string,
    matchIds: string[],
    executor: SqlExecutor = this.sql,
  ): Promise<readonly MatchOutcomeRecord[]> {
    if (matchIds.length === 0) return [];
    return executor.unsafe<MatchOutcomeRecord>(
      `SELECT match.id AS match_id, state.home_entry_id, state.away_entry_id,
              result.home_score, result.away_score
       FROM matches match
       JOIN match_participant_states state ON state.match_id = match.id
       LEFT JOIN match_results result ON result.match_id = match.id
       WHERE match.competition_id = $1 AND match.id = ANY($2)`,
      [competitionId, matchIds],
    );
  }

  async findPublicationReceiptByIdempotencyKey(
    competitionId: string,
    idempotencyKey: string,
    executor: SqlExecutor = this.sql,
  ): Promise<{ request_fingerprint: string; response: unknown } | null> {
    const rows = await executor.unsafe<{ request_fingerprint: string; response: unknown }>(
      `SELECT request_fingerprint, response FROM schedule_repair_publication_receipts
       WHERE competition_id = $1 AND idempotency_key = $2`,
      [competitionId, idempotencyKey],
    );
    return rows[0] ?? null;
  }

  async hasPublicationReceipt(repairCaseId: string, executor: SqlExecutor = this.sql): Promise<boolean> {
    const rows = await executor.unsafe<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM schedule_repair_publication_receipts WHERE repair_case_id = $1) AS present`,
      [repairCaseId],
    );
    return Boolean(rows[0]?.present);
  }

  async insertPublicationReceipt(
    input: {
      competitionId: string;
      repairCaseId: string;
      repairRevisionId: string;
      requestFingerprint: string;
      idempotencyKey: string;
      scheduleRevisionId: string;
      scheduleVersion: number;
      resultVersion: number;
      analysisFingerprint: string;
      response: unknown;
      publishedByAccountId: string;
      publishedAt: Date | string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ id: string }> {
    const rows = await executor.unsafe<{ id: string }>(
      `INSERT INTO schedule_repair_publication_receipts(
         competition_id, repair_case_id, repair_revision_id, request_fingerprint, idempotency_key,
         schedule_revision_id, schedule_version, result_version, analysis_fingerprint, response, published_by_account_id,
         published_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
       RETURNING id`,
      [
        input.competitionId,
        input.repairCaseId,
        input.repairRevisionId,
        input.requestFingerprint,
        input.idempotencyKey,
        input.scheduleRevisionId,
        input.scheduleVersion,
        input.resultVersion,
        input.analysisFingerprint,
        typeof input.response === "string" ? input.response : JSON.stringify(input.response),
        input.publishedByAccountId,
        input.publishedAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to insert publication receipt");
    return row;
  }

  async insertPublicationProjectionVersions(
    input: {
      publicationReceiptId: string;
      competitionId: string;
      divisionId: string;
      publicProjectionVersionId: string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<void> {
    await executor.unsafe(
      `INSERT INTO schedule_repair_publication_projection_versions(
         publication_receipt_id, competition_id, division_id, public_projection_version_id
       ) VALUES ($1, $2, $3, $4)`,
      [input.publicationReceiptId, input.competitionId, input.divisionId, input.publicProjectionVersionId],
    );
  }

  async listPendingCases(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly PendingRepairCaseRecord[]> {
    return executor.unsafe<PendingRepairCaseRecord>(
      `SELECT result_case.id AS result_repair_case_id,
              result_case.correction_transaction_id,
              result_case.corrected_match_id,
              match.code AS corrected_match_code,
              result_case.division_id,
              division.name AS division_name,
              result_case.source_result_version,
              result_case.created_at
       FROM result_repair_cases result_case
       JOIN matches match ON match.id = result_case.corrected_match_id
       JOIN divisions division ON division.id = result_case.division_id
       LEFT JOIN schedule_repair_cases schedule_case
         ON schedule_case.result_repair_case_id = result_case.id
       WHERE result_case.competition_id = $1
         AND schedule_case.id IS NULL
       ORDER BY result_case.created_at, result_case.id`,
      [competitionId],
    );
  }

  async listRepairs(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly RepairQueueItemRecord[]> {
    return executor.unsafe<RepairQueueItemRecord>(
      `SELECT repair.id AS repair_id,
              repair.corrected_match_id,
              match.code AS corrected_match_code,
              repair.corrected_division_id AS division_id,
              division.name AS division_name,
              repair.source_result_version,
              repair.source_schedule_version,
              repair.source_projection_version,
              repair.analysis_fingerprint,
              latest.id AS latest_revision_id,
              latest.revision AS latest_revision,
              latest.status AS latest_status,
              COALESCE(action_counts.affected_action_count, 0)::integer AS affected_action_count,
              COALESCE(action_counts.unresolved_action_count, 0)::integer AS unresolved_action_count,
              repair.created_at
       FROM schedule_repair_cases repair
       JOIN matches match ON match.id = repair.corrected_match_id
       JOIN divisions division ON division.id = repair.corrected_division_id
       LEFT JOIN LATERAL (
         SELECT revision.id, revision.revision, revision.status
         FROM schedule_repair_revisions revision
         WHERE revision.repair_case_id = repair.id
         ORDER BY revision.revision DESC
         LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS affected_action_count,
                count(*) FILTER (WHERE action.source_action = 'requires_organiser_decision' AND decision.id IS NULL)::integer
                  AS unresolved_action_count
         FROM schedule_repair_actions action
         LEFT JOIN schedule_repair_decisions decision ON decision.repair_action_id = action.id
         WHERE action.repair_revision_id = latest.id
       ) action_counts ON true
       WHERE repair.competition_id = $1
       ORDER BY
         CASE latest.status WHEN 'draft' THEN 0 WHEN 'ready' THEN 1 WHEN 'published' THEN 2 ELSE 3 END,
         repair.created_at DESC,
         repair.id`,
      [competitionId],
    );
  }

  async acquirePublicationLock(competitionId: string, executor: SqlExecutor = this.sql): Promise<void> {
    await executor.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended('gate-c:repair-publication:'||$1, 0))`, [
      competitionId,
    ]);
  }

  async acquireLifecycleLock(repairId: string, executor: SqlExecutor = this.sql): Promise<void> {
    await executor.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended('gate-c:repair-lifecycle:'||$1, 0))`, [
      repairId,
    ]);
  }

  async insertAuditEvent(
    input: {
      occurredAt: Date | string;
      requestId: string;
      actorAccountId: string;
      organisationId: string;
      action: string;
      targetType: string;
      targetId: string;
      reason?: string | null;
      afterState?: unknown;
      metadata?: unknown;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<void> {
    await executor.unsafe(
      `INSERT INTO audit_events(
         occurred_at, request_id, actor_account_id, actor_type, organisation_id,
         action, target_type, target_id, reason, after_state, metadata
       ) VALUES ($1, $2, $3, 'account', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
      [
        input.occurredAt,
        input.requestId,
        input.actorAccountId,
        input.organisationId,
        input.action,
        input.targetType,
        input.targetId,
        input.reason ?? null,
        input.afterState
          ? typeof input.afterState === "string"
            ? input.afterState
            : JSON.stringify(input.afterState)
          : null,
        input.metadata ? (typeof input.metadata === "string" ? input.metadata : JSON.stringify(input.metadata)) : null,
      ],
    );
  }

  async insertOutboxEvent(
    input: {
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      payload: unknown;
      idempotencyKey: string;
      createdAt: Date | string;
      availableAt?: Date | string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<void> {
    await executor.unsafe(
      `INSERT INTO outbox_events(
         aggregate_type, aggregate_id, event_type, payload, idempotency_key, created_at, available_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload),
        input.idempotencyKey,
        input.createdAt,
        input.availableAt ?? input.createdAt,
      ],
    );
  }

  async findAuditEventsForRepair(
    competitionId: string,
    repairCaseId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly AuditEventRecord[]> {
    return executor.unsafe<AuditEventRecord>(
      `SELECT occurred_at, actor_account_id, action, target_type, target_id, reason
       FROM audit_events
       WHERE organisation_id = (SELECT organisation_id FROM competitions WHERE id = $1)
         AND (target_id = $2 OR metadata->>'repair_case_id' = $2)
       ORDER BY occurred_at, target_id`,
      [competitionId, repairCaseId],
    );
  }
}
