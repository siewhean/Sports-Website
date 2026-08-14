import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import { type Clock, type PostgresJsSql } from "@matchday/identity";
import { DeterministicIdentityProvider } from "@matchday/identity/testing";
import postgres from "postgres";
import { buildApp } from "../../src/app.js";
import { IdentityAssuranceRuntime } from "../../src/identity-assurance-runtime.js";
import { PostgresIdentityUnitOfWork } from "../../src/identity-postgres.js";
import { healthyProbes, testConfig } from "../helpers.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const schema = `test_identity_assurance_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const now = new Date("2026-08-14T00:00:00.000Z");
const clock: Clock = { now: () => now };

let sql: ReturnType<typeof postgres>;
let identitySql: PostgresJsSql;
let provider: DeterministicIdentityProvider;

function cookiePair(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0] ?? "";
}

function tokenFromCookie(cookie: string): string {
  const separator = cookie.indexOf("=");
  if (separator < 1) throw new Error("Expected a cookie pair");
  return decodeURIComponent(cookie.slice(separator + 1));
}

function allowedOrigin(): string {
  const origin = testConfig().api.allowedOrigins[0];
  if (!origin) throw new Error("Test configuration requires an allowed origin");
  return origin;
}

function runtime(minimum: "off" | "mfa" | "phishing_resistant") {
  return new IdentityAssuranceRuntime(
    provider,
    new PostgresIdentityUnitOfWork(identitySql),
    "identity-assurance-integration-csrf-secret-at-least-32-bytes",
    clock,
    { minimum },
  );
}

async function signIn(
  app: Awaited<ReturnType<typeof buildApp>>,
  existingCookie?: string,
): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/identity/sign-in",
    headers: {
      origin: allowedOrigin(),
      ...(existingCookie ? { cookie: existingCookie } : {}),
    },
    payload: {
      authorization_code: "provider-code-12345678",
      redirect_uri: `${allowedOrigin()}/auth/callback`,
      pkce_verifier: "v".repeat(43),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return {
    cookie: cookiePair(response.headers["set-cookie"]),
    csrf: response.json().csrf_token as string,
  };
}

beforeAll(async () => {
  await dropTestSchema(databaseUrl, schema);
  await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
  sql = postgres(databaseUrl, { max: 10, onnotice: () => undefined, connection: { search_path: schema } });
  identitySql = sql as unknown as PostgresJsSql;
  provider = new DeterministicIdentityProvider({
    issuer: "https://identity.example.test",
    subject: "assurance-subject",
    providerSessionId: "provider-session-1",
    email: "organiser@example.test",
    emailVerified: true,
    displayName: "Assurance Organiser",
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 1 });
  await dropTestSchema(databaseUrl, schema);
});

describe("database-backed authentication assurance", () => {
  it("persists assurance, gates organiser access, preserves sign-out, and rejects displaced-session replay", async () => {
    const config = testConfig();
    const strictRuntime = runtime("phishing_resistant");
    const app = await buildApp({ config, probes: healthyProbes, identityRuntime: strictRuntime });
    apps.push(app);

    delete provider.claims.assurance;
    const low = await signIn(app);
    const lowMe = await app.inject({ method: "GET", url: "/api/v1/identity/me", headers: { cookie: low.cookie } });
    expect(lowMe.statusCode).toBe(403);
    expect(lowMe.json().error.code).toBe("STEP_UP_REQUIRED");

    const lowSignOut = await app.inject({
      method: "POST",
      url: "/api/v1/identity/sign-out",
      headers: { cookie: low.cookie, origin: allowedOrigin(), "x-csrf-token": low.csrf },
    });
    expect(lowSignOut.statusCode, lowSignOut.body).toBe(204);

    provider.claims.providerSessionId = "provider-session-2";
    provider.claims.assurance = {
      methods: ["pwd", "mfa"],
      acr: "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
      authenticatedAt: now,
      phishingResistant: false,
    };
    const genericMfa = await signIn(app);
    const genericMe = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { cookie: genericMfa.cookie },
    });
    expect(genericMe.statusCode).toBe(403);
    expect(genericMe.json().error.code).toBe("STEP_UP_REQUIRED");

    const displacedToken = tokenFromCookie(genericMfa.cookie);
    const displacedSessionId = displacedToken.split(".", 1)[0];
    if (!displacedSessionId) throw new Error("Expected displaced session id");

    provider.claims.providerSessionId = "provider-session-3";
    provider.claims.assurance = {
      methods: ["pwd", "mfa"],
      acr: "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
      authenticatedAt: now,
      phishingResistant: true,
    };
    const strong = await signIn(app, genericMfa.cookie);
    const strongToken = tokenFromCookie(strong.cookie);
    const strongSessionId = strongToken.split(".", 1)[0];
    if (!strongSessionId) throw new Error("Expected replacement session id");

    const strongMe = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { cookie: strong.cookie },
    });
    expect(strongMe.statusCode, strongMe.body).toBe(200);

    const assuranceRows = await sql.unsafe<
      {
        assurance_level: string;
        mfa_performed: boolean;
        phishing_resistant: boolean;
      }[]
    >(
      `SELECT assurance_level, mfa_performed, phishing_resistant
       FROM identity_session_assurance WHERE session_id=$1`,
      [strongSessionId],
    );
    expect(assuranceRows[0]).toEqual({
      assurance_level: "phishing_resistant",
      mfa_performed: true,
      phishing_resistant: true,
    });

    const displacedRows = await sql.unsafe<{ revoked_at: Date | string | null }[]>(
      `SELECT revoked_at FROM identity_sessions WHERE id=$1`,
      [displacedSessionId],
    );
    expect(displacedRows[0]?.revoked_at).not.toBeNull();

    const replay = await app.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { cookie: genericMfa.cookie },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("AUTHENTICATION_REQUIRED");

    const relaxedApp = await buildApp({ config, probes: healthyProbes, identityRuntime: runtime("off") });
    apps.push(relaxedApp);
    const replayAfterPolicyRelaxation = await relaxedApp.inject({
      method: "GET",
      url: "/api/v1/identity/me",
      headers: { cookie: genericMfa.cookie },
    });
    expect(replayAfterPolicyRelaxation.statusCode).toBe(401);

    const audits = await sql.unsafe<{ action: string; reason: string | null; target_id: string }[]>(
      `SELECT action, reason, target_id FROM audit_events
       WHERE target_id IN ($1,$2) ORDER BY occurred_at, id`,
      [displacedSessionId, strongSessionId],
    );
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "identity.session.revoked",
          reason: "session_replaced",
          target_id: displacedSessionId,
        }),
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain(displacedToken);
    expect(JSON.stringify(audits)).not.toContain(strongToken);
  });
});
