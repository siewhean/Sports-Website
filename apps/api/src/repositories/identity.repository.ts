import type { SqlExecutor, AccountRecord, OrganisationMembershipRecord } from "./types.js";

export { type AccountRecord, type OrganisationMembershipRecord };

const ACCOUNT_COLUMNS = `id, email, name, created_at, updated_at`;
const MEMBERSHIP_COLUMNS = `id, organisation_id, account_id, role, status, created_at, updated_at`;

export class IdentityRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findAccountById(id: string, executor: SqlExecutor = this.sql): Promise<AccountRecord | null> {
    const rows = await executor.unsafe<AccountRecord>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async findMembership(
    organisationId: string,
    accountId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<OrganisationMembershipRecord | null> {
    const rows = await executor.unsafe<OrganisationMembershipRecord>(
      `SELECT ${MEMBERSHIP_COLUMNS}
       FROM organisation_memberships
       WHERE organisation_id = $1 AND account_id = $2`,
      [organisationId, accountId],
    );
    return rows[0] ?? null;
  }

  async listOrganisationMemberships(
    organisationId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly OrganisationMembershipRecord[]> {
    return executor.unsafe<OrganisationMembershipRecord>(
      `SELECT ${MEMBERSHIP_COLUMNS}
       FROM organisation_memberships
       WHERE organisation_id = $1 AND status = 'active'
       ORDER BY created_at ASC`,
      [organisationId],
    );
  }

  async listAccountMemberships(
    accountId: string,
    executor: SqlExecutor = this.sql,
  ): Promise<readonly OrganisationMembershipRecord[]> {
    return executor.unsafe<OrganisationMembershipRecord>(
      `SELECT ${MEMBERSHIP_COLUMNS}
       FROM organisation_memberships
       WHERE account_id = $1 AND status = 'active'
       ORDER BY created_at ASC`,
      [accountId],
    );
  }
}
