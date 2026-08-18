import type { SqlExecutor, LockMode, ScheduleRevisionRecord } from "./types.js";

export { type ScheduleRevisionRecord };

const SCHEDULE_COLUMNS = `id, competition_id, format_revision_id, revision, status, input_hash, warnings, created_by, created_at, published_at`;

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

  async acquireScheduleLock(
    competitionId: string,
    prefix: string = "phase4-schedule",
    executor: SqlExecutor = this.sql,
  ): Promise<void> {
    await executor.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2, 0))`, [prefix, competitionId]);
  }
}
