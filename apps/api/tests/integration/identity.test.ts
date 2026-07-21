import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IdentityProviderPort, PostgresJsSql, ProviderClaims, ProviderSignInRequest } from "@matchday/identity";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { Redis } from "ioredis";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { PostgresIdentityUnitOfWork } from "../../src/identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../../src/identity-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const schema = `test_api_identity_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const allowedOrigin = "https://app.matchday.test";
const testHmacMaterial = "integration-csrf-material-is-at-least-32-bytes";

type TestSql = PostgresJsSql & { end(options?: { timeout?: number }): Promise<void> };

class DeterministicProvider implements IdentityProviderPort {
  readonly recoveryRequests: { email: string; redirectUri: string }[] = [];
  failingRecoveryEmails = new Set<string>();

  async exchangeAuthorizationCode(request: ProviderSignInRequest): Promise<ProviderClaims> {
    const key = request.authorizationCode.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    return {
      issuer: "https://identity.matchday.test",
      subject: `subject-${key}`,
      providerSessionId: `sid-${key}`,
      email: `${key}@example.test`,
      emailVerified: true,
      displayName: `Account ${key}`,
    };
  }

  async requestRecovery(email: string, redirectUri: string): Promise<void> {
    this.recoveryRequests.push({ email, redirectUri });
    if (this.failingRecoveryEmails.has(email)) throw new Error("provider deliberately unavailable");
  }
}

let sql: TestSql;
let provider: DeterministicProvider;
let now: Date;

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function runtime(identityProvider: IdentityProviderPort = provider) {
  return new IdentityApiRuntime(identityProvider, new PostgresIdentityUnitOfWork(sql), testHmacMaterial, {
    now: () => now,
  });
}

async function createApp(
  options: {
    identityProvider?: IdentityProviderPort;
    authenticatedRateLimitMax?: number;
    anonymousRateLimitMax?: number;
    rateLimitRedis?: Redis;
    rateLimitNameSpace?: string;
  } = {},
) {
  const app = await buildApp({
    config: testConfig({
      APP_ENV: "test",
      API_ALLOWED_ORIGINS: allowedOrigin,
      IDENTITY_CSRF_HMAC_SECRET: testHmacMaterial,
    }),
    probes: healthyProbes,
    identityRuntime: runtime(options.identityProvider),
    authenticatedRateLimitMax: options.authenticatedRateLimitMax ?? 1_000,
    anonymousRateLimitMax: options.anonymousRateLimitMax ?? 1_000,
    ...(options.rateLimitRedis ? { rateLimitRedis: options.rateLimitRedis } : {}),
    ...(options.rateLimitNameSpace ? { rateLimitNameSpace: options.rateLimitNameSpace } : {}),
  });
  apps.push(app);
  return app;
}

const signInBody = (key: string) => ({
  authorization_code: `code-${key}-12345678`,
  redirect_uri: "https://app.matchday.test/auth/callback",
  pkce_verifier: "v".repeat(43),
});

async function signIn(app: Awaited<ReturnType<typeof buildApp>>, key: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/identity/sign-in",
    headers: { origin: allowedOrigin, "x-request-id": `sign-in-${key}-request` },
    payload: signInBody(key),
  });
  const setCookie = response.headers["set-cookie"];
  const serialized = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!serialized) throw new Error("Sign-in did not issue a cookie.");
  return {
    response,
    setCookie: serialized,
    cookie: serialized.split(";", 1)[0] ?? "",
    csrf: response.json().csrf_token as string,
  };
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  const client = postgres(databaseUrl, {
    max: 10,
    onnotice: () => undefined,
    connection: { search_path: schema },
  });
  sql = client as unknown as TestSql;
  provider = new DeterministicProvider();
  now = new Date();
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (sql) await sql.end({ timeout: 2 });
  await dropTestSchema(databaseUrl, schema);
});

