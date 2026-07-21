import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Clock, type IdentityProviderPort, type PostgresJsSql } from "@matchday/identity";
import { DeterministicIdentityProvider } from "@matchday/identity/testing";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import postgres from "postgres";
import { buildApp } from "../../src/app.js";
import { PostgresIdentityUnitOfWork } from "../../src/identity-postgres.js";
import { IdentityApiRuntime, UnavailableIdentityProvider } from "../../src/identity-runtime.js";
import {
  IdentityProviderEventVerifier,
  providerEventSigningInput,
  type IdentityProviderRevocationEvent,
} from "../../src/identity-provider-events.js";
import { edgeCacheEnvironment, healthyProbes, oidcEnvironment, testConfig } from "../helpers.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_identity_api_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const allowedOrigin = "http://127.0.0.1:3000";

let now = new Date("2026-07-17T00:00:00.000Z");
const clock: Clock = { now: () => now };
let sql: ReturnType<typeof postgres>;
let identitySql: PostgresJsSql;
let provider: DeterministicIdentityProvider;
let runtime: IdentityApiRuntime;

function cookiePair(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0] ?? "";
}

function createRuntime(identityProvider: IdentityProviderPort = provider): IdentityApiRuntime {
  return new IdentityApiRuntime(
    identityProvider,
    new PostgresIdentityUnitOfWork(identitySql),
    "identity-api-test-csrf-secret-at-least-32-bytes",
    clock,
  );
}

async function signIn(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/identity/sign-in",
    headers: { origin: allowedOrigin, "x-request-id": `signin-${randomUUID()}` },
    payload: {
      authorization_code: "provider-code-12345678",
      redirect_uri: `${allowedOrigin}/auth/callback`,
      pkce_verifier: "v".repeat(43),
    },
  });
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 10, onnotice: () => undefined, connection: { search_path: schema } });
  identitySql = sql as unknown as PostgresJsSql;
  provider = new DeterministicIdentityProvider({
    issuer: "https://identity.example.test",
    subject: "identity-api-subject",
    providerSessionId: "identity-api-session",
    email: "organiser@example.test",
    emailVerified: true,
    displayName: "Test Organiser",
  });
  runtime = createRuntime();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  now = new Date("2026-07-17T00:00:00.000Z");
  provider.recoveryError = null;
  provider.claims = {
    issuer: "https://identity.example.test",
    subject: "identity-api-subject",
    providerSessionId: "identity-api-session",
    email: "organiser@example.test",
    emailVerified: true,
    displayName: "Test Organiser",
  };
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 1 });
  await dropTestSchema(databaseUrl, schema);
});

