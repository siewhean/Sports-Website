import { authenticationAssuranceFromProvider } from "./assurance.js";
import { IdentityError } from "./errors.js";
import { SessionService } from "./session.js";
import type { AccountRepository, Clock, IdentityProviderPort, ProviderSignInRequest, SignInResult } from "./types.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new IdentityError("AUTHENTICATION_FAILED", "Authentication could not be completed.");
  }
  return normalized;
}

export function normalizeDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new IdentityError("INVALID_PROFILE", "Display name must be between 1 and 100 characters.");
  }
  return normalized;
}

export class IdentityService {
  constructor(
    private readonly provider: IdentityProviderPort,
    private readonly accounts: AccountRepository,
    private readonly sessions: SessionService,
    private readonly clock: Clock,
  ) {}

  async signIn(request: ProviderSignInRequest): Promise<SignInResult> {
    const claims = await this.provider.exchangeAuthorizationCode(request);
    if (!claims.issuer || !claims.subject) {
      throw new IdentityError("AUTHENTICATION_FAILED", "Authentication could not be completed.");
    }
    const assurance = authenticationAssuranceFromProvider(claims.assurance);

    const existing = await this.accounts.findByProvider(claims.issuer, claims.subject);
    if (existing) {
      if (existing.status !== "active") {
        throw new IdentityError("ACCOUNT_INACTIVE", "The account is not active.");
      }
      await this.accounts.recordProviderAuthentication({
        accountId: existing.id,
        issuer: claims.issuer,
        subject: claims.subject,
        authenticatedAt: this.clock.now(),
      });
      const issued = await this.sessions.issue(existing, {
        issuer: claims.issuer,
        subject: claims.subject,
        providerSessionId: claims.providerSessionId,
        assurance,
      });
      return { account: existing, ...issued, isNewAccount: false };
    }

    if (!claims.emailVerified) {
      throw new IdentityError("EMAIL_NOT_VERIFIED", "A verified email address is required.");
    }
    const email = normalizeEmail(claims.email);
    // Never link identities using email alone. Linking requires a separately authenticated account flow.
    if (await this.accounts.findByEmail(email)) {
      throw new IdentityError(
        "ACCOUNT_LINKING_REQUIRED",
        "Sign in to the existing account before linking another identity provider.",
      );
    }
    const account = await this.accounts.createWithProvider({
      primaryEmail: email,
      displayName: normalizeDisplayName(claims.displayName),
      issuer: claims.issuer,
      subject: claims.subject,
      emailVerifiedAt: this.clock.now(),
    });
    const issued = await this.sessions.issue(account, {
      issuer: claims.issuer,
      subject: claims.subject,
      providerSessionId: claims.providerSessionId,
      assurance,
    });
    return { account, ...issued, isNewAccount: true };
  }

  async requestRecovery(email: string, redirectUri: string): Promise<{ accepted: true }> {
    // The response is deliberately invariant to avoid revealing whether an account exists.
    try {
      await this.provider.requestRecovery(normalizeEmail(email), redirectUri);
    } catch {
      // Delivery failures are observed by the provider integration and never change the public response.
    }
    return { accepted: true };
  }

  async updateProfile(accountId: string, displayName: string) {
    return this.accounts.updateProfile({
      accountId,
      displayName: normalizeDisplayName(displayName),
      updatedAt: this.clock.now(),
    });
  }
}