describe("identity API", () => {
  it("signs in, issues a secure opaque cookie, enforces CSRF, audits profile, and signs out", async () => {
    const app = await createApp();
    const signedIn = await signIn(app, `flow-${randomUUID()}`);
    expect(signedIn.response.statusCode).toBe(200);
    expect(signedIn.response.json()).not.toHaveProperty("session_token");
    expect(signedIn.response.body).not.toContain(signedIn.cookie.split("=")[1] ?? "missing-token");
    expect(signedIn.setCookie).toContain("matchday_session=");
    expect(signedIn.setCookie).toContain("HttpOnly");
    expect(signedIn.setCookie).toContain("SameSite=Strict");
    expect(signedIn.setCookie).not.toContain("Secure");
    expect(signedIn.setCookie).toContain("Path=/");
    expect(signedIn.setCookie).not.toContain("Domain=");

    const current = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { cookie: signedIn.cookie },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().csrf_token).toBe(signedIn.csrf);

    const unauthenticatedCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/identity/sign-out",
      headers: { origin: allowedOrigin, "x-csrf-token": "invalid" },
    });
    expect(unauthenticatedCsrf.statusCode).toBe(401);

    const missingCsrf = await app.inject({
      method: "PATCH",
      url: "/api/v1/identity/me",
      headers: { cookie: signedIn.cookie, origin: allowedOrigin },
      payload: { display_name: "Updated Director" },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json().error.code).toBe("CSRF_INVALID");

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/identity/me",
      headers: { cookie: signedIn.cookie, origin: allowedOrigin, "x-csrf-token": signedIn.csrf },
      payload: { display_name: "Updated Director" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().account.display_name).toBe("Updated Director");

    const signOut = await app.inject({
      method: "POST",
      url: "/api/v1/identity/sign-out",
      headers: { cookie: signedIn.cookie, origin: allowedOrigin, "x-csrf-token": signedIn.csrf },
    });
    expect(signOut.statusCode).toBe(204);
    expect(signOut.headers["set-cookie"]).toContain("Max-Age=0");
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/identity/me", headers: { cookie: signedIn.cookie } }))
        .statusCode,
    ).toBe(401);

    const audit = await sql.unsafe<{ action: string; request_id: string }>(
      `SELECT action, request_id FROM audit_events
       WHERE action IN ('identity.session.created', 'account.profile.updated', 'identity.session.revoked')
       ORDER BY occurred_at`,
    );
    expect(audit.map((row) => row.action)).toEqual([
      "identity.session.created",
      "account.profile.updated",
      "identity.session.revoked",
    ]);
    expect(audit.every((row) => row.request_id.length >= 8)).toBe(true);
  });

  it("rejects cross-origin identity mutations before provider or profile changes", async () => {
    const app = await createApp();
    const rejectedSignIn = await app.inject({
      method: "POST",
      url: "/api/v1/identity/sign-in",
      headers: { origin: "https://attacker.example" },
      payload: signInBody(`origin-${randomUUID()}`),
    });
    expect(rejectedSignIn.statusCode).toBe(403);
    expect(rejectedSignIn.json().error.code).toBe("ORIGIN_REJECTED");

    const signedIn = await signIn(app, `origin-valid-${randomUUID()}`);
    const rejectedProfile = await app.inject({
      method: "PATCH",
      url: "/api/v1/identity/me",
      headers: {
        cookie: signedIn.cookie,
        origin: "https://attacker.example",
        "x-csrf-token": signedIn.csrf,
      },
      payload: { display_name: "Attacker Change" },
    });
    expect(rejectedProfile.statusCode).toBe(403);
    expect(rejectedProfile.json().error.code).toBe("ORIGIN_REJECTED");
  });

  it("returns an invariant recovery response and PII-free audit whether provider delivery succeeds or fails", async () => {
    const app = await createApp();
    const missingEmail = `missing-${randomUUID()}@example.test`;
    provider.failingRecoveryEmails.add(missingEmail);
    const request = async (email: string, requestId: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/identity/recovery",
        headers: { origin: allowedOrigin, "x-request-id": requestId },
        payload: { email, redirect_uri: "https://app.matchday.test/recovery" },
      });
    const existing = await request(`known-${randomUUID()}@example.test`, "recovery-known-request");
    const missing = await request(missingEmail, "recovery-missing-request");
    expect(existing.statusCode).toBe(202);
    expect(missing.statusCode).toBe(202);
    expect(existing.body).toBe(missing.body);

    const audits = await sql.unsafe<{ event: string }>(
      `SELECT row_to_json(audit_events)::text AS event FROM audit_events
       WHERE action = 'identity.recovery.requested'
       ORDER BY occurred_at DESC LIMIT 2`,
    );
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => row.event).join(" ")).not.toContain("@example.test");
  });

  it("revokes expired sessions and records expiry audit with the API request ID", async () => {
    const app = await createApp();
    const signedIn = await signIn(app, `expiry-${randomUUID()}`);
    now = new Date(now.getTime() + 31 * 60 * 1_000);
    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { cookie: signedIn.cookie, "x-request-id": "expiry-check-request" },
    });
    expect(expired.statusCode).toBe(401);
    const audit = await sql.unsafe<{ reason: string; request_id: string }>(
      `SELECT reason, request_id FROM audit_events
       WHERE action = 'identity.session.revoked' AND reason = 'expired'
       ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]).toEqual({ reason: "expired", request_id: "expiry-check-request" });
  });

  it("uses validated session accounts for Redis rate keys and keeps anonymous traffic separate", async () => {
    const namespace = `identity-api-${randomUUID()}-`;
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const app = await createApp({
      rateLimitRedis: redis,
      rateLimitNameSpace: namespace,
      authenticatedRateLimitMax: 1,
      anonymousRateLimitMax: 2,
    });
    const first = await signIn(app, `rate-a-${randomUUID()}`);
    const second = await signIn(app, `rate-b-${randomUUID()}`);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/identity/me", headers: { cookie: first.cookie } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/identity/me", headers: { cookie: first.cookie } })).statusCode,
    ).toBe(429);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/identity/me", headers: { cookie: second.cookie } })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode).toBe(200);
  });

  it("does not trust spoofed forwarding headers without an explicit proxy allowlist", async () => {
    const app = await createApp({ anonymousRateLimitMax: 1 });
    const first = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    const spoofed = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { "x-forwarded-for": "203.0.113.25" },
    });
    expect(first.statusCode).toBe(200);
    expect(spoofed.statusCode).toBe(429);
  });

  it("fails sign-in closed when no real identity provider is configured", async () => {
    const app = await createApp({ identityProvider: new UnavailableIdentityProvider() });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/identity/sign-in",
      headers: { origin: allowedOrigin },
      payload: signInBody(`unavailable-${randomUUID()}`),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
  });
});
