import { AuditWriter, PostgresAuditRepository, type PostgresQueryPort } from "./audit.js";
import type {
  MembershipAuditPort,
  MembershipRole,
  MembershipStatus,
  Organisation,
  OrganisationMembership,
  OrganisationRepository,
  OrganisationUnitOfWork,
} from "./membership.js";
import type { Principal } from "./rbac.js";
import type {
  Account,
  AccountRepository,
  RecoveryRequestRecord,
  RecoveryRequestRepository,
  SessionRecord,
  SessionRepository,
} from "./types.js";

export interface PostgresJsSql {
  unsafe<T>(query: string, parameters?: readonly unknown[]): PromiseLike<readonly T[]>;
  begin?<T>(callback: (transaction: PostgresJsSql) => Promise<T>): PromiseLike<T>;
  savepoint?<T>(callback: (transaction: PostgresJsSql) => Promise<T>): PromiseLike<T>;
}

async function withTransaction<T>(
  sql: PostgresJsSql,
  operation: (transaction: PostgresJsSql) => Promise<T>,
): Promise<T> {
  return sql.begin ? sql.begin(operation) : operation(sql);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

type AccountRow = {
  id: string;
  primary_email: string;
  display_name: string;
  status: Account["status"];
  email_verified_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    primaryEmail: row.primary_email,
    displayName: row.display_name,
    status: row.status,
    emailVerifiedAt: row.email_verified_at ? asDate(row.email_verified_at) : null,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

export class PostgresAccountRepository implements AccountRepository {
  constructor(private readonly sql: PostgresJsSql) {}

  async findById(accountId: string): Promise<Account | null> {
    const rows = await this.sql.unsafe<AccountRow>(
      `SELECT id, primary_email, display_name, status, email_verified_at, created_at, updated_at
       FROM accounts WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [accountId],
    );
    return rows[0] ? mapAccount(rows[0]) : null;
  }

  async findByProvider(issuer: string, subject: string): Promise<Account | null> {
    const rows = await this.sql.unsafe<AccountRow>(
      `SELECT a.id, a.primary_email, a.display_name, a.status, a.email_verified_at, a.created_at, a.updated_at
       FROM provider_identities p
       JOIN accounts a ON a.id = p.account_id
       WHERE p.issuer = $1 AND p.subject = $2 AND a.deleted_at IS NULL
       LIMIT 1`,
      [issuer, subject],
    );
    return rows[0] ? mapAccount(rows[0]) : null;
  }

  async findByEmail(email: string): Promise<Account | null> {
    const rows = await this.sql.unsafe<AccountRow>(
      `SELECT id, primary_email, display_name, status, email_verified_at, created_at, updated_at
       FROM accounts WHERE lower(primary_email) = lower($1) AND deleted_at IS NULL LIMIT 1`,
      [email],
    );
    return rows[0] ? mapAccount(rows[0]) : null;
  }

  async createWithProvider(input: {
    primaryEmail: string;
    displayName: string;
    issuer: string;
    subject: string;
    emailVerifiedAt: Date;
  }): Promise<Account> {
    return withTransaction(this.sql, async (transaction) => {
      const accounts = await transaction.unsafe<AccountRow>(
        `INSERT INTO accounts (primary_email, display_name, email_verified_at, created_at, updated_at)
         VALUES ($1, $2, $3, $3, $3)
         RETURNING id, primary_email, display_name, status, email_verified_at, created_at, updated_at`,
        [input.primaryEmail, input.displayName, input.emailVerifiedAt],
      );
      const account = accounts[0];
      if (!account) throw new Error("Account insert returned no row.");
      await transaction.unsafe(
        `INSERT INTO provider_identities (account_id, issuer, subject, created_at, last_authenticated_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [account.id, input.issuer, input.subject, input.emailVerifiedAt],
      );
      return mapAccount(account);
    });
  }

  async recordProviderAuthentication(input: {
    accountId: string;
    issuer: string;
    subject: string;
    authenticatedAt: Date;
  }): Promise<void> {
    const rows = await this.sql.unsafe<{ id: string }>(
      `UPDATE provider_identities
       SET last_authenticated_at = $4
       WHERE account_id = $1 AND issuer = $2 AND subject = $3
       RETURNING id`,
      [input.accountId, input.issuer, input.subject, input.authenticatedAt],
    );
    if (!rows[0]) throw new Error("Provider identity is not linked to the account.");
  }

  async updateProfile(input: { accountId: string; displayName: string; updatedAt: Date }): Promise<Account> {
    const rows = await this.sql.unsafe<AccountRow>(
      `UPDATE accounts SET display_name = $2, updated_at = $3
       WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
       RETURNING id, primary_email, display_name, status, email_verified_at, created_at, updated_at`,
      [input.accountId, input.displayName, input.updatedAt],
    );
    if (!rows[0]) throw new Error("Active account not found.");
    return mapAccount(rows[0]);
  }
}

type SessionRow = {
  id: string;
  account_id: string;
  secret_hash: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  idle_expires_at: Date | string;
  absolute_expires_at: Date | string;
  revoked_at: Date | string | null;
  provider_session_id: string | null;
  provider_issuer: string | null;
  provider_subject: string | null;
};

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    secretHash: row.secret_hash,
    createdAt: asDate(row.created_at),
    lastSeenAt: asDate(row.last_seen_at),
    idleExpiresAt: asDate(row.idle_expires_at),
    absoluteExpiresAt: asDate(row.absolute_expires_at),
    revokedAt: row.revoked_at ? asDate(row.revoked_at) : null,
    providerIssuer: row.provider_issuer,
    providerSubject: row.provider_subject,
    providerSessionId: row.provider_session_id,
  };
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(
    private readonly sql: PostgresJsSql,
    private readonly maxConcurrentSessions = 5,
  ) {
    if (!Number.isInteger(maxConcurrentSessions) || maxConcurrentSessions < 1 || maxConcurrentSessions > 100) {
      throw new Error("maxConcurrentSessions must be an integer between 1 and 100.");
    }
  }

  async create(session: SessionRecord): Promise<void> {
    await withTransaction(this.sql, async (transaction) => {
      await transaction.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [session.accountId]);
      await transaction.unsafe(
        `UPDATE identity_sessions SET revoked_at = $2
         WHERE account_id = $1 AND revoked_at IS NULL
           AND (idle_expires_at <= $2 OR absolute_expires_at <= $2)`,
        [session.accountId, session.createdAt],
      );
      await transaction.unsafe(
        `UPDATE identity_sessions SET revoked_at = $2
         WHERE id IN (
           SELECT id FROM identity_sessions
           WHERE account_id = $1 AND revoked_at IS NULL
           ORDER BY last_seen_at DESC, created_at DESC, id DESC
           OFFSET $3
         )`,
        [session.accountId, session.createdAt, this.maxConcurrentSessions - 1],
      );
      await transaction.unsafe(
        `INSERT INTO identity_sessions (
          id, account_id, secret_hash, created_at, last_seen_at,
          idle_expires_at, absolute_expires_at, revoked_at,
          provider_issuer, provider_subject, provider_session_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          session.id,
          session.accountId,
          session.secretHash,
          session.createdAt,
          session.lastSeenAt,
          session.idleExpiresAt,
          session.absoluteExpiresAt,
          session.revokedAt,
          session.providerIssuer,
          session.providerSubject,
          session.providerSessionId,
        ],
      );
    });
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const rows = await this.sql.unsafe<SessionRow>(
      `SELECT id, account_id, secret_hash, created_at, last_seen_at, idle_expires_at,
              absolute_expires_at, revoked_at, provider_issuer, provider_subject, provider_session_id
       FROM identity_sessions WHERE id = $1 LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async touch(input: { sessionId: string; lastSeenAt: Date; idleExpiresAt: Date }): Promise<boolean> {
    const rows = await this.sql.unsafe<{ id: string }>(
      `UPDATE identity_sessions
       SET last_seen_at = GREATEST(last_seen_at, $2),
           idle_expires_at = GREATEST(idle_expires_at, LEAST($3, absolute_expires_at))
       WHERE id = $1 AND revoked_at IS NULL
         AND idle_expires_at > $2 AND absolute_expires_at > $2
       RETURNING id`,
      [input.sessionId, input.lastSeenAt, input.idleExpiresAt],
    );
    return Boolean(rows[0]);
  }

  async revoke(sessionId: string, revokedAt: Date): Promise<void> {
    await this.sql.unsafe(`UPDATE identity_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1`, [
      sessionId,
      revokedAt,
    ]);
  }

  async revokeAllForAccount(accountId: string, revokedAt: Date): Promise<void> {
    await this.sql.unsafe(`UPDATE identity_sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL`, [
      accountId,
      revokedAt,
    ]);
  }

  async consumeProviderRevocation(input: import("./types.js").ProviderSessionRevocation) {
    const receipts = await this.sql.unsafe<{ event_id: string }>(
      `INSERT INTO identity_provider_events (
         event_id, provider_issuer, provider_subject, provider_session_id, occurred_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [input.eventId, input.issuer, input.subject, input.providerSessionId, input.occurredAt],
    );
    if (!receipts[0]) return { duplicate: true, revokedSessions: [] };

    const rows = input.providerSessionId
      ? await this.sql.unsafe<{ session_id: string; account_id: string }>(
          `UPDATE identity_sessions
           SET revoked_at = COALESCE(revoked_at, $3)
           WHERE provider_issuer = $1 AND provider_session_id = $2 AND revoked_at IS NULL
           RETURNING id AS session_id, account_id`,
          [input.issuer, input.providerSessionId, input.occurredAt],
        )
      : await this.sql.unsafe<{ session_id: string; account_id: string }>(
          `UPDATE identity_sessions
           SET revoked_at = COALESCE(revoked_at, $3)
           WHERE provider_issuer = $1 AND provider_subject = $2 AND revoked_at IS NULL
           RETURNING id AS session_id, account_id`,
          [input.issuer, input.subject, input.occurredAt],
        );
    return {
      duplicate: false,
      revokedSessions: rows.map((row) => ({ sessionId: row.session_id, accountId: row.account_id })),
    };
  }
}

type OrganisationRow = {
  id: string;
  name: string;
  slug: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type MembershipRow = {
  id: string;
  organisation_id: string;
  account_id: string;
  role: MembershipRole;
  status: MembershipStatus;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapOrganisation(row: OrganisationRow): Organisation {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function mapMembership(row: MembershipRow): OrganisationMembership {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    accountId: row.account_id,
    role: row.role,
    status: row.status,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

const membershipColumns = "id, organisation_id, account_id, role, status, created_at, updated_at";

export class PostgresOrganisationRepository implements OrganisationRepository {
  constructor(private readonly sql: PostgresJsSql) {}

  async createWithOwner(input: { name: string; slug: string; ownerAccountId: string; createdAt: Date }) {
    return withTransaction(this.sql, async (transaction) => {
      const organisations = await transaction.unsafe<OrganisationRow>(
        `INSERT INTO organisations (name, slug, created_at, updated_at)
         VALUES ($1, $2, $3, $3)
         RETURNING id, name, slug, created_at, updated_at`,
        [input.name, input.slug, input.createdAt],
      );
      const organisation = organisations[0];
      if (!organisation) throw new Error("Organisation insert returned no row.");
      const memberships = await transaction.unsafe<MembershipRow>(
        `INSERT INTO organisation_memberships (
           organisation_id, account_id, role, status, created_at, updated_at
         ) VALUES ($1, $2, 'owner', 'active', $3, $3)
         RETURNING ${membershipColumns}`,
        [organisation.id, input.ownerAccountId, input.createdAt],
      );
      if (!memberships[0]) throw new Error("Owner membership insert returned no row.");
      return { organisation: mapOrganisation(organisation), membership: mapMembership(memberships[0]) };
    });
  }

  async findById(organisationId: string): Promise<Organisation | null> {
    const rows = await this.sql.unsafe<OrganisationRow>(
      `SELECT id, name, slug, created_at, updated_at FROM organisations WHERE id = $1 LIMIT 1`,
      [organisationId],
    );
    return rows[0] ? mapOrganisation(rows[0]) : null;
  }

  async listMemberships(organisationId: string): Promise<readonly OrganisationMembership[]> {
    const rows = await this.sql.unsafe<MembershipRow>(
      `SELECT ${membershipColumns} FROM organisation_memberships
       WHERE organisation_id = $1 ORDER BY created_at, id`,
      [organisationId],
    );
    return rows.map(mapMembership);
  }

  async findMembership(organisationId: string, accountId: string): Promise<OrganisationMembership | null> {
    const rows = await this.sql.unsafe<MembershipRow>(
      `SELECT ${membershipColumns} FROM organisation_memberships
       WHERE organisation_id = $1 AND account_id = $2 LIMIT 1`,
      [organisationId, accountId],
    );
    return rows[0] ? mapMembership(rows[0]) : null;
  }

  async upsertMembership(input: {
    organisationId: string;
    accountId: string;
    role: MembershipRole;
    status: MembershipStatus;
    updatedAt: Date;
  }): Promise<OrganisationMembership> {
    return withTransaction(this.sql, async (transaction) => {
      const locked = await transaction.unsafe<{ id: string }>(`SELECT id FROM organisations WHERE id = $1 FOR UPDATE`, [
        input.organisationId,
      ]);
      if (!locked[0]) throw new Error("Organisation not found.");
      const rows = await transaction.unsafe<MembershipRow>(
        `INSERT INTO organisation_memberships (
           organisation_id, account_id, role, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (organisation_id, account_id) DO UPDATE
         SET role = EXCLUDED.role, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
         RETURNING ${membershipColumns}`,
        [input.organisationId, input.accountId, input.role, input.status, input.updatedAt],
      );
      if (!rows[0]) throw new Error("Membership upsert returned no row.");
      return mapMembership(rows[0]);
    });
  }
}

export class PostgresMembershipAuditPort implements MembershipAuditPort {
  private readonly writer: AuditWriter;

  constructor(sql: PostgresJsSql) {
    this.writer = new AuditWriter(new PostgresAuditRepository(new PostgresJsQueryAdapter(sql)));
  }

  async record(input: Parameters<MembershipAuditPort["record"]>[0]): Promise<void> {
    await this.writer.write({
      requestId: input.requestId,
      actorAccountId: input.actorAccountId,
      actorType: "account",
      organisationId: input.organisationId,
      action: input.action,
      targetType: input.action === "organisation.created" ? "organisation" : "organisation_membership",
      targetId: input.targetId,
      reason: null,
      beforeState: input.beforeState,
      afterState: input.afterState,
      metadata: {},
      occurredAt: input.occurredAt,
    });
  }
}

export class PostgresOrganisationUnitOfWork implements OrganisationUnitOfWork {
  constructor(private readonly sql: PostgresJsSql) {}

  async run<T>(
    operation: (ports: { organisations: OrganisationRepository; audit: MembershipAuditPort }) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.sql, async (transaction) =>
      operation({
        organisations: new PostgresOrganisationRepository(transaction),
        audit: new PostgresMembershipAuditPort(transaction),
      }),
    );
  }
}

export class PostgresRecoveryRequestRepository implements RecoveryRequestRepository {
  constructor(private readonly sql: PostgresJsSql) {}

  async create(record: RecoveryRequestRecord): Promise<void> {
    await this.sql.unsafe(
      `INSERT INTO identity_recovery_requests (
         id, identifier_hash, provider_issuer, requested_at, expires_at, consumed_at, revoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.id,
        record.identifierHash,
        record.providerIssuer,
        record.requestedAt,
        record.expiresAt,
        record.consumedAt,
        record.revokedAt,
      ],
    );
  }

  async consume(requestId: string, consumedAt: Date): Promise<boolean> {
    const rows = await this.sql.unsafe<{ id: string }>(
      `UPDATE identity_recovery_requests SET consumed_at = $2
       WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2
       RETURNING id`,
      [requestId, consumedAt],
    );
    return Boolean(rows[0]);
  }

  async revoke(requestId: string, revokedAt: Date): Promise<void> {
    await this.sql.unsafe(
      `UPDATE identity_recovery_requests SET revoked_at = $2
       WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [requestId, revokedAt],
    );
  }
}

export interface PrincipalRepository {
  load(accountId: string, now: Date): Promise<Principal | null>;
}

export class PostgresPrincipalRepository implements PrincipalRepository {
  constructor(private readonly sql: PostgresJsSql) {}

  async load(accountId: string, now: Date): Promise<Principal | null> {
    const accounts = await this.sql.unsafe<{ id: string }>(
      `SELECT id FROM accounts WHERE id = $1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
      [accountId],
    );
    if (!accounts[0]) return null;
    const [memberships, grants, roles] = await Promise.all([
      this.sql.unsafe<{ organisation_id: string; role: MembershipRole; status: MembershipStatus }>(
        `SELECT organisation_id, role, status FROM organisation_memberships WHERE account_id = $1`,
        [accountId],
      ),
      this.sql.unsafe<{
        organisation_id: string;
        resource_type: "competition" | "match";
        resource_id: string;
      }>(
        `SELECT organisation_id, resource_type, resource_id FROM official_grants
         WHERE account_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
        [accountId, now],
      ),
      this.sql.unsafe<{ role: "platform_admin" }>(
        `SELECT role FROM account_platform_roles
         WHERE account_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
        [accountId, now],
      ),
    ]);
    return {
      accountId,
      platformRoles: roles.map((row) => row.role),
      memberships: memberships.map((row) => ({
        organisationId: row.organisation_id,
        role: row.role,
        status: row.status,
      })),
      officialGrants: grants.map((row) => ({
        kind: row.resource_type,
        resourceId: row.resource_id,
        organisationId: row.organisation_id,
        status: "active" as const,
      })),
    };
  }
}

export class PostgresJsQueryAdapter implements PostgresQueryPort {
  constructor(private readonly sql: PostgresJsSql) {}

  async query<T>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }> {
    const rows = await this.sql.unsafe<T>(text, values);
    return { rows: [...rows] };
  }
}
