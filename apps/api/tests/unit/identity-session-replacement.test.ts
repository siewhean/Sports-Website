import { describe, expect, it } from "vitest";
import type { Clock } from "@matchday/identity";
import {
  DeterministicIdentityProvider,
  InMemoryAccountRepository,
  InMemoryAuditRepository,
  InMemorySessionRepository,
} from "@matchday/identity/testing";
import { IdentityApiRuntime, type IdentityPersistenceUnitOfWork } from "../../src/identity-runtime.js";

const now = new Date("2026-08-14T00:00:00.000Z");
const clock: Clock = { now: () => now };
const request = {
  authorizationCode: "provider-code-12345678",
  redirectUri: "http://127.0.0.1:3000/auth/callback",
  pkceVerifier: "v".repeat(43),
};

describe("browser session replacement", () => {
  it("revokes the displaced session when reauthentication issues a stronger session", async () => {
    const accounts = new InMemoryAccountRepository();
    const sessions = new InMemorySessionRepository();
    const audit = new InMemoryAuditRepository();
    const unitOfWork: IdentityPersistenceUnitOfWork = {
      async run<T>(operation: Parameters<IdentityPersistenceUnitOfWork["run"]>[0]): Promise<T> {
        return operation({ accounts, sessions, audit }) as Promise<T>;
      },
    };
    const provider = new DeterministicIdentityProvider({
      issuer: "https://identity.example.test",
      subject: "organiser-subject",
      providerSessionId: "provider-session-1",
      email: "organiser@example.test",
      emailVerified: true,
      displayName: "Test Organiser",
      assurance: {
        methods: ["pwd"],
        acr: null,
        authenticatedAt: now,
        phishingResistant: false,
      },
    });
    const runtime = new IdentityApiRuntime(
      provider,
      unitOfWork,
      "session-replacement-test-csrf-secret-at-least-32-bytes",
      clock,
    );

    const first = await runtime.signIn(request, "first-login");
    expect(first.assurance.mfaPerformed).toBe(false);

    provider.claims = {
      ...provider.claims,
      providerSessionId: "provider-session-2",
      assurance: {
        methods: ["pwd", "mfa"],
        acr: "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
        authenticatedAt: now,
        phishingResistant: true,
      },
    };
    const replacement = await runtime.signIn(request, "step-up-login", first.sessionToken);

    expect(replacement.sessionId).not.toBe(first.sessionId);
    expect(replacement.assurance).toMatchObject({
      level: "phishing_resistant",
      mfaPerformed: true,
      phishingResistant: true,
    });
    expect((await sessions.findById(first.sessionId))?.revokedAt).toEqual(now);
    await expect(runtime.authenticate(first.sessionToken, "replay-old-session")).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });
    await expect(runtime.authenticate(replacement.sessionToken, "use-replacement-session")).resolves.toMatchObject({
      sessionId: replacement.sessionId,
      assurance: { phishingResistant: true },
    });

    const replacementAudit = audit.events.find(
      (event) => event.action === "identity.session.revoked" && event.targetId === first.sessionId,
    );
    expect(replacementAudit).toMatchObject({ reason: "session_replaced" });
    expect(JSON.stringify(audit.events)).not.toContain(first.sessionToken);
    expect(JSON.stringify(audit.events)).not.toContain(replacement.sessionToken);
  });

  it("does not block a fresh login when the browser presents an invalid old cookie", async () => {
    const accounts = new InMemoryAccountRepository();
    const sessions = new InMemorySessionRepository();
    const audit = new InMemoryAuditRepository();
    const unitOfWork: IdentityPersistenceUnitOfWork = {
      async run<T>(operation: Parameters<IdentityPersistenceUnitOfWork["run"]>[0]): Promise<T> {
        return operation({ accounts, sessions, audit }) as Promise<T>;
      },
    };
    const provider = new DeterministicIdentityProvider({
      issuer: "https://identity.example.test",
      subject: "fresh-subject",
      providerSessionId: "provider-session-fresh",
      email: "fresh@example.test",
      emailVerified: true,
      displayName: "Fresh Organiser",
    });
    const runtime = new IdentityApiRuntime(
      provider,
      unitOfWork,
      "session-replacement-test-csrf-secret-at-least-32-bytes",
      clock,
    );

    await expect(runtime.signIn(request, "fresh-login", "not-a-valid-session-token")).resolves.toMatchObject({
      account: { primaryEmail: "fresh@example.test" },
    });
  });
});