describe("identity API", () => {
  it("revokes every issuer/subject or issuer/sid mapped session from an authenticated replay-safe provider event", async () => {
    const providerEventSecret = "provider-event-test-secret-at-least-32-bytes";
    provider.claims.subject = `revocation-${randomUUID()}`;
    provider.claims.issuer = "https://identity.matchday.test";
    provider.claims.email = `revocation-${randomUUID()}@example.test`;
    provider.claims.providerSessionId = "shared-provider-session";
    const oidcConfig = testConfig({
      ...oidcEnvironment(allowedOrigin, "http://127.0.0.1:4000"),
      IDENTITY_PROVIDER_EVENT_HMAC_SECRET: providerEventSecret,
    });
    const app = await buildApp({
      config: oidcConfig,
      probes: healthyProbes,
      identityRuntime: runtime,
      identityProviderEventClock: clock,
    });
    apps.push(app);
    const request = {
      authorizationCode: "provider-code-12345678",
      redirectUri: "http://127.0.0.1:4000/api/v1/identity/callback",
      pkceVerifier: "v".repeat(43),
    };
    const first = await runtime.signIn(request, `direct-signin-${randomUUID()}`);
    const second = await runtime.signIn(request, `direct-signin-${randomUUID()}`);

    const sign = (event: IdentityProviderRevocationEvent) =>
      `sha256=${createHmac("sha256", providerEventSecret)
        .update(providerEventSigningInput(event))
        .digest("base64url")}`;
    const send = (event: IdentityProviderRevocationEvent, eventSignature = sign(event)) =>
      app.inject({
        method: "POST",
        url: "/api/v1/identity/provider-events",
        headers: { "x-matchday-provider-signature": eventSignature, "x-request-id": `provider-${event.eventId}` },
        payload: {
          event_id: event.eventId,
          type: event.type,
          issuer: event.issuer,
          ...(event.subject ? { subject: event.subject } : {}),
          ...(event.providerSessionId ? { provider_session_id: event.providerSessionId } : {}),
          occurred_at: event.occurredAt,
        },
      });
    const passwordChanged: IdentityProviderRevocationEvent = {
      eventId: randomUUID(),
      type: "password_changed",
      issuer: provider.claims.issuer,
      subject: provider.claims.subject,
      providerSessionId: null,
      occurredAt: now.toISOString(),
    };
    expect(oidcConfig.identity.oidc?.providerEventHmacSecret).toBe(providerEventSecret);
    expect(
      new IdentityProviderEventVerifier(providerEventSecret, provider.claims.issuer, clock).verify(
        passwordChanged,
        sign(passwordChanged),
      ),
    ).toEqual(now);
    expect((await send(passwordChanged, "sha256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).statusCode).toBe(401);
    const acceptedPasswordChange = await send(passwordChanged);
    expect(acceptedPasswordChange.statusCode, acceptedPasswordChange.body).toBe(202);
    expect((await send(passwordChanged)).statusCode).toBe(202);
    await expect(runtime.authenticate(first.sessionToken, "revoked-first-check")).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });
    await expect(runtime.authenticate(second.sessionToken, "revoked-second-check")).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });

    provider.claims.providerSessionId = "new-provider-session";
    const third = await runtime.signIn(request, `direct-signin-${randomUUID()}`);
    const providerSessionRevoked: IdentityProviderRevocationEvent = {
      eventId: randomUUID(),
      type: "session_revoked",
      issuer: provider.claims.issuer,
      subject: null,
      providerSessionId: provider.claims.providerSessionId,
      occurredAt: now.toISOString(),
    };
    expect((await send(providerSessionRevoked)).statusCode).toBe(202);
    await expect(runtime.authenticate(third.sessionToken, "revoked-third-check")).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });

    const audits = await sql.unsafe<{ action: string; reason: string; target_id: string }[]>(
      `SELECT action, reason, target_id FROM audit_events
       WHERE target_id IN ($1, $2) OR reason IN ('provider_password_changed', 'provider_session_revoked')`,
      [passwordChanged.eventId, providerSessionRevoked.eventId],
    );
    expect(audits.filter((row) => row.action === "identity.session.revoked")).toHaveLength(3);
    expect(
      audits.filter((row) => row.action === "identity.provider_event.processed").map((row) => row.target_id),
    ).toEqual(expect.arrayContaining([passwordChanged.eventId, providerSessionRevoked.eventId]));
  });

  it("signs in, enforces origin and CSRF, updates the profile atomically, and signs out", async () => {
    expect(JSON.stringify(runtime)).not.toContain("identity-api-test-csrf-secret-at-least-32-bytes");
    const app = await buildApp({ config: testConfig(), probes: healthyProbes, identityRuntime: runtime });
    apps.push(app);

    const signedIn = await signIn(app);
    expect(signedIn.statusCode).toBe(200);
    const setCookie = signedIn.headers["set-cookie"];
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    const cookie = cookiePair(setCookie);
    const csrfToken = signedIn.json().csrf_token as string;

    const me = await app.inject({ method: "GET", url: "/api/v1/identity/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store, private");
    expect(me.headers.vary).toContain("Cookie");
    expect(me.json().account).toMatchObject({
      primary_email: "organiser@example.test",
      display_name: "Test Organiser",
    });

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/identity/me",
          headers: { cookie, origin: allowedOrigin },
          payload: { display_name: "Updated Organiser" },
        })
      ).json().error.code,
    ).toBe("CSRF_INVALID");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/identity/me",
          headers: { cookie, origin: "https://attacker.example", "x-csrf-token": csrfToken },
          payload: { display_name: "Attacker" },
        })
      ).json().error.code,
    ).toBe("ORIGIN_REJECTED");

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/identity/me",
      headers: { cookie, origin: allowedOrigin, "x-csrf-token": csrfToken, "x-request-id": "profile-update-001" },
      payload: { display_name: "Updated Organiser" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().account.display_name).toBe("Updated Organiser");

    const signedOut = await app.inject({
      method: "POST",
      url: "/api/v1/identity/sign-out",
      headers: { cookie, origin: allowedOrigin, "x-csrf-token": csrfToken, "x-request-id": "signout-request-001" },
    });
    expect(signedOut.statusCode).toBe(204);
    expect(signedOut.headers["set-cookie"]).toContain("Max-Age=0");
    expect((await app.inject({ method: "GET", url: "/api/v1/identity/me", headers: { cookie } })).statusCode).toBe(401);

    const audit = await sql.unsafe<{ action: string; request_id: string }[]>(
      `SELECT action, request_id FROM audit_events
       WHERE action IN ('identity.session.created', 'account.profile.updated', 'identity.session.revoked')
       ORDER BY occurred_at, action`,
    );
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining(["identity.session.created", "account.profile.updated", "identity.session.revoked"]),
    );
    expect(audit.some((event) => event.request_id === "profile-update-001")).toBe(true);
    expect(audit.some((event) => event.request_id === "signout-request-001")).toBe(true);
  });

  it("expires idle sessions and never exposes the opaque token in the response body", async () => {
    provider.claims.subject = `expiry-${randomUUID()}`;
    provider.claims.email = `expiry-${randomUUID()}@example.test`;
    const app = await buildApp({ config: testConfig(), probes: healthyProbes, identityRuntime: runtime });
    apps.push(app);
    const signedIn = await signIn(app);
    const cookie = cookiePair(signedIn.headers["set-cookie"]);
    expect(JSON.stringify(signedIn.json())).not.toContain("deterministic-session-secret");
    expect(JSON.stringify(signedIn.json())).not.toContain(cookie.split("=", 2)[1]);
    now = new Date(now.getTime() + 31 * 60 * 1_000);
    const expired = await app.inject({ method: "GET", url: "/api/v1/identity/me", headers: { cookie } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("keeps recovery responses invariant and audits without recipient PII", async () => {
    const app = await buildApp({ config: testConfig(), probes: healthyProbes, identityRuntime: runtime });
    apps.push(app);
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/identity/recovery",
      headers: { origin: allowedOrigin, "x-request-id": "recovery-success-001" },
      payload: { email: "organiser@example.test", redirect_uri: `${allowedOrigin}/recover` },
    });
    provider.recoveryError = new Error("provider unavailable");
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/identity/recovery",
      headers: { origin: allowedOrigin, "x-request-id": "recovery-provider-failure-001" },
      payload: { email: "missing@example.test", redirect_uri: `${allowedOrigin}/recover` },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json()).toEqual(second.json());
    const rows = await sql.unsafe<{ document: string }[]>(
      `SELECT row_to_json(audit_events)::text AS document FROM audit_events
       WHERE request_id IN ('recovery-success-001', 'recovery-provider-failure-001')`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.document).join(" ")).not.toContain("@example.test");
  });

  it("rejects provider redirect URIs outside the configured application origins", async () => {
    const app = await buildApp({ config: testConfig(), probes: healthyProbes, identityRuntime: runtime });
    apps.push(app);
    const signInCount = provider.signInRequests.length;
    const recoveryCount = provider.recoveryRequests.length;
    const hostileSignIn = await app.inject({
      method: "POST",
      url: "/api/v1/identity/sign-in",
      headers: { origin: allowedOrigin },
      payload: {
        authorization_code: "provider-code-12345678",
        redirect_uri: "https://attacker.example/capture",
        pkce_verifier: "v".repeat(43),
      },
    });
    const hostileRecovery = await app.inject({
      method: "POST",
      url: "/api/v1/identity/recovery",
      headers: { origin: allowedOrigin },
      payload: { email: "organiser@example.test", redirect_uri: "https://attacker.example/capture" },
    });
    const unsafeLoopbackRecovery = await app.inject({
      method: "POST",
      url: "/api/v1/identity/recovery",
      headers: { origin: allowedOrigin },
      payload: { email: "organiser@example.test", redirect_uri: "ftp://localhost/capture" },
    });
    expect(hostileSignIn.statusCode).toBe(400);
    expect(hostileRecovery.statusCode).toBe(400);
    expect(unsafeLoopbackRecovery.statusCode).toBe(400);
    expect(hostileRecovery.headers["cache-control"]).toBe("no-store, private");
    expect(hostileRecovery.headers.vary).toContain("Cookie");
    expect(hostileSignIn.json().error.code).toBe("REDIRECT_URI_REJECTED");
    expect(hostileRecovery.json().error.code).toBe("REDIRECT_URI_REJECTED");
    expect(provider.signInRequests).toHaveLength(signInCount);
    expect(provider.recoveryRequests).toHaveLength(recoveryCount);
  });

  it("uses stricter anonymous limits and a separate validated account key", async () => {
    provider.claims.subject = `rate-${randomUUID()}`;
    provider.claims.email = `rate-${randomUUID()}@example.test`;
    const app = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: runtime,
      anonymousRateLimitMax: 1,
      authenticatedRateLimitMax: 2,
    });
    apps.push(app);
    const signedIn = await signIn(app);
    expect(signedIn.statusCode).toBe(200);
    const cookie = cookiePair(signedIn.headers["set-cookie"]);

    expect((await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode).toBe(429);
    expect((await app.inject({ method: "GET", url: "/api/v1/status", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/status", headers: { cookie } })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/api/v1/status", headers: { cookie } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe("2");
  });

  it("sets a __Host secure cookie outside local/test and fails closed without an identity provider", async () => {
    provider.claims.subject = `secure-${randomUUID()}`;
    provider.claims.email = `secure-${randomUUID()}@example.test`;
    const production = testConfig({
      APP_ENV: "production",
      API_ALLOWED_ORIGINS: "https://app.matchday.example",
      DATABASE_URL: databaseUrl,
      DEEP_HEALTH_TOKEN: "d".repeat(32),
      IDENTITY_CSRF_HMAC_SECRET: "p".repeat(32),
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.matchday.example",
      REDIS_URL: "redis://127.0.0.1:6379",
      ...edgeCacheEnvironment(),
      ...oidcEnvironment("https://app.matchday.example", "https://api.matchday.example"),
    });
    const secureRuntime = new IdentityApiRuntime(
      provider,
      new PostgresIdentityUnitOfWork(identitySql),
      production.identity.csrfHmacSecret,
      clock,
    );
    const secureApp = await buildApp({ config: production, probes: healthyProbes, identityRuntime: secureRuntime });
    apps.push(secureApp);
    const authorization = await secureApp.inject({
      method: "GET",
      url: "/api/v1/identity/authorize?return_to=https%3A%2F%2Fapp.matchday.example%2Forganiser",
    });
    expect(authorization.statusCode).toBe(302);
    const flowCookie = cookiePair(authorization.headers["set-cookie"]);
    expect(authorization.headers["set-cookie"]).toContain("__Secure-matchday_oidc=");
    expect(authorization.headers["set-cookie"]).toContain("SameSite=Lax");
    const state = new URL(authorization.headers.location ?? "").searchParams.get("state");
    if (!state) throw new Error("Expected provider state");
    const secureSignIn = await secureApp.inject({
      method: "GET",
      url: `/api/v1/identity/callback?code=provider-code-12345678&state=${encodeURIComponent(state)}`,
      headers: { cookie: flowCookie },
    });
    expect(secureSignIn.statusCode).toBe(303);
    const cookies = Array.isArray(secureSignIn.headers["set-cookie"])
      ? secureSignIn.headers["set-cookie"].join("; ")
      : (secureSignIn.headers["set-cookie"] ?? "");
    expect(cookies).toContain("__Host-matchday_session=");
    expect(cookies).toContain("Secure");
    expect(cookies).not.toContain("Domain=");
    expect(secureSignIn.headers.location).toBe("https://app.matchday.example/organiser");
    expect(provider.signInRequests.at(-1)).toMatchObject({ expectedState: state });

    const unavailable = createRuntime(new UnavailableIdentityProvider());
    const unavailableApp = await buildApp({
      config: testConfig(),
      probes: healthyProbes,
      identityRuntime: unavailable,
    });
    apps.push(unavailableApp);
    const rejected = await signIn(unavailableApp);
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
  });

  it("keeps OIDC redirects exact, rejects tampered flows, and disables legacy production exchanges", async () => {
    provider.claims.subject = `oidc-boundary-${randomUUID()}`;
    provider.claims.email = `oidc-boundary-${randomUUID()}@example.test`;
    const oidcConfig = testConfig({
      APP_ENV: "test",
      API_ALLOWED_ORIGINS: allowedOrigin,
      ...oidcEnvironment(allowedOrigin, "http://127.0.0.1:4000"),
    });
    const app = await buildApp({ config: oidcConfig, probes: healthyProbes, identityRuntime: runtime });
    apps.push(app);

    for (const returnTo of ["https://attacker.example/capture", `${allowedOrigin}/evil`]) {
      const rejected = await app.inject({
        method: "GET",
        url: `/api/v1/identity/authorize?return_to=${encodeURIComponent(returnTo)}`,
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("REDIRECT_URI_REJECTED");
    }

    const authorization = await app.inject({
      method: "GET",
      url: `/api/v1/identity/authorize?return_to=${encodeURIComponent(`${allowedOrigin}/organiser`)}`,
    });
    expect(authorization.statusCode).toBe(302);
    const cookie = cookiePair(authorization.headers["set-cookie"]);
    const state = new URL(authorization.headers.location ?? "").searchParams.get("state");
    if (!state) throw new Error("Expected state");

    const wrongState = await app.inject({
      method: "GET",
      url: "/api/v1/identity/callback?code=provider-code-12345678&state=wrong-state-value-12345678901234567890",
      headers: { cookie },
    });
    expect(wrongState.statusCode).toBe(401);
    expect(wrongState.headers["set-cookie"]).toContain("Max-Age=0");

    const replacement = cookie.at(-1) === "a" ? "b" : "a";
    const tampered = await app.inject({
      method: "GET",
      url: `/api/v1/identity/callback?code=provider-code-12345678&state=${encodeURIComponent(state)}`,
      headers: { cookie: `${cookie.slice(0, -1)}${replacement}` },
    });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json().error.code).toBe("AUTHENTICATION_REQUIRED");

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/identity/sign-in",
          headers: { origin: allowedOrigin },
          payload: {
            authorization_code: "provider-code-12345678",
            redirect_uri: `${allowedOrigin}/auth/callback`,
            pkce_verifier: "v".repeat(43),
          },
        })
      ).statusCode,
    ).toBe(404);
    const recovery = await app.inject({ method: "GET", url: "/api/v1/identity/recovery" });
    expect(recovery.statusCode).toBe(303);
    expect(recovery.headers.location).toBe("https://identity.matchday.test/recover");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/identity/recovery",
          headers: { origin: allowedOrigin },
          payload: { email: "organiser@example.test", redirect_uri: `${allowedOrigin}/organiser` },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("returns 503 when the provider becomes unavailable during the OIDC callback", async () => {
    const unavailableDuringExchange: IdentityProviderPort = {
      async createAuthorizationUrl(request) {
        return `https://identity.matchday.test/authorize?state=${encodeURIComponent(request.state)}`;
      },
      async exchangeAuthorizationCode() {
        throw new Error("provider token endpoint timed out");
      },
      async requestRecovery() {
        throw new Error("provider-hosted recovery only");
      },
    };
    const oidcConfig = testConfig({
      APP_ENV: "test",
      API_ALLOWED_ORIGINS: allowedOrigin,
      ...oidcEnvironment(allowedOrigin, "http://127.0.0.1:4000"),
    });
    const app = await buildApp({
      config: oidcConfig,
      probes: healthyProbes,
      identityRuntime: createRuntime(unavailableDuringExchange),
    });
    apps.push(app);

    const authorization = await app.inject({
      method: "GET",
      url: `/api/v1/identity/authorize?return_to=${encodeURIComponent(`${allowedOrigin}/organiser`)}`,
    });
    const cookie = cookiePair(authorization.headers["set-cookie"]);
    const state = new URL(authorization.headers.location ?? "").searchParams.get("state");
    if (!state) throw new Error("Expected provider state");

    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/identity/callback?code=provider-code-12345678&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(503);
    expect(callback.json().error.code).toBe("IDENTITY_PROVIDER_UNAVAILABLE");
    expect(callback.headers["set-cookie"]).toContain("Max-Age=0");
  });
});
