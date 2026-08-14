import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock, IdentityProviderPort } from "@matchday/identity";
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

  constructor(private readonly session: AuthenticatedIdentityApiSession) {
    const provider = {
      exchangeAuthorizationCode: async () => {
        throw new Error("unused provider exchange");
      },
      requestRecovery: async () => undefined,
    } as IdentityProviderPort;
    const unitOfWork = {
      run: async () => {
        throw new Error("unused identity unit of work");
      },
    } as IdentityPersistenceUnitOfWork;
    super(provider, unitOfWork, "assurance-context-test-csrf-secret-at-least-32-bytes", clock, { minimum: "mfa" });
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
  } as AuthenticatedIdentityApiSession;
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
      headers: { cookie: `${config.identity.sessionCookieName}=opaque-session` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("STEP_UP_REQUIRED");
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
        cookie: `${config.identity.sessionCookieName}=opaque-session`,
        origin: config.api.allowedOrigins[0],
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
    const headers = { cookie: `${config.identity.sessionCookieName}=opaque-session` };

    expect((await app.inject({ method: "GET", url: "/api/v1/status", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/status", headers })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/api/v1/status", headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
  });
});
