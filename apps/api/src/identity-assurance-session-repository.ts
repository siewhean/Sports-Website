import {
  PostgresSessionRepository,
  type AuthenticationAssurance,
  type PostgresJsSql,
  type ProviderSessionRevocation,
  type ProviderSessionRevocationResult,
  type SessionRecord,
  type SessionRepository,
} from "@matchday/identity";

type AssuranceRow = {
  assurance_level: AuthenticationAssurance["level"];
  authentication_methods: string[];
  acr: string | null;
  authenticated_at: Date | string | null;
  mfa_performed: boolean;
  phishing_resistant: boolean;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapAssurance(row: AssuranceRow): AuthenticationAssurance {
  return {
    level: row.assurance_level,
    methods: [...row.authentication_methods],
    acr: row.acr,
    authenticatedAt: row.authenticated_at ? asDate(row.authenticated_at) : null,
    mfaPerformed: row.mfa_performed,
    phishingResistant: row.phishing_resistant,
  };
}

/**
 * Persists authentication assurance alongside the existing identity session
 * without widening the legacy session repository's SQL surface. Both writes
 * run in the same identity transaction supplied by PostgresIdentityUnitOfWork.
 */
export class PostgresAssuranceSessionRepository implements SessionRepository {
  readonly #sessions: PostgresSessionRepository;

  constructor(private readonly sql: PostgresJsSql) {
    this.#sessions = new PostgresSessionRepository(sql);
  }

  async create(session: SessionRecord): Promise<void> {
    await this.#sessions.create(session);
    if (!session.assurance) return;
    await this.sql.unsafe(
      `INSERT INTO identity_session_assurance (
         session_id, assurance_level, authentication_methods, acr, authenticated_at,
         mfa_performed, phishing_resistant
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        session.id,
        session.assurance.level,
        [...session.assurance.methods],
        session.assurance.acr,
        session.assurance.authenticatedAt,
        session.assurance.mfaPerformed,
        session.assurance.phishingResistant,
      ],
    );
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const session = await this.#sessions.findById(sessionId);
    if (!session) return null;
    const rows = await this.sql.unsafe<AssuranceRow>(
      `SELECT assurance_level, authentication_methods, acr, authenticated_at,
              mfa_performed, phishing_resistant
       FROM identity_session_assurance
       WHERE session_id = $1
       LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? { ...session, assurance: mapAssurance(rows[0]) } : session;
  }

  touch(input: { sessionId: string; lastSeenAt: Date; idleExpiresAt: Date }): Promise<boolean> {
    return this.#sessions.touch(input);
  }

  revoke(sessionId: string, revokedAt: Date): Promise<void> {
    return this.#sessions.revoke(sessionId, revokedAt);
  }

  revokeAllForAccount(accountId: string, revokedAt: Date): Promise<void> {
    return this.#sessions.revokeAllForAccount(accountId, revokedAt);
  }

  consumeProviderRevocation(input: ProviderSessionRevocation): Promise<ProviderSessionRevocationResult> {
    return this.#sessions.consumeProviderRevocation(input);
  }
}
