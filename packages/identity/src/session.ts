import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { IdentityError } from "./errors.js";
import type {
  Account,
  AccountRepository,
  AuthenticatedSession,
  Clock,
  OpaqueTokenGenerator,
  SessionRecord,
  SessionRepository,
} from "./types.js";

const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export const systemClock: Clock = { now: () => new Date() };

export const secureOpaqueTokenGenerator: OpaqueTokenGenerator = {
  sessionId: () => randomUUID(),
  secret: () => randomBytes(32).toString("base64url"),
};

export function hashSessionSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secretsMatch(actualSecret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSessionSecret(actualSecret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseSessionToken(token: string): { id: string; secret: string } {
  const separator = token.indexOf(".");
  if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) {
    throw new IdentityError("INVALID_SESSION", "The session token is invalid.");
  }
  const id = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!SESSION_ID_PATTERN.test(id) || !SECRET_PATTERN.test(secret)) {
    throw new IdentityError("INVALID_SESSION", "The session token is invalid.");
  }
  return { id, secret };
}

export type SessionPolicy = {
  idleTtlMs: number;
  absoluteTtlMs: number;
};

export const defaultSessionPolicy: SessionPolicy = {
  idleTtlMs: 30 * 60 * 1000,
  absoluteTtlMs: 12 * 60 * 60 * 1000,
};

export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly accounts: AccountRepository,
    private readonly clock: Clock = systemClock,
    private readonly tokens: OpaqueTokenGenerator = secureOpaqueTokenGenerator,
    private readonly policy: SessionPolicy = defaultSessionPolicy,
  ) {
    if (policy.idleTtlMs <= 0 || policy.absoluteTtlMs < policy.idleTtlMs) {
      throw new Error("Session policy must have a positive idle TTL no longer than its absolute TTL.");
    }
  }

  async issue(
    account: Account,
    provider: { issuer: string; subject: string; providerSessionId: string | null } | null = null,
  ) {
    const now = this.clock.now();
    const id = this.tokens.sessionId();
    const secret = this.tokens.secret();
    const session: SessionRecord = {
      id,
      accountId: account.id,
      secretHash: hashSessionSecret(secret),
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + this.policy.idleTtlMs),
      absoluteExpiresAt: new Date(now.getTime() + this.policy.absoluteTtlMs),
      revokedAt: null,
      providerIssuer: provider?.issuer ?? null,
      providerSubject: provider?.subject ?? null,
      providerSessionId: provider?.providerSessionId ?? null,
    };
    await this.sessions.create(session);
    return {
      sessionToken: `${id}.${secret}`,
      sessionId: id,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  async authenticate(token: string): Promise<AuthenticatedSession> {
    const parsed = parseSessionToken(token);
    const session = await this.sessions.findById(parsed.id);
    if (!session || !secretsMatch(parsed.secret, session.secretHash)) {
      throw new IdentityError("INVALID_SESSION", "The session token is invalid.");
    }
    if (session.revokedAt) {
      throw new IdentityError("SESSION_REVOKED", "The session has been revoked.");
    }
    const now = this.clock.now();
    if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
      await this.sessions.revoke(session.id, now);
      throw new IdentityError("SESSION_EXPIRED", "The session has expired.");
    }
    const account = await this.accounts.findById(session.accountId);
    if (!account || account.status !== "active") {
      await this.sessions.revoke(session.id, now);
      throw new IdentityError("ACCOUNT_INACTIVE", "The account is not active.");
    }
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + this.policy.idleTtlMs, session.absoluteExpiresAt.getTime()),
    );
    const touched = await this.sessions.touch({ sessionId: session.id, lastSeenAt: now, idleExpiresAt });
    if (!touched) throw new IdentityError("SESSION_REVOKED", "The session has been revoked.");
    return { account, sessionId: session.id, idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt };
  }

  async signOut(token: string): Promise<void> {
    const parsed = parseSessionToken(token);
    const session = await this.sessions.findById(parsed.id);
    if (session && secretsMatch(parsed.secret, session.secretHash) && !session.revokedAt) {
      await this.sessions.revoke(session.id, this.clock.now());
    }
  }

  async revokeAccountSessions(accountId: string): Promise<void> {
    await this.sessions.revokeAllForAccount(accountId, this.clock.now());
  }
}
