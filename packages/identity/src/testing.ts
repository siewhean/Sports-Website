import type { AuditAppendPort, AuditEvent, AuditQuery, AuditReadPort } from "./audit.js";
import type {
  MembershipAuditPort,
  MembershipRole,
  MembershipStatus,
  Organisation,
  OrganisationMembership,
  OrganisationRepository,
  OrganisationUnitOfWork,
} from "./membership.js";
import type {
  Account,
  AccountRepository,
  IdentityProviderPort,
  OpaqueTokenGenerator,
  ProviderClaims,
  ProviderSignInRequest,
  SessionRecord,
  SessionRepository,
} from "./types.js";

const baseTime = new Date("2026-01-01T00:00:00.000Z");

export class DeterministicIdentityProvider implements IdentityProviderPort {
  readonly recoveryRequests: { email: string; redirectUri: string }[] = [];
  readonly signInRequests: ProviderSignInRequest[] = [];
  readonly authorizationRequests: import("./types.js").ProviderAuthorizationRequest[] = [];
  recoveryError: Error | null = null;

  constructor(public claims: ProviderClaims) {}

  async createAuthorizationUrl(request: import("./types.js").ProviderAuthorizationRequest): Promise<string> {
    this.authorizationRequests.push(request);
    const url = new URL("https://identity.example.test/authorize");
    url.searchParams.set("state", request.state);
    url.searchParams.set("nonce", request.nonce);
    url.searchParams.set("code_challenge", request.pkceChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (request.prompt) url.searchParams.set("prompt", request.prompt);
    return url.href;
  }

  async exchangeAuthorizationCode(request: ProviderSignInRequest): Promise<ProviderClaims> {
    this.signInRequests.push(request);
    return this.claims;
  }

  async requestRecovery(email: string, redirectUri: string): Promise<void> {
    this.recoveryRequests.push({ email, redirectUri });
    if (this.recoveryError) throw this.recoveryError;
  }
}

export class DeterministicOpaqueTokenGenerator implements OpaqueTokenGenerator {
  private sequence = 0;

  sessionId(): string {
    this.sequence += 1;
    return `00000000-0000-4000-8000-${this.sequence.toString().padStart(12, "0")}`;
  }

  secret(): string {
    return `deterministic-session-secret-${this.sequence.toString().padStart(8, "0")}`;
  }
}

export class InMemoryAccountRepository implements AccountRepository {
  readonly accounts = new Map<string, Account>();
  readonly providerAccounts = new Map<string, string>();
  readonly authentications: { accountId: string; issuer: string; subject: string; authenticatedAt: Date }[] = [];
  private sequence = 0;

  seed(account: Account, provider?: { issuer: string; subject: string }): void {
    this.accounts.set(account.id, account);
    if (provider) this.providerAccounts.set(`${provider.issuer}\u0000${provider.subject}`, account.id);
  }

  async findById(accountId: string): Promise<Account | null> {
    return this.accounts.get(accountId) ?? null;
  }

  async findByProvider(issuer: string, subject: string): Promise<Account | null> {
    const id = this.providerAccounts.get(`${issuer}\u0000${subject}`);
    return id ? (this.accounts.get(id) ?? null) : null;
  }

  async findByEmail(email: string): Promise<Account | null> {
    return (
      [...this.accounts.values()].find(
        (account) => account.primaryEmail.toLowerCase() === email.toLowerCase() && account.status !== "deleted",
      ) ?? null
    );
  }

  async createWithProvider(input: {
    primaryEmail: string;
    displayName: string;
    issuer: string;
    subject: string;
    emailVerifiedAt: Date;
  }): Promise<Account> {
    this.sequence += 1;
    const account: Account = {
      id: `account-${this.sequence}`,
      primaryEmail: input.primaryEmail,
      displayName: input.displayName,
      status: "active",
      emailVerifiedAt: input.emailVerifiedAt,
      createdAt: input.emailVerifiedAt,
      updatedAt: input.emailVerifiedAt,
    };
    this.accounts.set(account.id, account);
    this.providerAccounts.set(`${input.issuer}\u0000${input.subject}`, account.id);
    return account;
  }

  async recordProviderAuthentication(input: {
    accountId: string;
    issuer: string;
    subject: string;
    authenticatedAt: Date;
  }): Promise<void> {
    this.authentications.push(input);
  }

  async updateProfile(input: { accountId: string; displayName: string; updatedAt: Date }): Promise<Account> {
    const account = this.accounts.get(input.accountId);
    if (!account) throw new Error("Account not found.");
    const updated = { ...account, displayName: input.displayName, updatedAt: input.updatedAt };
    this.accounts.set(updated.id, updated);
    return updated;
  }
}

export class InMemorySessionRepository implements SessionRepository {
  readonly sessions = new Map<string, SessionRecord>();
  readonly providerEventIds = new Set<string>();

  async create(session: SessionRecord): Promise<void> {
    if (this.sessions.has(session.id)) throw new Error("Duplicate session id.");
    this.sessions.set(session.id, { ...session });
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async touch(input: { sessionId: string; lastSeenAt: Date; idleExpiresAt: Date }): Promise<boolean> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.revokedAt) return false;
    this.sessions.set(session.id, { ...session, ...input });
    return true;
  }

