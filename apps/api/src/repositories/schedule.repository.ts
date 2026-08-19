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
}
