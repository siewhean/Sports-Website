import { describe, expect, it } from "vitest";
import { IdentityService } from "../src/identity.js";
import { SessionService } from "../src/session.js";
import {
  DeterministicIdentityProvider,
  DeterministicOpaqueTokenGenerator,
  InMemoryAccountRepository,
  InMemorySessionRepository,
  deterministicAccount,
} from "../src/testing.js";

const signInRequest = {
  authorizationCode: "one-time-code",
  redirectUri: "https://app.example.test/auth/callback",
  pkceVerifier: "pkce-verifier",
};

function setup() {
  const now = new Date("2026-01-01T10:00:00.000Z");
  const clock = { now: () => now };
  const accounts = new InMemoryAccountRepository();
  const sessions = new InMemorySessionRepository();
  const provider = new DeterministicIdentityProvider({
    issuer: "https://identity.example.test",
    subject: "provider-subject",
    providerSessionId: "provider-session-1",
    email: " Organiser@Example.test ",
    emailVerified: true,
    displayName: "  Test   Organiser  ",
  });
  const sessionService = new SessionService(sessions, accounts, clock, new DeterministicOpaqueTokenGenerator());
  return {
    now,
    accounts,
    sessions,
    provider,
    service: new IdentityService(provider, accounts, sessionService, clock),
  };
}

describe("IdentityService", () => {
  it("creates an account only from verified provider claims and issues an opaque session", async () => {
    const fixture = setup();
    const result = await fixture.service.signIn(signInRequest);

    expect(result.isNewAccount).toBe(true);
    expect(result.account).toMatchObject({
      primaryEmail: "organiser@example.test",
      displayName: "Test Organiser",
      emailVerifiedAt: fixture.now,
    });
    expect(result.sessionToken).toMatch(/^00000000-0000-4000-8000-000000000001\./);
    const stored = fixture.sessions.sessions.get(result.sessionId);
    expect(stored?.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.secretHash).not.toContain(result.sessionToken.split(".")[1] ?? "missing");
    expect(stored).toMatchObject({
      providerIssuer: "https://identity.example.test",
      providerSubject: "provider-subject",
      providerSessionId: "provider-session-1",
    });
  });

  it("reuses an explicitly linked issuer/subject without trusting mutable email claims", async () => {
    const fixture = setup();
    const existing = deterministicAccount({ primaryEmail: "original@example.test" });
    fixture.accounts.seed(existing, {
      issuer: fixture.provider.claims.issuer,
      subject: fixture.provider.claims.subject,
    });
    fixture.provider.claims = { ...fixture.provider.claims, email: "attacker@example.test" };

    const result = await fixture.service.signIn(signInRequest);
    expect(result.isNewAccount).toBe(false);
    expect(result.account.primaryEmail).toBe("original@example.test");
    expect(fixture.accounts.authentications).toHaveLength(1);
  });

  it("rejects unverified email claims for new accounts", async () => {
    const fixture = setup();
    fixture.provider.claims = { ...fixture.provider.claims, emailVerified: false };
    await expect(fixture.service.signIn(signInRequest)).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("never auto-links a new provider identity by matching email", async () => {
    const fixture = setup();
    fixture.accounts.seed(deterministicAccount());
    await expect(fixture.service.signIn(signInRequest)).rejects.toMatchObject({ code: "ACCOUNT_LINKING_REQUIRED" });
    expect(fixture.accounts.providerAccounts.size).toBe(0);
  });

  it("returns the same recovery response when provider delivery fails", async () => {
    const fixture = setup();
    fixture.provider.recoveryError = new Error("provider unavailable");
    await expect(
      fixture.service.requestRecovery(" Organiser@Example.test ", "https://app.example.test/recover"),
    ).resolves.toEqual({ accepted: true });
    expect(fixture.provider.recoveryRequests).toEqual([
      { email: "organiser@example.test", redirectUri: "https://app.example.test/recover" },
    ]);
  });

  it("normalizes safe profile names and rejects control characters", async () => {
    const fixture = setup();
    fixture.accounts.seed(deterministicAccount());
    await expect(fixture.service.updateProfile("account-1", "  Match   Director  ")).resolves.toMatchObject({
      displayName: "Match Director",
    });
    await expect(fixture.service.updateProfile("account-1", "bad\u0000name")).rejects.toMatchObject({
      code: "INVALID_PROFILE",
    });
  });
});
