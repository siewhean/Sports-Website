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
import { anonymousRateLimitKey, scoringSessionRateLimitKey } from "../../src/scoring-rate-limit-identity.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function scoringRuntime(): Phase2Runtime {
  return {
    heartbeatScoringSession: async () => ({}),
  } as unknown as Phase2Runtime;
}

function unavailableOrganiserIdentity(): IdentityApiRuntime {
  return {
    authenticate: async () => {
      throw new Error("Scoring-session requests do not use the organiser session");
    },
    verifyCsrfToken: () => false,
  } as unknown as IdentityApiRuntime;
}

function verifiedScoringResolver(validSessions: ReadonlyMap<string, string>) {
  return (request: FastifyRequest): string | null => {
    const sessionId = request.headers["x-scoring-session-id"];
    const token = request.headers["x-scoring-session-token"];
    if (typeof sessionId !== "string" || typeof token !== "string") return null;
    return validSessions.get(sessionId) === token ? sessionId : null;
  };
}

function scoringRequest(
  app: Awaited<ReturnType<typeof buildApp>>,
  input: { clientIp: string; sessionId: string; token: string },
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/scoring/sessions/heartbeat",
    headers: {
      "x-forwarded-for": input.clientIp,
      "x-scoring-session-id": input.sessionId,
      "x-scoring-session-token": input.token,
      "x-writer-generation": "1",
    },
    payload: { last_acknowledged_sequence: 0, pending_event_count: 0, pending_through_sequence: 0 },
  });
}

async function ownedRateLimitKeys(redis: Redis, nameSpace: string): Promise<string[]> {
  return (await redis.keys(`${nameSpace}*`)).sort();
}

