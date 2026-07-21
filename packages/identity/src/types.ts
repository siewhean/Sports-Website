export type AccountStatus = "active" | "locked" | "deleted";

export type Account = {
  id: string;
  primaryEmail: string;
  displayName: string;
  status: AccountStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProviderIdentity = {
  accountId: string;
  issuer: string;
  subject: string;
  lastAuthenticatedAt: Date | null;
};

export type ProviderClaims = {
  issuer: string;
  subject: string;
  providerSessionId: string | null;
  email: string;
  emailVerified: boolean;
  displayName: string;
};

export type ProviderSignInRequest = {
  authorizationCode: string;
  redirectUri: string;
  pkceVerifier: string;
  authorizationResponseState?: string;
  expectedState?: string;
  expectedNonce?: string;
};

export type ProviderAuthorizationRequest = {
  redirectUri: string;
  state: string;
  nonce: string;
  pkceChallenge: string;
};

export interface IdentityProviderPort {
  createAuthorizationUrl?(request: ProviderAuthorizationRequest): Promise<string>;
  exchangeAuthorizationCode(request: ProviderSignInRequest): Promise<ProviderClaims>;
  requestRecovery(email: string, redirectUri: string): Promise<void>;
  revokeProviderSession?(providerSessionId: string): Promise<void>;
}

export interface AccountRepository {
  findById(accountId: string): Promise<Account | null>;
  findByProvider(issuer: string, subject: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  createWithProvider(input: {
    primaryEmail: string;
    displayName: string;
    issuer: string;
    subject: string;
    emailVerifiedAt: Date;
  }): Promise<Account>;
  recordProviderAuthentication(input: {
    accountId: string;
    issuer: string;
    subject: string;
    authenticatedAt: Date;
  }): Promise<void>;
  updateProfile(input: { accountId: string; displayName: string; updatedAt: Date }): Promise<Account>;
}

export type SessionRecord = {
  id: string;
  accountId: string;
  secretHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  providerIssuer: string | null;
  providerSubject: string | null;
  providerSessionId: string | null;
};

export type ProviderSessionRevocation = {
  eventId: string;
  issuer: string;
  subject: string | null;
  providerSessionId: string | null;
  occurredAt: Date;
};

export type ProviderSessionRevocationResult = {
  duplicate: boolean;
  revokedSessions: readonly { sessionId: string; accountId: string }[];
};

export interface SessionRepository {
  create(session: SessionRecord): Promise<void>;
  findById(sessionId: string): Promise<SessionRecord | null>;
  touch(input: { sessionId: string; lastSeenAt: Date; idleExpiresAt: Date }): Promise<boolean>;
  revoke(sessionId: string, revokedAt: Date): Promise<void>;
  revokeAllForAccount(accountId: string, revokedAt: Date): Promise<void>;
  consumeProviderRevocation(input: ProviderSessionRevocation): Promise<ProviderSessionRevocationResult>;
}

export type RecoveryRequestRecord = {
  id: string;
  identifierHash: string;
  providerIssuer: string;
  requestedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
};

export interface RecoveryRequestRepository {
  create(record: RecoveryRequestRecord): Promise<void>;
  consume(requestId: string, consumedAt: Date): Promise<boolean>;
  revoke(requestId: string, revokedAt: Date): Promise<void>;
}

export interface OpaqueTokenGenerator {
  sessionId(): string;
  secret(): string;
}

export interface Clock {
  now(): Date;
}

export type AuthenticatedSession = {
  account: Account;
  sessionId: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
};

export type SignInResult = AuthenticatedSession & {
  sessionToken: string;
  isNewAccount: boolean;
};
