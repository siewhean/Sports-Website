import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEmptyOwnedRedisNamespace,
  createRedisOwnership,
  unlinkOwnedRedisKeys,
} from "../../scripts/run-phase-4-real-e2e.js";
import { buildApp } from "../../src/app.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import type { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("distributed rate limiting", () => {
  it("cleans only the real E2E run namespace and preserves a near-prefix TTL guard", async () => {
    const redis = new Redis(testConfig().redisUrl, { maxRetriesPerRequest: 1 });
    const queueName = `matchday-phase4-real-e2e-${randomUUID()}`;
    const ownership = createRedisOwnership(queueName);
    const guardKey = `bull:${queueName}-foreign:ttl-sentinel`;
    const ownedKeys = [
      `bull:${queueName}:meta`,
      `bull:${queueName}.dead-letter:meta`,
      `matchday:job-cancellation:bull:${queueName}:job-1`,
      `${ownership.rateLimitNameSpace}ip:127.0.0.1`,
    ];
    try {
      await expect(assertEmptyOwnedRedisNamespace(redis, ownership)).resolves.toBe(0);
      const app = await buildApp({
        config: testConfig(),
        probes: healthyProbes,
        rateLimitRedis: new Redis(testConfig().redisUrl, { maxRetriesPerRequest: 1 }),
        rateLimitNameSpace: ownership.rateLimitNameSpace,
      });
      apps.push(app);
      await Promise.all([
        ...ownedKeys.slice(0, -1).map((key) => redis.set(key, "owned", "PX", 60_000)),
        redis.set(guardKey, "preserve", "PX", 60_000),
      ]);
      expect((await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode).toBe(200);
      expect(await redis.exists(ownedKeys.at(-1)!)).toBe(1);

      await expect(unlinkOwnedRedisKeys(redis, ownership)).resolves.toBe(0);
      await expect(Promise.all(ownedKeys.map((key) => redis.exists(key)))).resolves.toEqual([0, 0, 0, 0]);
      expect(await redis.get(guardKey)).toBe("preserve");
      expect(await redis.pttl(guardKey)).toBeGreaterThan(0);
    } finally {
      await redis.unlink(guardKey, ...ownedKeys);
      await redis.quit();
    }
  });

  it("shares authenticated-account limits across API instances and separates accounts", async () => {
    const config = testConfig();
    const nameSpace = `matchday-test-${randomUUID()}-`;
    const options = {
      config,
      probes: healthyProbes,
      authenticatedRateLimitMax: 2,
      anonymousRateLimitMax: 1,
      resolveRateLimitAccountId: (request: FastifyRequest) => {
        const value = request.headers["x-test-account-id"];
        return typeof value === "string" ? value : null;
      },
    };
    const first = await buildApp({
      ...options,
      rateLimitNameSpace: nameSpace,
      rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
    });
    const second = await buildApp({
      ...options,
      rateLimitNameSpace: nameSpace,
      rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
    });
    apps.push(first, second);

    const accountHeaders = { "x-test-account-id": "account-a" };
    expect((await first.inject({ method: "GET", url: "/api/v1/status", headers: accountHeaders })).statusCode).toBe(
      200,
    );
    expect((await second.inject({ method: "GET", url: "/api/v1/status", headers: accountHeaders })).statusCode).toBe(
      200,
    );
    const limited = await first.inject({ method: "GET", url: "/api/v1/status", headers: accountHeaders });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(limited.headers["x-ratelimit-limit"]).toBe("2");

    expect(
      (
        await second.inject({
          method: "GET",
          url: "/api/v1/status",
          headers: { "x-test-account-id": "account-b" },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("stores scoring-session limiter keys as dedicated HMAC fingerprints", async () => {
    const config = testConfig({
      SCORING_ACCESS_RATE_LIMIT_HMAC_SECRET: "dedicated-scoring-rate-limit-hmac-secret",
      IDENTITY_CSRF_HMAC_SECRET: "separate-csrf-hmac-secret-that-must-not-be-used",
      API_TRUSTED_PROXIES: "127.0.0.1",
    });
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
    const nameSpace = `matchday-test-${randomUUID()}-`;
    const sessionId = randomUUID();
    const clientIp = "198.51.100.202";
    const app = await buildApp({
      config,
      probes: healthyProbes,
      rateLimitNameSpace: nameSpace,
      rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
      anonymousRateLimitMax: 1,
      identityRuntime: {
        authenticate: async () => {
          throw new Error("Scoring-session requests do not use the organiser session");
        },
        verifyCsrfToken: () => false,
      } as unknown as IdentityApiRuntime,
      phase2Runtime: {
        heartbeatScoringSession: async () => ({}),
      } as unknown as Phase2Runtime,
    });
    apps.push(app);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/scoring/sessions/heartbeat",
        headers: {
          "x-forwarded-for": clientIp,
          "x-scoring-session-id": sessionId,
          "x-scoring-session-token": "t".repeat(43),
          "x-writer-generation": "1",
        },
        payload: { last_acknowledged_sequence: 0, pending_event_count: 0, pending_through_sequence: 0 },
      });
      expect(response.statusCode).toBe(200);

      const keys = await redis.keys(`${nameSpace}*`);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(new RegExp(`^${nameSpace}scoring-session:[a-f0-9]{64}:ip:[a-f0-9]{64}$`));
      expect(keys[0]).not.toContain(sessionId);
      expect(keys[0]).not.toContain(clientIp);
    } finally {
      const keys = await redis.keys(`${nameSpace}*`);
      if (keys.length > 0) await redis.unlink(...keys);
      await redis.quit();
    }
  });
});