describe("distributed rate limiting", () => {
  it("cleans only the real E2E run namespace and preserves a near-prefix TTL guard", async () => {
    const config = testConfig();
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
    const queueName = `matchday-phase4-real-e2e-${randomUUID()}`;
    const ownership = createRedisOwnership(queueName);
    const guardKey = `bull:${queueName}-foreign:ttl-sentinel`;
    const ownedKeys = [
      `bull:${queueName}:meta`,
      `bull:${queueName}.dead-letter:meta`,
      `matchday:job-cancellation:bull:${queueName}:job-1`,
      `${ownership.rateLimitNameSpace}${anonymousRateLimitKey(
        "127.0.0.1",
        config.scoringAccess.rateLimitHmacSecret,
      )}`,
    ];
    try {
      await expect(assertEmptyOwnedRedisNamespace(redis, ownership)).resolves.toBe(0);
      const app = await buildApp({
        config,
        probes: healthyProbes,
        rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
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

  it("keeps unverified scoring credentials in one HMAC IP bucket even when session ids rotate", async () => {
    const config = testConfig({ API_TRUSTED_PROXIES: "127.0.0.1" });
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
    const nameSpace = `matchday-test-${randomUUID()}-`;
    const clientIp = "198.51.100.202";
    const app = await buildApp({
      config,
      probes: healthyProbes,
      rateLimitNameSpace: nameSpace,
      rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
      anonymousRateLimitMax: 1,
      identityRuntime: unavailableOrganiserIdentity(),
      phase2Runtime: scoringRuntime(),
      resolveVerifiedScoringRateLimitSessionId: verifiedScoringResolver(new Map()),
    });
    apps.push(app);
    try {
      expect(
        (await scoringRequest(app, { clientIp, sessionId: randomUUID(), token: "t".repeat(43) })).statusCode,
      ).toBe(200);
      const limited = await scoringRequest(app, { clientIp, sessionId: randomUUID(), token: "x".repeat(43) });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("RATE_LIMITED");

      const expectedKey = `${nameSpace}${anonymousRateLimitKey(clientIp, config.scoringAccess.rateLimitHmacSecret)}`;
      expect(await ownedRateLimitKeys(redis, nameSpace)).toEqual([expectedKey]);
      expect(expectedKey).not.toContain(clientIp);
    } finally {
      const keys = await ownedRateLimitKeys(redis, nameSpace);
      if (keys.length > 0) await redis.unlink(...keys);
      await redis.quit();
    }
  });

  it("separates verified scoring sessions behind one shared IP without storing raw identifiers", async () => {
    const config = testConfig({ API_TRUSTED_PROXIES: "127.0.0.1" });
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
    const nameSpace = `matchday-test-${randomUUID()}-`;
    const clientIp = "198.51.100.203";
    const firstSession = randomUUID();
    const secondSession = randomUUID();
    const firstToken = "a".repeat(43);
    const secondToken = "b".repeat(43);
    const validSessions = new Map([
      [firstSession, firstToken],
      [secondSession, secondToken],
    ]);
    const app = await buildApp({
      config,
      probes: healthyProbes,
      rateLimitNameSpace: nameSpace,
      rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
      anonymousRateLimitMax: 1,
      scoringSessionRateLimitMax: 1,
      identityRuntime: unavailableOrganiserIdentity(),
      phase2Runtime: scoringRuntime(),
      resolveVerifiedScoringRateLimitSessionId: verifiedScoringResolver(validSessions),
    });
    apps.push(app);
    try {
      expect(
        (await scoringRequest(app, { clientIp, sessionId: firstSession, token: firstToken })).statusCode,
      ).toBe(200);
      expect(
        (await scoringRequest(app, { clientIp, sessionId: secondSession, token: secondToken })).statusCode,
      ).toBe(200);
      expect(
        (await scoringRequest(app, { clientIp, sessionId: firstSession, token: firstToken })).statusCode,
      ).toBe(429);

      const keys = await ownedRateLimitKeys(redis, nameSpace);
      expect(keys).toEqual(
        [
          `${nameSpace}${scoringSessionRateLimitKey(
            firstSession,
            clientIp,
            config.scoringAccess.rateLimitHmacSecret,
          )}`,
          `${nameSpace}${scoringSessionRateLimitKey(
            secondSession,
            clientIp,
            config.scoringAccess.rateLimitHmacSecret,
          )}`,
        ].sort(),
      );
      for (const key of keys) {
        expect(key).not.toContain(firstSession);
        expect(key).not.toContain(secondSession);
        expect(key).not.toContain(clientIp);
      }
    } finally {
      const keys = await ownedRateLimitKeys(redis, nameSpace);
      if (keys.length > 0) await redis.unlink(...keys);
      await redis.quit();
    }
  });

  it("shares one verified scoring-session quota across API instances", async () => {
    const config = testConfig({ API_TRUSTED_PROXIES: "127.0.0.1" });
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
    const nameSpace = `matchday-test-${randomUUID()}-`;
    const clientIp = "198.51.100.204";
    const sessionId = randomUUID();
    const token = "c".repeat(43);
    const validSessions = new Map([[sessionId, token]]);
    const options = {
      config,
      probes: healthyProbes,
      rateLimitNameSpace: nameSpace,
      scoringSessionRateLimitMax: 2,
      anonymousRateLimitMax: 1,
      identityRuntime: unavailableOrganiserIdentity(),
      phase2Runtime: scoringRuntime(),
      resolveVerifiedScoringRateLimitSessionId: verifiedScoringResolver(validSessions),
    };
    const first = await buildApp({
      ...options,
      rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
    });
    const second = await buildApp({
      ...options,
      rateLimitRedis: new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }),
    });
    apps.push(first, second);
    try {
      expect((await scoringRequest(first, { clientIp, sessionId, token })).statusCode).toBe(200);
      expect((await scoringRequest(second, { clientIp, sessionId, token })).statusCode).toBe(200);
      const limited = await scoringRequest(first, { clientIp, sessionId, token });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["x-ratelimit-limit"]).toBe("2");

      const key = `${nameSpace}${scoringSessionRateLimitKey(
        sessionId,
        clientIp,
        config.scoringAccess.rateLimitHmacSecret,
      )}`;
      expect(await ownedRateLimitKeys(redis, nameSpace)).toEqual([key]);
      expect(key).not.toContain(sessionId);
      expect(key).not.toContain(clientIp);
    } finally {
      const keys = await ownedRateLimitKeys(redis, nameSpace);
      if (keys.length > 0) await redis.unlink(...keys);
      await redis.quit();
    }
  });
});
