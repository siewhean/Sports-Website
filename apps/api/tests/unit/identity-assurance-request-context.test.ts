import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticationAssurancePolicy, Clock, IdentityProviderPort } from "@matchday/identity";
import { buildApp } from "../../src/app.js";
import { IdentityAssuranceRuntime } from "../../src/identity-assurance-runtime.js";
import type {
  AuthenticatedIdentityApiSession,
  IdentityPersistenceUnitOfWork,
} from "../../src/identity-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const now = new Date("2026-08-14T00:00:00.000Z");
const clock: Clock = { now: () => now };

class StubAssuranceRuntime extends IdentityAssuranceRuntime {
  signedOut = false;

  constructor(
    private readonly session: AuthenticatedIdentityApiSession,
    policy: AuthenticationAssurancePolicy = { minimum: "mfa" },
  ) {
    const provider: IdentityProviderPort = {
      exchangeAuthorizationCode: async () => {
        throw new Error("unused provider exchange");
      },
      requestRecovery: async () => undefined,
    };
    const unitOfWork: IdentityPersistenceUnitOfWork = {
      async run<T>(): Promise<T> {
        throw new Error("unused identity unit of work");
      },
    };
    super(provider, unitOfWork, "assurance-context-test-csrf-secret-at-least-32-bytes", clock, policy);
  }

  override async authenticate(): Promise<AuthenticatedIdentityApiSession> {
    return this.session;
  }

  override verifyCsrfToken(_sessionToken: string, supplied: string): boolean {
    return supplied === "valid-csrf";
  }

  override async signOut(): Promise<void> {
    this.signedOut = true;
  }
}

function lowAssuranceSession(): AuthenticatedIdentityApiSession {
  const sessionId = randomUUID();
  return {
    account: {
      id: randomUUID(),
      primaryEmail: "organiser@example.test",
      displayName: "Test Organiser",
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    sessionId,
    sessionToken: `${sessionId}.${"s".repeat(43)}`,
    csrfToken: "valid-csrf",
    idleExpiresAt: new Date(now.getTime() + 30 * 60_000),
    absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60_000),
    assurance: {
      level: "single_factor",
      methods: ["pwd"],
      acr: null,
      authenticatedAt: now,
      mfaPerformed: false,
      phishingResistant: false,
    },
  };
}

function strongAssuranceSession(): AuthenticatedIdentityApiSession {
  return {
    ...lowAssuranceSession(),
    assurance: {
      level: "phishing_resistant",
      methods: ["pwd", "mfa"],
      acr: "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
      authenticatedAt: now,
      mfaPerformed: true,
      phishingResistant: true,
    },
  };
}

function allowedOrigin(config: ReturnType<typeof testConfig>): string {
  const origin = config.api.allowedOrigins[0];
  if (!origin) throw new Error("Test configuration requires an allowed origin");
  return origin;
}

function sessionCookie(config: ReturnType<typeof testConfig>): string {
  return `${config.identity.sessionCookieName}=opaque-session`;
}

describe("assurance-aware identity request context", () => {
  it("requires step-up for organiser identity reads", async () => {
    const config = testConfig();
    const runtime = new StubAssuranceRuntime(lowAssuranceSession());
    const app = await buildApp({ config, probes: healthyProbes, identityRuntime: runtime });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { cookie: sessionCookie(config) },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("STEP_UP_REQUIRED");
  });

  it("keeps policy off backward compatible for a valid single-factor session", async () => {
    const config = testConfig();
    const runtime = new StubAssuranceRuntime(lowAssuranceSession(), { minimum: "off" });
    const app = await buildApp({ config, probes: healthyProbes, identityRuntime: runtime });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { cookie: sessionCookie(config) },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().account.primary_email).toBe("organiser@example.test");
  });

  it("allows a phishing-resistant session through the phishing-resistant policy", async () => {
    const config = testConfig();
    const runtime = new StubAssuranceRuntime(strongAssuranceSession(), { minimum: "phishing_resistant" });
    const app = await buildApp({ config, probes: healthyProbes, identityRuntime: runtime });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { cookie: sessionCookie(config) },
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  it("still allows a valid low-assurance session to revoke itself", async () => {
    const config = testConfig();
    const runtime = new StubAssuranceRuntime(lowAssuranceSession());
    const app = await buildApp({ config, probes: healthyProbes, identityRuntime: runtime });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/identity/sign-out",
      headers: {
        cookie: sessionCookie(config),
        origin: allowedOrigin(config),
        "x-csrf-token": "valid-csrf",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(runtime.signedOut).toBe(true);
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("keeps valid low-assurance sessions in the authenticated rate-limit bucket", async () => {
    const config = testConfig();
    const runtime = new StubAssuranceRuntime(lowAssuranceSession());
    const app = await buildApp({
      config,
      probes: healthyProbes,
      identityRuntime: runtime,
      anonymousRateLimitMax: 1,
      authenticatedRateLimitMax: 2,
    });
    apps.push(app);
    const headers = { cookie: sessionCookie(config) };

    expect((await app.inject({ method: "GET", url: "/api/v1/status", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/status", headers })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/api/v1/status", headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
  });
});
