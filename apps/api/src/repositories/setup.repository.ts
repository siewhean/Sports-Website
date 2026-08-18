import type { SqlExecutor, LockMode } from "./types.js";

export type SetupDraftRecord = {
  id: string;
  organisation_id: string;
  competition_id: string;
  competition_status: string;
  status: string;
  revision: number;
  current_step: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
};

export class SetupRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findByCompetitionId(
    competitionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<SetupDraftRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE OF d" : "";

    const rows = await executor.unsafe<SetupDraftRecord>(
      `SELECT d.*, c.status AS competition_status
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
