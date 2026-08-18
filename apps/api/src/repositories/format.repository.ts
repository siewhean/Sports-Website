import type { SqlExecutor, LockMode, FormatRevisionRecord } from "./types.js";

export { type FormatRevisionRecord };

const FORMAT_COLUMNS = `id, competition_id, division_id, revision, definition, definition_hash, status, parent_revision_id, root_revision_id, template_version_id, source_kind, layout, created_by, created_at, published_at, graph_materialized_at, graph_materialization_hash, graph_match_count`;

export class FormatRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(
    id: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<FormatRevisionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<FormatRevisionRecord>(
      `SELECT ${FORMAT_COLUMNS} FROM format_revisions WHERE id = $1${lockClause}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findByIds(ids: readonly string[], executor: SqlExecutor = this.sql): Promise<readonly FormatRevisionRecord[]> {
    if (ids.length === 0) return [];
    return executor.unsafe<FormatRevisionRecord>(
      `SELECT ${FORMAT_COLUMNS} FROM format_revisions WHERE id = ANY($1::uuid[]) ORDER BY division_id`,
      [ids],
    );
  }

  async findLatestByDivisionId(
    divisionId: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<FormatRevisionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";
    const rows = await executor.unsafe<FormatRevisionRecord>(
      `SELECT ${FORMAT_COLUMNS} FROM format_revisions
       WHERE division_id = $1
       ORDER BY revision DESC, id DESC
       LIMIT 1${lockClause}`,
      [divisionId],
    );
    return rows[0] ?? null;
  }

  async findPublishedByDivisionId(
    divisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<FormatRevisionRecord | null> {
    const rows = await executor.unsafe<FormatRevisionRecord>(
      `SELECT ${FORMAT_COLUMNS}
       FROM format_revisions
       WHERE division_id = $1 AND status = 'published'
       ORDER BY revision DESC
       LIMIT 1`,
      [divisionId],
    );
    return rows[0] ?? null;
  }

  async listByDivisionId(
    divisionId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly FormatRevisionRecord[]> {
    return executor.unsafe<FormatRevisionRecord>(
      `SELECT ${FORMAT_COLUMNS} FROM format_revisions
       WHERE division_id = $1
       ORDER BY revision DESC, id DESC`,
      [divisionId],
    );
  }

  async countPublishedForCompetition(competitionId: string, executor: SqlExecutor = this.sql): Promise<number> {
    const rows = await executor.unsafe<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM format_revisions
       WHERE competition_id = $1 AND status = 'published'`,
      [competitionId],
    );
    return Number.parseInt(rows[0]?.count ?? "0", 10);
  }
}
