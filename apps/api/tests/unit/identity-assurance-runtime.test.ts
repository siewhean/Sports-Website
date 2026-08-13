import { describe, expect, it } from "vitest";
import type {
  Account,
  AuthenticationAssurance,
  Clock,
  IdentityProviderPort,
} from "@matchday/identity";
import { IdentityAssuranceRuntime } from "../../src/identity-assurance-runtime.js";
import type { AuthenticatedIdentityApiSession, IdentityPersistenceUnitOfWork } from "../../src/identity-runtime.js";

const now = new Date("2026-08-14T00:00:00.000Z");
const clock: Clock = { now: () => now };
const provider = {} as IdentityProviderPort;
const unitOfWork = {} as IdentityPersistenceUnitOfWork;
const account = {
  id: "00000000-0000-4000-8000-000000000001",
  primaryEmail: "organiser@example.test",
  displayName: "Organiser",
  status: "active",
  emailVerifiedAt: now,
  createdAt: now,
  updatedAt: now,
} satisfies Account;

function session(assurance: AuthenticationAssurance): AuthenticatedIdentityApiSession {
  return {
    account,
    sessionId: "00000000-0000-4000-8000-000000000002",
    sessionToken: "00000000-0000-4000-8000-000000000002.secret",
    csrfToken: "csrf",
    idleExpiresAt: new Date(now.getTime() + 30 * 60_000),
    absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60_000),
    assurance,
  };
}

function runtime(minimum: "off" | "mfa" | "phishing_resistant", maxAuthenticationAgeMs?: number) {
  return new IdentityAssuranceRuntime(
    provider,
    unitOfWork,
    "identity-assurance-runtime-test-csrf-secret-at-least-32-bytes",
    clock,
    { minimum, ...(maxAuthenticationAgeMs === undefined ? {} : { maxAuthenticationAgeMs }) },
  );
}

describe("IdentityAssuranceRuntime", () => {
  const single: AuthenticationAssurance = {
    level: "single_factor",
    methods: ["pwd"],
    acr: null,
    authenticatedAt: now,
    mfaPerformed: false,
    phishingResistant: false,
  };
  const mfa: AuthenticationAssurance = {
    level: "multi_factor",
    methods: ["pwd", "mfa"],
    acr: null,
    authenticatedAt: now,
    mfaPerformed: true,
    phishingResistant: false,
  };
  const strong: AuthenticationAssurance = {
    level: "phishing_resistant",
    methods: ["mfa"],
    acr: "https://matchday.example/assurance/phishing-resistant",
    authenticatedAt: now,
    mfaPerformed: true,
    phishingResistant: true,
  };

  it("keeps the migration policy off backward compatible", () => {
    expect(() => runtime("off").requireConfiguredAssurance(session(single))).not.toThrow();
  });

  it("returns STEP_UP_REQUIRED instead of pretending the session is unauthenticated", () => {
    expect(() => runtime("mfa").requireConfiguredAssurance(session(single))).toThrow(
      expect.objectContaining({ statusCode: 403, code: "STEP_UP_REQUIRED" }),
    );
  });

  it("does not equate generic MFA with phishing resistance", () => {
    expect(() => runtime("mfa").requireConfiguredAssurance(session(mfa))).not.toThrow();
    expect(() => runtime("phishing_resistant").requireConfiguredAssurance(session(mfa))).toThrow(
      expect.objectContaining({ statusCode: 403, code: "STEP_UP_REQUIRED" }),
    );
    expect(() => runtime("phishing_resistant").requireConfiguredAssurance(session(strong))).not.toThrow();
  });

  it("enforces authentication freshness from server-bound evidence", () => {
    const stale = { ...mfa, authenticatedAt: new Date(now.getTime() - 10 * 60_000) };
    expect(() => runtime("mfa", 5 * 60_000).requireConfiguredAssurance(session(stale))).toThrow(
      expect.objectContaining({ statusCode: 403, code: "STEP_UP_REQUIRED" }),
    );
  });
});
