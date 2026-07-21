import { createHmac, timingSafeEqual } from "node:crypto";
import {
  IdentityError,
  IdentityService,
  SessionService,
  AuditWriter,
  normalizeDisplayName,
  type Account,
  type AccountRepository,
  type AuditAppendPort,
  type Clock,
  type IdentityProviderPort,
  type ProviderClaims,
  type ProviderAuthorizationRequest,
  type ProviderSignInRequest,
  type SessionRepository,
  type ProviderSessionRevocation,
} from "@matchday/identity";

export class IdentityProviderUnavailableError extends Error {
  readonly code = "IDENTITY_PROVIDER_UNAVAILABLE" as const;

  constructor() {
    super("Identity provider is unavailable.");
    this.name = "IdentityProviderUnavailableError";
  }
}

export class UnavailableIdentityProvider implements IdentityProviderPort {
  async exchangeAuthorizationCode(): Promise<never> {
    throw new IdentityProviderUnavailableError();
  }

  async requestRecovery(): Promise<never> {
    throw new IdentityProviderUnavailableError();
  }
}

export interface IdentityPersistencePorts {
  accounts: AccountRepository;
  sessions: SessionRepository;
  audit: AuditAppendPort;
}

export interface IdentityPersistenceUnitOfWork {
  run<T>(operation: (ports: IdentityPersistencePorts) => Promise<T>): Promise<T>;
}

export type IdentityApiSession = {
  account: Account;
  sessionId: string;
  sessionToken: string;
  csrfToken: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
};

export type AuthenticatedIdentityApiSession = Omit<IdentityApiSession, "sessionToken"> & {
  sessionToken: string;
};

export class IdentityApiRuntime {
  readonly #clock: Clock;
  readonly #csrfSecret: string;
  readonly #provider: IdentityProviderPort;
  readonly #unitOfWork: IdentityPersistenceUnitOfWork;

  constructor(
    provider: IdentityProviderPort,
    unitOfWork: IdentityPersistenceUnitOfWork,
    csrfSecret: string,
    clock: Clock,
  ) {
    if (Buffer.byteLength(csrfSecret, "utf8") < 32) throw new Error("CSRF HMAC secret must be at least 32 bytes.");
    this.#provider = provider;
    this.#unitOfWork = unitOfWork;
    this.#csrfSecret = csrfSecret;
    this.#clock = clock;
  }

