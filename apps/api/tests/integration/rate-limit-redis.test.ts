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
});