  async revoke(sessionId: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) this.sessions.set(session.id, { ...session, revokedAt });
  }

  async revokeAllForAccount(accountId: string, revokedAt: Date): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.accountId === accountId && !session.revokedAt) {
        this.sessions.set(session.id, { ...session, revokedAt });
      }
    }
  }

  async consumeProviderRevocation(input: import("./types.js").ProviderSessionRevocation) {
    if (this.providerEventIds.has(input.eventId)) return { duplicate: true, revokedSessions: [] };
    this.providerEventIds.add(input.eventId);
    const revokedSessions: { sessionId: string; accountId: string }[] = [];
    for (const session of this.sessions.values()) {
      const matches =
        session.providerIssuer === input.issuer &&
        (input.providerSessionId
          ? session.providerSessionId === input.providerSessionId
          : session.providerSubject === input.subject);
      if (matches && !session.revokedAt) {
        this.sessions.set(session.id, { ...session, revokedAt: input.occurredAt });
        revokedSessions.push({ sessionId: session.id, accountId: session.accountId });
      }
    }
    return { duplicate: false, revokedSessions };
  }
}

export class InMemoryOrganisationRepository implements OrganisationRepository {
  readonly organisations = new Map<string, Organisation>();
  readonly memberships = new Map<string, OrganisationMembership>();
  private organisationSequence = 0;
  private membershipSequence = 0;

  async createWithOwner(input: { name: string; slug: string; ownerAccountId: string; createdAt: Date }) {
    this.organisationSequence += 1;
    const organisation: Organisation = {
      id: `organisation-${this.organisationSequence}`,
      name: input.name,
      slug: input.slug,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    const membership = this.buildMembership(organisation.id, input.ownerAccountId, "owner", "active", input.createdAt);
    this.organisations.set(organisation.id, organisation);
    this.memberships.set(membership.id, membership);
    return { organisation, membership };
  }

  async findById(organisationId: string) {
    return this.organisations.get(organisationId) ?? null;
  }

  async listMemberships(organisationId: string) {
    return [...this.memberships.values()].filter((item) => item.organisationId === organisationId);
  }

  async findMembership(organisationId: string, accountId: string) {
    return (
      [...this.memberships.values()].find(
        (item) => item.organisationId === organisationId && item.accountId === accountId,
      ) ?? null
    );
  }

  async upsertMembership(input: {
    organisationId: string;
    accountId: string;
    role: MembershipRole;
    status: MembershipStatus;
    updatedAt: Date;
  }) {
    const existing = await this.findMembership(input.organisationId, input.accountId);
    const membership = existing
      ? { ...existing, role: input.role, status: input.status, updatedAt: input.updatedAt }
      : this.buildMembership(input.organisationId, input.accountId, input.role, input.status, input.updatedAt);
    this.memberships.set(membership.id, membership);
    return membership;
  }

  private buildMembership(
    organisationId: string,
    accountId: string,
    role: MembershipRole,
    status: MembershipStatus,
    at: Date,
  ): OrganisationMembership {
    this.membershipSequence += 1;
    return {
      id: `membership-${this.membershipSequence}`,
      organisationId,
      accountId,
      role,
      status,
      createdAt: at,
      updatedAt: at,
    };
  }
}

export class InMemoryMembershipAudit implements MembershipAuditPort {
  readonly records: Parameters<MembershipAuditPort["record"]>[0][] = [];
  async record(input: Parameters<MembershipAuditPort["record"]>[0]): Promise<void> {
    this.records.push(input);
  }
}

export class InMemoryOrganisationUnitOfWork implements OrganisationUnitOfWork {
  constructor(
    readonly organisations = new InMemoryOrganisationRepository(),
    readonly audit = new InMemoryMembershipAudit(),
  ) {}

  async run<T>(
    operation: (ports: { organisations: OrganisationRepository; audit: MembershipAuditPort }) => Promise<T>,
  ): Promise<T> {
    return operation({ organisations: this.organisations, audit: this.audit });
  }
}

export class InMemoryAuditRepository implements AuditAppendPort, AuditReadPort {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  async list(query: Required<Pick<AuditQuery, "organisationId" | "limit">> & Omit<AuditQuery, "limit">) {
    return this.events
      .filter((event) => event.organisationId === query.organisationId)
      .filter((event) => !query.targetType || event.targetType === query.targetType)
      .filter((event) => !query.targetId || event.targetId === query.targetId)
      .filter((event) => !query.actorAccountId || event.actorAccountId === query.actorAccountId)
      .filter((event) => !query.action || event.action === query.action)
      .filter(
        (event) =>
          !query.before ||
          event.occurredAt < query.before.occurredAt ||
          (event.occurredAt.getTime() === query.before.occurredAt.getTime() && event.id < query.before.id),
      )
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id))
      .slice(0, query.limit);
  }
}

export const deterministicAccount = (overrides: Partial<Account> = {}): Account => ({
  id: "account-1",
  primaryEmail: "organiser@example.test",
  displayName: "Test Organiser",
  status: "active",
  emailVerifiedAt: baseTime,
  createdAt: baseTime,
  updatedAt: baseTime,
  ...overrides,
});
