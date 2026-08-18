import type { SqlExecutor, LockMode } from "./types.js";

export type ScheduleRevisionRecord = {
  id: string;
  competition_id: string;
  revision: number;
  status: "draft" | "published" | "archived";
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
};

export class ScheduleRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(
    id: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<ScheduleRevisionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : "";
    const rows = await executor.unsafe<ScheduleRevisionRecord>(
      `SELECT * FROM schedule_revisions WHERE id = $1${lockClause}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findLatestPublished(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<ScheduleRevisionRecord | null> {
    const rows = await executor.unsafe<ScheduleRevisionRecord>(
      `SELECT * FROM schedule_revisions
       WHERE competition_id = $1 AND status = 'published'
       ORDER BY revision DESC
       LIMIT 1`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async acquireScheduleLock(competitionId: string, executor: SqlExecutor = this.sql): Promise<void> {
    await executor.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `schedule-mutation:${competitionId}`,
    ]);
  }
}
