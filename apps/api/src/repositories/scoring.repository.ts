import type {
  SqlExecutor,
  LockMode,
  ScoringSessionRecord,
  ScoringAccessPassRecord,
  MatchRecord,
  MatchWriterLeaseRecord,
  PublicationRecord,
} from "./types.js";

export {
  type ScoringSessionRecord,
  type ScoringAccessPassRecord,
  type MatchRecord,
  type MatchWriterLeaseRecord,
  type PublicationRecord,
};

const PASS_COLUMNS = `id, competition_id, match_id, role, status, code_hash, token_hash, created_by, created_at, expires_at`;
const SESSION_COLUMNS = `id, pass_id, competition_id, match_id, mode, status, created_at, last_heartbeat_at, expires_at`;
const MATCH_COLUMNS = `id, competition_id, division_id, match_code, home_entry_id, away_entry_id, status, created_at, updated_at`;

export class ScoringRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findPassById(
    id: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<ScoringAccessPassRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<ScoringAccessPassRecord>(
      `SELECT ${PASS_COLUMNS} FROM scoring_access_passes WHERE id = $1${lockClause}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findPassByCodeHash(
    codeHash: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<ScoringAccessPassRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<ScoringAccessPassRecord>(
      `SELECT ${PASS_COLUMNS} FROM scoring_access_passes WHERE code_hash = $1${lockClause}`,
      [codeHash],
    );
    return rows[0] ?? null;
  }

  async findPassByTokenHash(
    tokenHash: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<ScoringAccessPassRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<ScoringAccessPassRecord>(
      `SELECT ${PASS_COLUMNS} FROM scoring_access_passes WHERE token_hash = $1${lockClause}`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async findSessionById(
    id: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<ScoringSessionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<ScoringSessionRecord>(
      `SELECT ${SESSION_COLUMNS} FROM scoring_access_sessions WHERE id = $1${lockClause}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findMatchById(
    id: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<MatchRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<MatchRecord>(`SELECT ${MATCH_COLUMNS} FROM matches WHERE id = $1${lockClause}`, [
      id,
    ]);
    return rows[0] ?? null;
  }

  async findWriterLease(
    matchId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<MatchWriterLeaseRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<MatchWriterLeaseRecord>(
      `SELECT match_id, session_id, generation, acquired_at, expires_at
       FROM match_writer_leases
       WHERE match_id = $1${lockClause}`,
      [matchId],
    );
    return rows[0] ?? null;
  }

  async findPublication(
    competitionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<PublicationRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<PublicationRecord>(
      `SELECT competition_id, schedule_version, result_version, published_at
       FROM competition_publications
       WHERE competition_id = $1${lockClause}`,
      [competitionId],
    );
    return rows[0] ?? null;
  }

  async listPassesByMatchId(
    matchId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly ScoringAccessPassRecord[]> {
    return executor.unsafe<ScoringAccessPassRecord>(
      `SELECT ${PASS_COLUMNS} FROM scoring_access_passes WHERE match_id = $1 ORDER BY created_at DESC`,
      [matchId],
    );
  }

  async listSessionsByPassId(
    passId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly ScoringSessionRecord[]> {
    return executor.unsafe<ScoringSessionRecord>(
      `SELECT ${SESSION_COLUMNS} FROM scoring_access_sessions WHERE pass_id = $1 ORDER BY created_at DESC`,
      [passId],
    );
  }
}
