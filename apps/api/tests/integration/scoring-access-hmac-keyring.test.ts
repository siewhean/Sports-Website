import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import { Redis } from "ioredis";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { RedisScoringAccessRateLimiter, type ScoringAccessRateLimiter } from "../../src/scoring-access-rate-limit.js";
import {
  reconcileScoringAccessHmacKeyring,
  retireScoringAccessHmacKeyVersion,
  scoringAccessHmacRetirementRedisTtlSeconds,
} from "../../src/scoring-access-hmac-keyring.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const runInfraTests = process.env.RUN_INFRA_TESTS === "1";
const describeInfra = runInfraTests ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
const schema = `test_scoring_access_hmac_keyring_${randomUUID().replaceAll("-", "")}`;
const redisNamespace = `matchday:test:scoring-access-hmac-keyring:${randomUUID()}:`;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

function legacyV1MaterialCommitment(secret: string): string {
  return createHash("sha256")
    .update("matchday:scoring-access-hmac-key-material:v1:\u0000", "utf8")
    .update(secret, "utf8")
    .digest("hex");
}

let sql: Sql;
let redis: Redis;

async function redisKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${redisNamespace}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

describeInfra("scoring access HMAC key lifecycle", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined, connection: { search_path: schema } });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    expect(await redisKeys()).toEqual([]);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    const keys = await redisKeys();
    if (keys.length > 0) await redis.unlink(...keys);
    await redis?.quit();
    await dropTestSchema(databaseUrl, schema);
  });

  it("registers a promoted primary, fences retirement on exact state expiry, and never reactivates retired versions", async () => {
    const clock = new Date(Date.now() - (scoringAccessHmacRetirementRedisTtlSeconds + 60) * 1_000);
    const platformAdmin = randomUUID();
    await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${platformAdmin},${`${platformAdmin}@example.test`},'C5 platform admin')`;
    await sql`
      INSERT INTO account_platform_roles(account_id,role,granted_at,reason)
      VALUES(${platformAdmin},'platform_admin',${clock},'C5 HMAC rotation rehearsal')
    `;
    const legacyV1Secret = "c5-legacy-rate-limit-hmac-secret-material";
    const keyring = {
      primary: { version: "v2", secret: "c5-primary-rate-limit-hmac-secret-material" },
      verificationOnly: [{ version: "v1", secret: legacyV1Secret }],
      legacyV1MaterialCommitment: legacyV1MaterialCommitment(legacyV1Secret),
    };
    const lifecycleMetrics: Record<string, unknown>[] = [];
    const hmacMetrics = {
      rateLimit: (input: Record<string, unknown>) => lifecycleMetrics.push(input),
      lifecycle: (input: Record<string, unknown>) => lifecycleMetrics.push(input),
    };
    const failedLifecycleMetrics: Record<string, unknown>[] = [];
    await expect(
      reconcileScoringAccessHmacKeyring(
        sql as unknown as PostgresJsSql,
        { ...keyring, legacyV1MaterialCommitment: "f".repeat(64) },
        clock,
        {
          rateLimit: (input: Record<string, unknown>) => failedLifecycleMetrics.push(input),
          lifecycle: (input: Record<string, unknown>) => failedLifecycleMetrics.push(input),
        },
      ),
    ).rejects.toThrow("does not match");
    expect(failedLifecycleMetrics).toEqual([]);
    const promoted = await reconcileScoringAccessHmacKeyring(
      sql as unknown as PostgresJsSql,
      keyring,
      clock,
      hmacMetrics,
    );
    expect(promoted).toEqual({
      primaryVersion: "v2",
      verificationOnlyVersions: ["v1"],
      registeredVersions: [
        { version: "v1", status: "verification_only" },
        { version: "v2", status: "primary" },
      ],
    });
    expect(lifecycleMetrics).toEqual([
      { keyVersion: "v1", action: "verification_only" },
      { keyVersion: "v2", action: "activated" },
    ]);
    expect(JSON.stringify(lifecycleMetrics)).not.toContain("c5-primary-rate-limit-hmac-secret-material");
    await expect(
      reconcileScoringAccessHmacKeyring(
        sql as unknown as PostgresJsSql,
        {
          primary: { version: "v2", secret: "different-c5-primary-rate-limit-hmac-material" },
          verificationOnly: keyring.verificationOnly,
        },
        clock,
      ),
    ).rejects.toThrow("different key material");
    expect(lifecycleMetrics).toHaveLength(2);
    const stateExpiresAt = new Date(clock.getTime() + (scoringAccessHmacRetirementRedisTtlSeconds + 120) * 1_000);
    await sql`
      INSERT INTO scoring_access_attempts(
        credential_kind,outcome,credential_hmac,ip_hmac,hmac_key_version,request_id,
        attempted_at,rate_limit_state_expires_at
      ) VALUES(
        'token','invalid',${Buffer.alloc(32, 1)},${Buffer.alloc(32, 2)},'v1',${`active-v1-${randomUUID()}`},
        ${clock},${stateExpiresAt}
      )
    `;
    const afterRedisRetention = new Date(clock.getTime() + (scoringAccessHmacRetirementRedisTtlSeconds + 1) * 1_000);
    await expect(
      retireScoringAccessHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        { keyVersion: "v1", accountId: randomUUID(), requestId: `unauthorised-${randomUUID()}`, reason: "Must fail" },
        afterRedisRetention,
      ),
    ).rejects.toMatchObject({ code: "PLATFORM_ADMIN_REQUIRED", statusCode: 403 });
    await expect(
      retireScoringAccessHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        {
          keyVersion: "v1",
          accountId: platformAdmin,
          requestId: `retire-v1-${randomUUID()}`,
          reason: "Rotation rehearsal",
        },
        afterRedisRetention,
      ),
    ).rejects.toThrow("active access-attempt retention");

    const withAdditionalPrevious = await reconcileScoringAccessHmacKeyring(
      sql as unknown as PostgresJsSql,
      {
        ...keyring,
        verificationOnly: [
          ...keyring.verificationOnly,
          { version: "v0", secret: "c5-earlier-rate-limit-hmac-secret-material" },
        ],
      },
      clock,
    );
    expect(withAdditionalPrevious.registeredVersions).toContainEqual({ version: "v0", status: "verification_only" });
    await reconcileScoringAccessHmacKeyring(
      sql as unknown as PostgresJsSql,
      {
        ...keyring,
        verificationOnly: [
          ...keyring.verificationOnly,
          { version: "v0", secret: "c5-earlier-rate-limit-hmac-secret-material" },
          { version: "v3", secret: "c5-pending-rate-limit-hmac-secret-material" },
        ],
      },
      new Date(),
    );
    const identityRuntime = {
      authenticate: vi.fn(async (sessionToken: string) => ({
        account: {
          id: sessionToken === "non-admin" ? "00000000-0000-4000-8000-000000000001" : platformAdmin,
          primaryEmail: `${platformAdmin}@example.test`,
          displayName: "C5 platform admin",
          status: "active",
          emailVerifiedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        sessionId: randomUUID(),
        sessionToken,
        csrfToken: "csrf-ok",
        idleExpiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 60_000),
      })),
      verifyCsrfToken: vi.fn(
        (sessionToken: string, csrf: string) =>
          (sessionToken === "session" || sessionToken === "non-admin") && csrf === "csrf-ok",
      ),
    } as unknown as IdentityApiRuntime;
    const app = await buildApp({
      config: testConfig({ DATABASE_URL: databaseUrl }),
      probes: healthyProbes,
      identityRuntime,
      scoringAccessHmacKeySql: sql as unknown as PostgresJsSql,
    });
    try {
      const unauthenticated = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v0/retire",
        headers: { origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
        payload: { reason: "Rotation rehearsal" },
      });
      expect(unauthenticated.statusCode).toBe(401);
      const rejectedOrigin = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v0/retire",
        headers: { cookie: "matchday_session=session", origin: "https://attacker.example", "x-csrf-token": "csrf-ok" },
        payload: { reason: "Rotation rehearsal" },
      });
      expect(rejectedOrigin.statusCode).toBe(403);
      expect(rejectedOrigin.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
      const rejectedCsrf = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v0/retire",
        headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "wrong" },
        payload: { reason: "Rotation rehearsal" },
      });
      expect(rejectedCsrf.statusCode).toBe(403);
      expect(rejectedCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });
      const nonAdmin = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v0/retire",
        headers: { cookie: "matchday_session=non-admin", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
        payload: { reason: "Rotation rehearsal" },
      });
      expect(nonAdmin.statusCode).toBe(403);
      expect(nonAdmin.json()).toMatchObject({ error: { code: "PLATFORM_ADMIN_REQUIRED" } });
      const invalidBody = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v0/retire",
        headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
        payload: { reason: "Rotation rehearsal", unexpected: true },
      });
      expect(invalidBody.statusCode).toBe(422);
      const unknownState = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v999/retire",
        headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
        payload: { reason: "Rotation rehearsal" },
      });
      expect(unknownState.statusCode).toBe(409);
      expect(unknownState.json()).toMatchObject({ error: { code: "SCORING_ACCESS_HMAC_KEY_VERSION_UNKNOWN" } });
      const primaryState = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v2/retire",
        headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
        payload: { reason: "Rotation rehearsal" },
      });
      expect(primaryState.statusCode).toBe(409);
      expect(primaryState.json()).toMatchObject({ error: { code: "SCORING_ACCESS_HMAC_KEY_VERSION_PRIMARY" } });
      const activeState = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v1/retire",
        headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
        payload: { reason: "Rotation rehearsal" },
      });
      expect(activeState.statusCode).toBe(409);
      expect(activeState.json()).toMatchObject({ error: { code: "SCORING_ACCESS_HMAC_KEY_VERSION_ACTIVE_STATE" } });
      const ttlPending = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v3/retire",
        headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
        payload: { reason: "Rotation rehearsal" },
      });
      expect(ttlPending.statusCode).toBe(409);
      expect(ttlPending.json()).toMatchObject({ error: { code: "SCORING_ACCESS_HMAC_KEY_VERSION_RETENTION_PENDING" } });
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/scoring-access-hmac-key-versions/v0/retire",
        headers: { cookie: "matchday_session=session", origin: "http://127.0.0.1:3000", "x-csrf-token": "csrf-ok" },
        payload: { reason: "Rotation rehearsal" },
      });
      expect(response.statusCode, response.body).toBe(204);
    } finally {
      await app.close();
    }
    await expect(sql`
      INSERT INTO scoring_access_attempts(
        credential_kind,outcome,credential_hmac,ip_hmac,hmac_key_version,request_id,rate_limit_state_expires_at
      ) VALUES(
        'token','invalid',${Buffer.alloc(32, 8)},${Buffer.alloc(32, 9)},'v0',${`stale-direct-${randomUUID()}`},now()
      )
    `).rejects.toThrow(/is retired/i);
    const staleLimiter = new RedisScoringAccessRateLimiter(
      redis,
      { primary: { version: "v0", secret: "c5-earlier-rate-limit-hmac-secret-material" }, verificationOnly: [] },
      redisNamespace,
    );
    const currentLimiter = new RedisScoringAccessRateLimiter(
      redis,
      {
        primary: { version: "v2", secret: "c5-primary-rate-limit-hmac-secret-material" },
        verificationOnly: [{ version: "v1", secret: "c5-legacy-rate-limit-hmac-secret-material" }],
      },
      redisNamespace,
    );
    const currentRuntime = new Phase2Runtime(
      sql as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(),
      currentLimiter,
      "c5-current-runtime-fallback-code-secret",
    );
    const staleRuntime = new Phase2Runtime(
      sql as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(),
      staleLimiter,
      "c5-stale-runtime-fallback-code-secret",
    );
    await expect(
      staleRuntime.exchangeAccess(
        { token: "x".repeat(43), deviceId: randomUUID(), ipAddress: "198.51.100.47" },
        `stale-runtime-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({ code: "SCORING_ACCESS_HMAC_KEY_VERSION_RETIRED", statusCode: 409 });
    expect(currentRuntime).toBeInstanceOf(Phase2Runtime);
    expect(await redisKeys()).toEqual([]);
    expect(
      await sql<{ count: string }[]>`
        SELECT count(*)::text count FROM scoring_access_attempts WHERE hmac_key_version='v0'
      `,
    ).toEqual([{ count: "0" }]);
    await expect(
      reconcileScoringAccessHmacKeyring(
        sql as unknown as PostgresJsSql,
        {
          ...keyring,
          verificationOnly: [
            ...keyring.verificationOnly,
            { version: "v0", secret: "c5-earlier-rate-limit-hmac-secret-material" },
            { version: "v3", secret: "c5-pending-rate-limit-hmac-secret-material" },
          ],
        },
        afterRedisRetention,
      ),
    ).rejects.toThrow("is retired");
    await expect(sql`
      UPDATE scoring_access_hmac_key_versions SET status='verification_only',retired_at=NULL
      WHERE key_version='v0'
    `).rejects.toThrow(/cannot be reactivated/i);
    await expect(sql`DELETE FROM scoring_access_hmac_key_versions WHERE key_version='v0'`).rejects.toThrow(
      /immutable access-attempt evidence/i,
    );

    const completed = await reconcileScoringAccessHmacKeyring(
      sql as unknown as PostgresJsSql,
      {
        ...keyring,
        verificationOnly: [
          ...keyring.verificationOnly,
          { version: "v3", secret: "c5-pending-rate-limit-hmac-secret-material" },
        ],
      },
      afterRedisRetention,
    );
    expect(completed.registeredVersions).toContainEqual({ version: "v0", status: "retired" });
    const audit = await sql<{ action: string; target_id: string; metadata: Record<string, unknown> }[]>`
      SELECT action,target_id,metadata
      FROM audit_events
      WHERE target_type='scoring_access_hmac_key_version'
      ORDER BY occurred_at,target_id
    `;
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "scoring_access_hmac_key.activated", target_id: "v2" }),
        expect.objectContaining({ action: "scoring_access_hmac_key.verification_only", target_id: "v1" }),
        expect.objectContaining({ action: "scoring_access_hmac_key.retired", target_id: "v0" }),
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain("c5-primary-rate-limit-hmac-secret-material");
    await expect(
      reconcileScoringAccessHmacKeyring(
        sql as unknown as PostgresJsSql,
        {
          ...keyring,
          verificationOnly: [
            ...keyring.verificationOnly,
            { version: "v3", secret: "c5-pending-rate-limit-hmac-secret-material" },
            { version: "v4", secret: "c5-metrics-rate-limit-hmac-secret-material" },
          ],
        },
        afterRedisRetention,
        {
          rateLimit: () => undefined,
          lifecycle: () => {
            throw new Error("telemetry unavailable");
          },
        },
      ),
    ).resolves.toMatchObject({
      registeredVersions: expect.arrayContaining([{ version: "v4", status: "verification_only" }]),
    });
  });

  it("serializes primary demotion with an in-flight real-Redis receipt before retirement", async () => {
    const platformAdmin = randomUUID();
    const now = new Date();
    await sql`INSERT INTO accounts(id,primary_email,display_name) VALUES(${platformAdmin},${`${platformAdmin}@example.test`},'C5 race admin')`;
    await sql`
      INSERT INTO account_platform_roles(account_id,role,granted_at,reason)
      VALUES(${platformAdmin},'platform_admin',${now},'C5 HMAC race rehearsal')
    `;
    const legacyV1Secret = "c5-legacy-rate-limit-hmac-secret-material";
    const promotionClock = new Date(now.getTime() - (scoringAccessHmacRetirementRedisTtlSeconds + 60) * 1_000);
    const beforeRotation = {
      primary: { version: "v2", secret: "c5-primary-rate-limit-hmac-secret-material" },
      verificationOnly: [
        { version: "v1", secret: legacyV1Secret },
        { version: "v3", secret: "c5-pending-rate-limit-hmac-secret-material" },
        { version: "v4", secret: "c5-metrics-rate-limit-hmac-secret-material" },
        { version: "v5", secret: "c5-race-rate-limit-hmac-secret-material" },
      ],
      legacyV1MaterialCommitment: legacyV1MaterialCommitment(legacyV1Secret),
    };
    await reconcileScoringAccessHmacKeyring(sql as unknown as PostgresJsSql, beforeRotation, promotionClock);

    let releaseInvalidWrite: (() => void) | undefined;
    let invalidWriteReached: (() => void) | undefined;
    const invalidWriteGate = new Promise<void>((resolve) => {
      releaseInvalidWrite = resolve;
    });
    const invalidWriteStarted = new Promise<void>((resolve) => {
      invalidWriteReached = resolve;
    });
    const delegate = new RedisScoringAccessRateLimiter(
      redis,
      { primary: beforeRotation.primary, verificationOnly: [] },
      redisNamespace,
      { windowSeconds: 1, cooldownSeconds: 1, pairLimit: 5, ipLimit: 20 },
    );
    const guardedLimiter: ScoringAccessRateLimiter = {
      primaryKeyVersion: () => delegate.primaryKeyVersion(),
      fingerprints: (credential, ipAddress) => delegate.fingerprints(credential, ipAddress),
      assertAllowed: (credential, ipAddress) => delegate.assertAllowed(credential, ipAddress),
      recordInvalid: async (credential, ipAddress) => {
        invalidWriteReached?.();
        await invalidWriteGate;
        return delegate.recordInvalid(credential, ipAddress);
      },
      recordSuccess: (credential, ipAddress) => delegate.recordSuccess(credential, ipAddress),
    };
    const runtime = new Phase2Runtime(
      sql as unknown as PostgresJsSql,
      phase2DomainAdapter,
      () => new Date(),
      guardedLimiter,
      "c5-guarded-runtime-fallback-code-secret",
    );
    const invalidExchange = runtime.exchangeAccess(
      { token: "y".repeat(43), deviceId: randomUUID(), ipAddress: "198.51.100.46" },
      `guarded-runtime-${randomUUID()}`,
    );
    await invalidWriteStarted;
    let rotationSettled = false;
    const concurrentRotation = reconcileScoringAccessHmacKeyring(
      sql as unknown as PostgresJsSql,
      {
        primary: { version: "v5", secret: "c5-race-rate-limit-hmac-secret-material" },
        verificationOnly: [
          { version: "v1", secret: legacyV1Secret },
          { version: "v2", secret: "c5-primary-rate-limit-hmac-secret-material" },
          { version: "v3", secret: "c5-pending-rate-limit-hmac-secret-material" },
          { version: "v4", secret: "c5-metrics-rate-limit-hmac-secret-material" },
        ],
        legacyV1MaterialCommitment: legacyV1MaterialCommitment(legacyV1Secret),
      },
      promotionClock,
    ).finally(() => {
      rotationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(rotationSettled).toBe(false);
    releaseInvalidWrite?.();
    await expect(invalidExchange).rejects.toMatchObject({ code: "ACCESS_DENIED", statusCode: 403 });
    await expect(concurrentRotation).resolves.toMatchObject({ primaryVersion: "v5" });
    expect(await redisKeys()).toEqual(expect.arrayContaining([expect.stringContaining(":v:v2:")]));
    await expect(
      retireScoringAccessHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        {
          keyVersion: "v2",
          accountId: platformAdmin,
          requestId: `retire-v2-active-${randomUUID()}`,
          reason: "Race rehearsal",
        },
        new Date(),
      ),
    ).rejects.toMatchObject({ code: "SCORING_ACCESS_HMAC_KEY_VERSION_ACTIVE_STATE" });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      retireScoringAccessHmacKeyVersion(
        sql as unknown as PostgresJsSql,
        {
          keyVersion: "v2",
          accountId: platformAdmin,
          requestId: `retire-v2-expired-${randomUUID()}`,
          reason: "Race rehearsal",
        },
        new Date(),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects unknown persisted key versions and omitted non-retired registry versions", async () => {
    await expect(sql`
      INSERT INTO scoring_access_attempts(
        credential_kind,outcome,credential_hmac,ip_hmac,hmac_key_version,request_id,rate_limit_state_expires_at
      ) VALUES(
        'token','invalid',${Buffer.alloc(32, 3)},${Buffer.alloc(32, 4)},'v999',${`unknown-${randomUUID()}`},now()
      )
    `).rejects.toThrow();
    await expect(
      reconcileScoringAccessHmacKeyring(sql as unknown as PostgresJsSql, {
        primary: { version: "v2", secret: "c5-primary-rate-limit-hmac-secret-material" },
        verificationOnly: [],
      }),
    ).rejects.toThrow("omits non-retired key version");
  });
});
