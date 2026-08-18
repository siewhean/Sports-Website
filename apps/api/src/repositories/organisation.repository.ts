import type { SqlExecutor, OrganisationRecord } from "./types.js";

export class OrganisationRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(id: string, executor: SqlExecutor = this.sql): Promise<OrganisationRecord | null> {
    const rows = await executor.unsafe<OrganisationRecord>(
      `SELECT id, name, slug, created_at, updated_at
       FROM organisations
       WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async acquireBootstrapLock(accountId: string, executor: SqlExecutor = this.sql): Promise<void> {
    await executor.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `organisation-bootstrap:${accountId}`,
    ]);
  }

  async isMember(organisationId: string, accountId: string, executor: SqlExecutor = this.sql): Promise<boolean> {
    const rows = await executor.unsafe<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM organisation_memberships
         WHERE organisation_id = $1 AND account_id = $2 AND status = 'active'
       ) AS exists`,
      [organisationId, accountId],
    );
    return Boolean(rows[0]?.exists);
  }

  async hasActiveRole(
    organisationId: string,
    accountId: string,
    roles: readonly string[],
    executor: SqlExecutor = this.sql,
  ): Promise<boolean> {
    const rows = await executor.unsafe<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM organisation_memberships
         WHERE organisation_id = $1 AND account_id = $2 AND status = 'active' AND role = ANY($3::text[])
       ) AS exists`,
      [organisationId, accountId, roles],
    );
    return Boolean(rows[0]?.exists);
  }
}