  async createAuthorizationUrl(request: ProviderAuthorizationRequest): Promise<string> {
    if (!this.#provider.createAuthorizationUrl) throw new IdentityProviderUnavailableError();
    try {
      return await this.#provider.createAuthorizationUrl(request);
    } catch (error) {
      if (error instanceof IdentityError || error instanceof IdentityProviderUnavailableError) throw error;
      throw new IdentityProviderUnavailableError();
    }
  }

  async signIn(request: ProviderSignInRequest, requestId: string): Promise<IdentityApiSession> {
    let claims: ProviderClaims;
    try {
      claims = await this.#provider.exchangeAuthorizationCode(request);
    } catch (error) {
      if (error instanceof IdentityError || error instanceof IdentityProviderUnavailableError) throw error;
      throw new IdentityProviderUnavailableError();
    }
    return this.#unitOfWork.run(async (ports) => {
      const sessions = new SessionService(ports.sessions, ports.accounts, this.#clock);
      const identity = new IdentityService(new FixedClaimsProvider(claims), ports.accounts, sessions, this.#clock);
      const result = await identity.signIn(request);
      await new AuditWriter(ports.audit).write({
        requestId,
        actorAccountId: result.account.id,
        actorType: "account",
        organisationId: null,
        action: "identity.session.created",
        targetType: "identity_session",
        targetId: result.sessionId,
        reason: null,
        beforeState: null,
        afterState: { sessionId: result.sessionId },
        metadata: { newAccount: result.isNewAccount },
        occurredAt: this.#clock.now(),
      });
      return { ...result, csrfToken: this.deriveCsrfToken(result.sessionToken) };
    });
  }

  async requestRecovery(email: string, redirectUri: string, requestId: string): Promise<{ accepted: true }> {
    try {
      await this.#provider.requestRecovery(email.trim().toLowerCase(), redirectUri);
    } catch {
      // The public response and audit shape are deliberately invariant to provider outcome and account existence.
    }
    await this.#unitOfWork.run(async (ports) => {
      await new AuditWriter(ports.audit).write({
        requestId,
        actorAccountId: null,
        actorType: "system",
        organisationId: null,
        action: "identity.recovery.requested",
        targetType: "identity_recovery",
        targetId: "provider_recovery_request",
        reason: null,
        beforeState: null,
        afterState: { accepted: true },
        metadata: {},
        occurredAt: this.#clock.now(),
      });
    });
    return { accepted: true };
  }

  async authenticate(sessionToken: string, requestId: string): Promise<AuthenticatedIdentityApiSession> {
    const outcome = await this.#unitOfWork.run(async (ports) => {
      try {
        const session = await new SessionService(ports.sessions, ports.accounts, this.#clock).authenticate(
          sessionToken,
        );
        return { session, error: null };
      } catch (error) {
        if (error instanceof IdentityError && (error.code === "SESSION_EXPIRED" || error.code === "ACCOUNT_INACTIVE")) {
          const sessionId = sessionToken.split(".", 1)[0] ?? "unknown_session";
          await new AuditWriter(ports.audit).write({
            requestId,
            actorAccountId: null,
            actorType: "system",
            organisationId: null,
            action: "identity.session.revoked",
            targetType: "identity_session",
            targetId: sessionId,
            reason: error.code === "SESSION_EXPIRED" ? "expired" : "account_inactive",
            beforeState: { revoked: false },
            afterState: { revoked: true },
            metadata: {},
            occurredAt: this.#clock.now(),
          });
          return { session: null, error };
        }
        throw error;
      }
    });
    if (outcome.error) throw outcome.error;
    if (!outcome.session) throw new IdentityError("INVALID_SESSION", "The session token is invalid.");
    return { ...outcome.session, sessionToken, csrfToken: this.deriveCsrfToken(sessionToken) };
  }

  async updateProfile(session: AuthenticatedIdentityApiSession, displayName: string, requestId: string) {
    return this.#unitOfWork.run(async (ports) => {
      const accounts = ports.accounts;
      const before = await accounts.findById(session.account.id);
      if (!before) throw new IdentityError("ACCOUNT_INACTIVE", "The account is not active.");
      const occurredAt = this.#clock.now();
      const updated = await accounts.updateProfile({
        accountId: session.account.id,
        displayName: normalizeDisplayName(displayName),
        updatedAt: occurredAt,
      });
      await new AuditWriter(ports.audit).write({
        requestId,
        actorAccountId: session.account.id,
        actorType: "account",
        organisationId: null,
        action: "account.profile.updated",
        targetType: "account",
        targetId: session.account.id,
        reason: null,
        beforeState: { displayName: before.displayName },
        afterState: { displayName: updated.displayName },
        metadata: {},
        occurredAt,
      });
      return updated;
    });
  }

  async signOut(session: AuthenticatedIdentityApiSession, requestId: string): Promise<void> {
    await this.#unitOfWork.run(async (ports) => {
      const sessions = new SessionService(ports.sessions, ports.accounts, this.#clock);
      const current = await sessions.authenticate(session.sessionToken);
      await sessions.signOut(session.sessionToken);
      await new AuditWriter(ports.audit).write({
        requestId,
        actorAccountId: current.account.id,
        actorType: "account",
        organisationId: null,
        action: "identity.session.revoked",
        targetType: "identity_session",
        targetId: current.sessionId,
        reason: "sign_out",
        beforeState: { revoked: false },
        afterState: { revoked: true },
        metadata: {},
        occurredAt: this.#clock.now(),
      });
    });
  }

  async revokeProviderSessions(
    input: ProviderSessionRevocation & { reason: "provider_password_changed" | "provider_session_revoked" },
    requestId: string,
  ): Promise<{ duplicate: boolean; revokedCount: number }> {
    return this.#unitOfWork.run(async (ports) => {
      const result = await ports.sessions.consumeProviderRevocation(input);
      if (result.duplicate) return { duplicate: true, revokedCount: 0 };
      const audit = new AuditWriter(ports.audit);
      for (const session of result.revokedSessions) {
        await audit.write({
          requestId,
          actorAccountId: null,
          actorType: "system",
          organisationId: null,
          action: "identity.session.revoked",
          targetType: "identity_session",
          targetId: session.sessionId,
          reason: input.reason,
          beforeState: { revoked: false },
          afterState: { revoked: true },
          metadata: { providerEventId: input.eventId, providerIssuer: input.issuer },
          occurredAt: this.#clock.now(),
        });
      }
      await audit.write({
        requestId,
        actorAccountId: null,
        actorType: "system",
        organisationId: null,
        action: "identity.provider_event.processed",
        targetType: "identity_provider_event",
        targetId: input.eventId,
        reason: input.reason,
        beforeState: null,
        afterState: { revokedSessionCount: result.revokedSessions.length },
        metadata: { providerIssuer: input.issuer },
        occurredAt: this.#clock.now(),
      });
      return { duplicate: false, revokedCount: result.revokedSessions.length };
    });
  }

  verifyCsrfToken(sessionToken: string, supplied: string): boolean {
    const expected = Buffer.from(this.deriveCsrfToken(sessionToken), "utf8");
    const actual = Buffer.from(supplied, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private deriveCsrfToken(sessionToken: string): string {
    const separator = sessionToken.indexOf(".");
    const sessionId = separator > 0 ? sessionToken.slice(0, separator) : sessionToken;
    return createHmac("sha256", this.#csrfSecret).update(`matchday-csrf-v1:${sessionId}`, "utf8").digest("base64url");
  }
}

class FixedClaimsProvider implements IdentityProviderPort {
  constructor(private readonly claims: ProviderClaims) {}

  async exchangeAuthorizationCode(): Promise<ProviderClaims> {
    return this.claims;
  }

  async requestRecovery(): Promise<void> {
    throw new Error("Recovery is not available through the fixed-claims adapter.");
  }
}
