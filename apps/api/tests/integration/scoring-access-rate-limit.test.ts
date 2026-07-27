import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisScoringAccessRateLimiter, scoringAccessRateLimited } from "../../src/scoring-access-rate-limit.js";

const runInfraTests = process.env.RUN_INFRA_TESTS === "1";
const describeInfra = runInfraTests ? describe : describe.skip;
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
const namespace = `matchday:test:scoring-access:${randomUUID()}:`;
const guardKey = `${namespace.slice(0, -1)}-unrelated-guard`;
const secret = "gate-c-scoring-access-test-hmac-secret";
let redis: Redis;

async function ownedKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${namespace}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

describeInfra("Redis scoring access rate limiting", () => {
  beforeAll(async () => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    expect(await ownedKeys()).toEqual([]);
    await redis.set(guardKey, "preserve", "EX", 60);
  });

  afterAll(async () => {
    const keys = await ownedKeys();
    if (keys.length > 0) await redis.unlink(...keys);
    expect(await ownedKeys()).toEqual([]);
    expect(await redis.get(guardKey)).toBe("preserve");
    await redis.unlink(guardKey);
    await redis.quit();
  });

  it("shares the five-invalid pair cooldown across limiter instances without raw identifiers", async () => {
    const first = new RedisScoringAccessRateLimiter(redis, secret, namespace);
    const second = new RedisScoringAccessRateLimiter(redis, secret, namespace);
    const credential = "raw-access-secret-must-not-appear";
    const ip = "203.0.113.24";
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(scoringAccessRateLimited(await first.recordInvalid(credential, ip))).toBe(false);
    }
    const limited = await first.recordInvalid(credential, ip);
    expect(scoringAccessRateLimited(limited)).toBe(true);
    expect(limited.retryAfterSeconds).toBe(900);
    expect(scoringAccessRateLimited(await second.assertAllowed(credential, ip))).toBe(true);
    const unrelatedCredential = await second.assertAllowed("another-official-at-same-venue", ip);
    expect(scoringAccessRateLimited(unrelatedCredential)).toBe(false);
    expect(unrelatedCredential.remaining).toBeGreaterThan(0);
    expect((await ownedKeys()).join("\n")).not.toContain(credential);
    expect((await ownedKeys()).join("\n")).not.toContain(ip);
  });

  it("shares cooldowns and headers across two independently started API instances", async () => {
    const applicationNamespace = `${namespace}two-api-instances:`;
    const applicationRedis = [
      new Redis(redisUrl, { maxRetriesPerRequest: 1 }),
      new Redis(redisUrl, { maxRetriesPerRequest: 1 }),
    ];
    const applications = applicationRedis.map((connection) => {
      const app = Fastify({ logger: false });
      const limiter = new RedisScoringAccessRateLimiter(connection, secret, applicationNamespace);
      app.post<{ Body: { credential: string; ip: string } }>("/exchange-invalid", async (request, reply) => {
        let state = await limiter.assertAllowed(request.body.credential, request.body.ip);
        if (!scoringAccessRateLimited(state)) {
          state = await limiter.recordInvalid(request.body.credential, request.body.ip);
        }
        reply
          .header("RateLimit-Limit", state.limit)
          .header("RateLimit-Remaining", state.remaining)
          .header("RateLimit-Reset", state.resetSeconds);
        if (state.retryAfterSeconds) reply.header("Retry-After", state.retryAfterSeconds);
        return reply.code(scoringAccessRateLimited(state) ? 429 : 403).send({ error: "ACCESS_DENIED" });
      });
      return app;
    });
    try {
      const origins = await Promise.all(applications.map((app) => app.listen({ host: "127.0.0.1", port: 0 })));
      const invoke = async (instance: number, credential: string, ip: string) =>
        fetch(`${origins[instance]}/exchange-invalid`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential, ip }),
        });
      const pairCredential = "pair-credential-must-stay-private";
      const venueIp = "203.0.113.77";
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await invoke(attempt % 2, pairCredential, venueIp);
        expect(response.status).toBe(403);
        expect(response.headers.get("ratelimit-limit")).toBe("5");
      }
      const pairCooldown = await invoke(0, pairCredential, venueIp);
      expect(pairCooldown.status).toBe(429);
      expect(pairCooldown.headers.get("ratelimit-limit")).toBe("5");
      expect(pairCooldown.headers.get("ratelimit-remaining")).toBe("0");
      expect(pairCooldown.headers.get("retry-after")).toBe("900");
      const neighbour = await invoke(1, "different-official-behind-same-nat", venueIp);
      expect(neighbour.status).toBe(403);
      expect(neighbour.headers.get("retry-after")).toBeNull();

      const ipCooldownAddress = "198.51.100.77";
      for (let attempt = 0; attempt < 19; attempt += 1) {
        expect((await invoke(attempt % 2, `ip-credential-${attempt}`, ipCooldownAddress)).status).toBe(403);
      }
      const ipCooldown = await invoke(1, "ip-credential-19", ipCooldownAddress);
      expect(ipCooldown.status).toBe(429);
      expect(ipCooldown.headers.get("ratelimit-limit")).toBe("20");
      expect(ipCooldown.headers.get("ratelimit-remaining")).toBe("0");
      expect(ipCooldown.headers.get("retry-after")).toBe("900");
      const applicationKeys = (await ownedKeys()).filter((key) => key.startsWith(applicationNamespace));
      expect(applicationKeys.length).toBeGreaterThan(0);
      expect(applicationKeys.join("\n")).not.toContain(pairCredential);
      expect(applicationKeys.join("\n")).not.toContain(venueIp);
      expect(await redis.get(guardKey)).toBe("preserve");
    } finally {
      await Promise.allSettled(applications.map((app) => app.close()));
      await Promise.allSettled(applicationRedis.map((connection) => connection.quit()));
    }
  });

  it("applies the twenty-invalid IP cooldown across distinct credentials", async () => {
    const limiter = new RedisScoringAccessRateLimiter(redis, secret, `${namespace}ip-total:`);
    const ip = "198.51.100.9";
    for (let attempt = 0; attempt < 19; attempt += 1) {
      expect(scoringAccessRateLimited(await limiter.recordInvalid(`credential-${attempt}`, ip))).toBe(false);
    }
    const limited = await limiter.recordInvalid("credential-19", ip);
    expect(scoringAccessRateLimited(limited)).toBe(true);
    expect(limited.limit).toBe(20);
    expect(limited.remaining).toBe(0);
  });

  it("expires a cooldown and preserves an unrelated near-prefix key", async () => {
    const limiter = new RedisScoringAccessRateLimiter(redis, secret, `${namespace}expiry:`, {
      windowSeconds: 2,
      cooldownSeconds: 1,
      pairLimit: 2,
      ipLimit: 20,
    });
    const credential = "expiring-test-credential";
    const ip = "192.0.2.42";

    expect(scoringAccessRateLimited(await limiter.recordInvalid(credential, ip))).toBe(false);
    expect(scoringAccessRateLimited(await limiter.recordInvalid(credential, ip))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(scoringAccessRateLimited(await limiter.assertAllowed(credential, ip))).toBe(false);
    expect(await redis.get(guardKey)).toBe("preserve");
  });
});
