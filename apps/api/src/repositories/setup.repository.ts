import type { SqlExecutor, LockMode, SetupDraftRecord } from "./types.js";

export { type SetupDraftRecord };

export class SetupRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findByCompetitionId(
    competitionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<SetupDraftRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE OF d" : lock === "for_share" ? " FOR SHARE OF d" : "";

    const rows = await executor.unsafe<SetupDraftRecord>(
      `SELECT d.id, d.schema_version, d.organisation_id, d.competition_id, c.status AS competition_status,
              d.status, d.revision, d.current_step, d.completed_steps, d.steps, d.validation,
              d.created_at, d.updated_at, d.expires_at, d.completed_at
       FROM setup_drafts d
       JOIN competitions c ON c.id = d.competition_id
       WHERE d.competition_id = $1${lockClause}`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async getRevision(competitionId: string, executor: SqlExecutor = this.sql): Promise<number | null> {
    const rows = await executor.unsafe<{ revision: number }>(
      `SELECT revision FROM setup_drafts WHERE competition_id = $1`,
      [competitionId],
    );
    return rows[0]?.revision ?? null;
  }
}
