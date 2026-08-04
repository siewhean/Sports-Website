import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupGateCC5RedisOwnership,
  createGateCC5RedisOwnership,
  gateCC5OwnedRedisKeys,
  prepareGateCC5RedisOwnership,
} from "../../scripts/gate-c-c5-redis-isolation.js";

const describeInfra = process.env.RUN_INFRA_TESTS === "1" ? describe : describe.skip;
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
const suffix = randomUUID();
const ownership = createGateCC5RedisOwnership(
  `matchday-c5-${suffix}`,
  `matchday-c5-${suffix}`,
  `matchday:test:gate-c-c5:${suffix}:`,
);
let redis: Redis;
let cleaned = false;

describeInfra("C5 real Redis ownership isolation", () => {
  beforeAll(async () => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await prepareGateCC5RedisOwnership(redis, ownership);
  });

  afterAll(async () => {
    if (!cleaned) await cleanupGateCC5RedisOwnership(redis, ownership);
    await redis.quit();
  });

  it("cleans only owned keys and preserves an unrelated near-prefix TTL sentinel", async () => {
    const [bull, deadLetter, cancellation, rateLimit] = ownership.ownedPatterns.map((pattern) =>
      pattern.replace("*", "key"),
    );
    if (!bull || !deadLetter || !cancellation || !rateLimit) {
      throw new Error("C5 test ownership patterns are incomplete");
    }
    await redis.mset(bull, "1", deadLetter, "1", cancellation, "1", rateLimit, "1");
    expect(await gateCC5OwnedRedisKeys(redis, ownership)).toHaveLength(4);
    expect(await redis.ttl(ownership.unrelatedGuardKey)).toBeGreaterThan(0);

    const receipt = await cleanupGateCC5RedisOwnership(redis, ownership);
    cleaned = true;
    expect(receipt).toEqual({
      initialOwnedKeyCount: 4,
      finalOwnedKeyCount: 0,
      unrelatedGuardPreserved: true,
    });
    expect(await gateCC5OwnedRedisKeys(redis, ownership)).toEqual([]);
    expect(await redis.get(ownership.unrelatedGuardKey)).toBeNull();
  });
});
