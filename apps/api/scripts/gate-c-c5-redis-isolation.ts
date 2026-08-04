import type { Redis } from "ioredis";

const prefixPattern = /^matchday-c5-[a-z0-9-]{3,56}$/u;
const workerQueueName = "matchday-foundation";
const scanCount = 100;
const maximumScanIterations = 10_000;
const unlinkBatchSize = 100;

export type GateCC5RedisOwnership = Readonly<{
  queuePrefix: string;
  queueName: string;
  rateLimitNamespace: string;
  unrelatedGuardKey: string;
  ownedPatterns: readonly string[];
}>;

export type GateCC5RedisCleanupReceipt = Readonly<{
  initialOwnedKeyCount: number;
  finalOwnedKeyCount: number;
  unrelatedGuardPreserved: boolean;
}>;

function assertOwnedIdentifier(value: string, label: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error(`Gate C C5 ${label} is not an owned identifier`);
}

/** Defines the only keys a C5 harness may inspect or remove. */
export function createGateCC5RedisOwnership(
  queuePrefix: string,
  queueName: string,
  rateLimitNamespace: string,
): GateCC5RedisOwnership {
  assertOwnedIdentifier(queuePrefix, "queue prefix", prefixPattern);
  if (queueName !== workerQueueName) throw new Error("Gate C C5 queue name is not owned");
  if (!/^matchday:test:gate-c-c5:[a-z0-9-]{3,64}:$/u.test(rateLimitNamespace)) {
    throw new Error("Gate C C5 rate-limit namespace is not owned");
  }
  return {
    queuePrefix,
    queueName,
    rateLimitNamespace,
    unrelatedGuardKey: `${queuePrefix}:${queueName}-foreign:ttl-sentinel`,
    ownedPatterns: [
      `${queuePrefix}:${queueName}:*`,
      `${queuePrefix}:${queueName}.dead-letter:*`,
      `matchday:job-cancellation:${queuePrefix}:${queueName}:*`,
      `${rateLimitNamespace}*`,
    ],
  };
}

export async function gateCC5OwnedRedisKeys(redis: Redis, ownership: GateCC5RedisOwnership): Promise<string[]> {
  const keys = new Set<string>();
  for (const pattern of ownership.ownedPatterns) {
    let cursor = "0";
    let iterations = 0;
    do {
      iterations += 1;
      if (iterations > maximumScanIterations) {
        throw new Error("Gate C C5 Redis ownership scan exceeded its bounded iteration limit");
      }
      const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", scanCount);
      cursor = next;
      for (const key of batch) keys.add(key);
    } while (cursor !== "0");
  }
  return [...keys].sort();
}

async function unlinkOwnedKeys(redis: Redis, keys: readonly string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += unlinkBatchSize) {
    await redis.unlink(...keys.slice(index, index + unlinkBatchSize));
  }
}

export async function prepareGateCC5RedisOwnership(redis: Redis, ownership: GateCC5RedisOwnership): Promise<void> {
  const dirtyKeys = await gateCC5OwnedRedisKeys(redis, ownership);
  if (dirtyKeys.length > 0) {
    throw new Error(`Refusing dirty Gate C C5 Redis namespace (${String(dirtyKeys.length)} owned keys)`);
  }
  await redis.set(ownership.unrelatedGuardKey, "preserve", "EX", 900);
}

export async function cleanupGateCC5RedisOwnership(
  redis: Redis,
  ownership: GateCC5RedisOwnership,
): Promise<GateCC5RedisCleanupReceipt> {
  const ownedKeys = await gateCC5OwnedRedisKeys(redis, ownership);
  await unlinkOwnedKeys(redis, ownedKeys);
  const remaining = await gateCC5OwnedRedisKeys(redis, ownership);
  if (remaining.length > 0) {
    throw new Error(`Gate C C5 Redis cleanup left ${String(remaining.length)} owned keys`);
  }
  const unrelatedGuardPreserved = (await redis.get(ownership.unrelatedGuardKey)) === "preserve";
  if (!unrelatedGuardPreserved) {
    throw new Error("Gate C C5 Redis cleanup removed an unrelated near-prefix guard key");
  }
  await redis.unlink(ownership.unrelatedGuardKey);
  return {
    initialOwnedKeyCount: ownedKeys.length,
    finalOwnedKeyCount: remaining.length,
    unrelatedGuardPreserved,
  };
}
