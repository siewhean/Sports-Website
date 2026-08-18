import type { SqlExecutor, CompetitionRecord, LockMode } from "./types.js";

export class CompetitionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(
    id: string,
    lock: LockMode = "none",
    executor: SqlExecutor = this.sql,
  ): Promise<CompetitionRecord | null> {
    const lockClause = lock === "for_update" ? " FOR UPDATE" : lock === "for_share" ? " FOR SHARE" : "";

    const rows = await executor.unsafe<CompetitionRecord>(
      `SELECT id, organisation_id, name, slug, status, sport_code, sport_pack_version, capacity_revision, created_at, updated_at
       FROM competitions
       WHERE id = $1${lockClause}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findBySlug(slug: string, executor: SqlExecutor = this.sql): Promise<CompetitionRecord | null> {
    const rows = await executor.unsafe<CompetitionRecord>(
      `SELECT id, organisation_id, name, slug, status, sport_code, sport_pack_version, capacity_revision, created_at, updated_at
       FROM competitions
       WHERE slug = $1`,
      [slug],
    );
    return rows[0] ?? null;
  }

  async existsBySlug(slug: string, excludeId?: string, executor: SqlExecutor = this.sql): Promise<boolean> {
    if (excludeId) {
      const rows = await executor.unsafe<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM competitions WHERE slug = $1 AND id != $2
         ) AS exists`,
        [slug, excludeId],
      );
      return Boolean(rows[0]?.exists);
    }

    const rows = await executor.unsafe<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM competitions WHERE slug = $1
       ) AS exists`,
      [slug],
    );
    return Boolean(rows[0]?.exists);
  }

  async getCapacityRevision(id: string, executor: SqlExecutor = this.sql): Promise<number | null> {
    const rows = await executor.unsafe<{ capacity_revision: number }>(
      `SELECT capacity_revision FROM competitions WHERE id = $1`,
      [id],
    );
    return rows[0]?.capacity_revision ?? null;
  }

  async incrementCapacityRevision(id: string, executor: SqlExecutor = this.sql): Promise<number> {
    const rows = await executor.unsafe<{ capacity_revision: number }>(
      `UPDATE competitions
       SET capacity_revision = capacity_revision + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING capacity_revision`,
      [id],
    );
    return rows[0]?.capacity_revision ?? 0;
  }
}
