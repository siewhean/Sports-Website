import type { SqlExecutor, DivisionRecord, LockMode } from "./types.js";

export class DivisionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(
    id: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<DivisionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";

    const rows = await executor.unsafe<DivisionRecord>(
      `SELECT id, competition_id, name, created_at, updated_at
       FROM divisions
       WHERE id = $1${lockClause}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listByCompetitionId(
    competitionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly DivisionRecord[]> {
    return executor.unsafe<DivisionRecord>(
      `SELECT id, competition_id, name, created_at, updated_at
       FROM divisions
       WHERE competition_id = $1
       ORDER BY created_at ASC`,
      [competitionId],
    );
  }

  async getEntryCount(divisionId: string, executor: SqlExecutor = this.sql): Promise<number> {
    const rows = await executor.unsafe<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM entries
       WHERE division_id = $1`,
      [divisionId],
    );
    return Number.parseInt(rows[0]?.count ?? "0", 10);
  }
}
