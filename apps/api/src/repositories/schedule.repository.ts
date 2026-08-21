import type {
  SqlExecutor,
  LockMode,
  ScheduleRevisionRecord,
  ScheduleJobRecord,
  ScheduleOptionRecord,
} from "./types.js";

export { type ScheduleRevisionRecord, type ScheduleJobRecord, type ScheduleOptionRecord };

const SCHEDULE_COLUMNS = `id, competition_id, format_revision_id, revision, parent_revision_id, source_job_id, source_option_id, status, input_hash, assignment_hash, quality, warnings, editable_until, published_at, expired_at, created_by, created_at, updated_at`;
const JOB_COLUMNS = `id, competition_id, format_revision_id, status, input_hash, created_by, created_at, completed_at`;
const OPTION_COLUMNS = `id, job_id, result_revision, solver_iteration, result_status, quality, assignments, violations, assignment_hash, warnings, created_at`;

export class ScheduleRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(
    id: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<ScheduleRevisionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<ScheduleRevisionRecord>(
      `SELECT ${SCHEDULE_COLUMNS} FROM schedule_revisions WHERE id = $1${lockClause}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findLatestPublished(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<ScheduleRevisionRecord | null> {
    const rows = await executor.unsafe<ScheduleRevisionRecord>(
      `SELECT ${SCHEDULE_COLUMNS} FROM schedule_revisions
       WHERE competition_id = $1 AND status = 'published'
       ORDER BY revision DESC
       LIMIT 1`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async listRevisionsByCompetitionId(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly ScheduleRevisionRecord[]> {
    return executor.unsafe<ScheduleRevisionRecord>(
      `SELECT ${SCHEDULE_COLUMNS} FROM schedule_revisions
       WHERE competition_id = $1
       ORDER BY revision DESC, id DESC`,
      [competitionId],
    );
  }

  async findJobById(
    jobId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<ScheduleJobRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<ScheduleJobRecord>(
      `SELECT ${JOB_COLUMNS} FROM schedule_generation_jobs WHERE id = $1${lockClause}`,
      [jobId],
    );
    return rows[0] ?? null;
  }

  async findOptionById(
    jobId: string,
    optionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<ScheduleOptionRecord | null> {
    const rows = await executor.unsafe<ScheduleOptionRecord>(
      `SELECT ${OPTION_COLUMNS} FROM schedule_generation_options WHERE id = $1 AND job_id = $2`,
      [optionId, jobId],
    );
    return rows[0] ?? null;
  }

  async listOptionsByJobId(jobId: string, executor: SqlExecutor = this.sql): Promise<readonly ScheduleOptionRecord[]> {
    return executor.unsafe<ScheduleOptionRecord>(
      `SELECT ${OPTION_COLUMNS} FROM schedule_generation_options WHERE job_id = $1 ORDER BY result_revision DESC, id DESC`,
      [jobId],
    );
  }

  async acquireScheduleLock(
    competitionId: string,
    prefix: string = "phase4-schedule",
    executor: SqlExecutor = this.sql,
  ): Promise<void> {
    await executor.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2, 0))`, [prefix, competitionId]);
  }

  async allocateRevision(competitionId: string, executor: SqlExecutor = this.sql): Promise<number> {
    const rows = await executor.unsafe<{ revision: number }>(
      `SELECT COALESCE(max(revision), 0)::integer + 1 AS revision
       FROM schedule_revisions WHERE competition_id = $1`,
      [competitionId],
    );
    return rows[0]?.revision ?? 1;
  }

  async createRepairedRevision(
    input: {
      competitionId: string;
      formatRevisionId: string;
      revision: number;
      inputHash: string;
      warnings: unknown;
      createdBy: string;
      parentRevisionId: string;
      quality: unknown;
      sourceRepairRevisionId: string;
      updatedAt: Date | string;
    },
    executor: SqlExecutor = this.sql,
  ): Promise<{ id: string }> {
    const warningsJson = typeof input.warnings === "string" ? input.warnings : JSON.stringify(input.warnings);
    const qualityJson = typeof input.quality === "string" ? input.quality : JSON.stringify(input.quality);
    const rows = await executor.unsafe<{ id: string }>(
      `INSERT INTO schedule_revisions(
         competition_id, format_revision_id, revision, input_hash, status, warnings, created_by,
         parent_revision_id, quality, source_repair_revision_id, updated_at
       ) VALUES ($1, $2, $3, $4, 'draft', $5::jsonb, $6, $7, $8::jsonb, $9, $10)
       RETURNING id`,
      [
        input.competitionId,
        input.formatRevisionId,
        input.revision,
        input.inputHash,
        warningsJson,
        input.createdBy,
        input.parentRevisionId,
        qualityJson,
        input.sourceRepairRevisionId,
        input.updatedAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Repaired schedule revision was not created");
    return row;
  }

  async copyRevisionFormats(
    targetScheduleRevisionId: string,
    sourceScheduleRevisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<void> {
    await executor.unsafe(
      `INSERT INTO schedule_revision_formats(schedule_revision_id, competition_id, division_id, format_revision_id)
       SELECT $1, competition_id, division_id, format_revision_id
       FROM schedule_revision_formats WHERE schedule_revision_id = $2
       ORDER BY division_id`,
      [targetScheduleRevisionId, sourceScheduleRevisionId],
    );
  }

  async findAssignmentsForRevision(
    scheduleRevisionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<
    readonly { match_id: string; playing_area_id: string; starts_at: Date | string; ends_at: Date | string }[]
  > {
    const lockClause = lock === "for_share" ? " FOR SHARE" : lock === "for_update" ? " FOR UPDATE" : "";
    return executor.unsafe<{
      match_id: string;
      playing_area_id: string;
      starts_at: Date | string;
      ends_at: Date | string;
    }>(
      `SELECT match_id, playing_area_id, starts_at, ends_at
       FROM scheduled_matches WHERE schedule_revision_id = $1
       ORDER BY starts_at, playing_area_id, match_id${lockClause}`,
      [scheduleRevisionId],
    );
  }

  async insertScheduledMatches(
    matches: readonly {
      scheduleRevisionId: string;
      matchId: string;
      competitionId: string;
      playingAreaId: string;
      startsAt: Date | string;
      endsAt: Date | string;
    }[],
    executor: SqlExecutor = this.sql,
  ): Promise<void> {
    for (const match of matches) {
      await executor.unsafe(
        `INSERT INTO scheduled_matches(
           schedule_revision_id, match_id, competition_id, playing_area_id, starts_at, ends_at
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          match.scheduleRevisionId,
          match.matchId,
          match.competitionId,
          match.playingAreaId,
          match.startsAt,
          match.endsAt,
        ],
      );
    }
  }

  async acceptAndReadyRevision(
    scheduleRevisionId: string,
    updatedAt: Date | string,
    executor: SqlExecutor = this.sql,
  ): Promise<string> {
    await executor.unsafe(`SELECT set_config('matchday.phase4_accept_schedule', 'on', true)`);
    const [ready] = await executor.unsafe<{ assignment_hash: string }>(
      `UPDATE schedule_revisions
       SET assignment_hash = phase4_schedule_assignment_hash(id), status = 'ready_for_review', updated_at = $2
       WHERE id = $1 RETURNING assignment_hash`,
      [scheduleRevisionId, updatedAt],
    );
    await executor.unsafe(`SELECT set_config('matchday.phase4_accept_schedule', 'off', true)`);
    if (!ready?.assignment_hash) throw new Error("Repaired schedule assignment hash was not retained");
    return ready.assignment_hash;
  }

  async publishScheduleRevision(
    scheduleRevisionId: string,
    accountId: string,
    lockToken: string,
    executor: SqlExecutor = this.sql,
  ): Promise<{ id: string; published_at: Date | string }> {
    const rows = await executor.unsafe<{ id: string; published_at: Date | string }>(
      `SELECT id, published_at FROM phase4_publish_schedule_revision($1, $2, $3)`,
      [scheduleRevisionId, accountId, lockToken],
    );
    const row = rows[0];
    if (!row) throw new Error("Repaired schedule was not published");
    return row;
  }
}
