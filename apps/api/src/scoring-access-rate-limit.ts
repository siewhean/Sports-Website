import { createHmac } from "node:crypto";
import type { Redis } from "ioredis";

const WINDOW_SECONDS = 10 * 60;
const COOLDOWN_SECONDS = 15 * 60;
const PAIR_LIMIT = 5;
const IP_LIMIT = 20;

export type ScoringAccessRateLimitPolicy = {
  windowSeconds: number;
  cooldownSeconds: number;
  pairLimit: number;
  ipLimit: number;
};

const productionPolicy: ScoringAccessRateLimitPolicy = {
  windowSeconds: WINDOW_SECONDS,
  cooldownSeconds: COOLDOWN_SECONDS,
  pairLimit: PAIR_LIMIT,
  ipLimit: IP_LIMIT,
};

export type ScoringAccessRateLimitHeaders = {
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds?: number;
};

export type ScoringAccessRateLimiter = {
  fingerprints(credential: string, ipAddress: string): { credential: Buffer; ip: Buffer };
  assertAllowed(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders>;
  recordInvalid(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders>;
  recordSuccess(credential: string, ipAddress: string): Promise<void>;
};

const incrementScript = `
local pair_count = redis.call("INCR", KEYS[1])
if pair_count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local ip_count = redis.call("INCR", KEYS[2])
if ip_count == 1 then redis.call("EXPIRE", KEYS[2], ARGV[1]) end
local pair_ttl = redis.call("TTL", KEYS[1])
local ip_ttl = redis.call("TTL", KEYS[2])
local pair_cooldown = 0
local ip_cooldown = 0
if pair_count >= tonumber(ARGV[2]) then
  redis.call("SET", KEYS[3], "1", "EX", ARGV[4])
  pair_cooldown = tonumber(ARGV[4])
end
if ip_count >= tonumber(ARGV[3]) then
  redis.call("SET", KEYS[4], "1", "EX", ARGV[4])
  ip_cooldown = tonumber(ARGV[4])
end
return { pair_count, ip_count, pair_ttl, ip_ttl, pair_cooldown, ip_cooldown }
`;

export class RedisScoringAccessRateLimiter implements ScoringAccessRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly hmacSecret: string,
    private readonly namespace = "matchday:scoring-access:",
    private readonly policy: ScoringAccessRateLimitPolicy = productionPolicy,
  ) {
    if (Buffer.byteLength(hmacSecret, "utf8") < 32) {
      throw new Error("Scoring access rate-limit HMAC secret must contain at least 32 bytes.");
    }
  }

  private digest(value: string): string {
    return createHmac("sha256", this.hmacSecret).update(value, "utf8").digest("hex");
  }

  fingerprints(credential: string, ipAddress: string): { credential: Buffer; ip: Buffer } {
    return {
      credential: Buffer.from(this.digest(`credential:${credential}`), "hex"),
      ip: Buffer.from(this.digest(`ip:${ipAddress}`), "hex"),
    };
  }

  private keys(credential: string, ipAddress: string) {
    const credentialHash = this.digest(`credential:${credential}`);
    const ipHash = this.digest(`ip:${ipAddress}`);
    return {
      pair: `${this.namespace}invalid:pair:${credentialHash}:${ipHash}`,
      ip: `${this.namespace}invalid:ip:${ipHash}`,
      pairCooldown: `${this.namespace}cooldown:pair:${credentialHash}:${ipHash}`,
      ipCooldown: `${this.namespace}cooldown:ip:${ipHash}`,
    };
  }

  async assertAllowed(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders> {
    const keys = this.keys(credential, ipAddress);
    const [pairCooldownTtl, ipCooldownTtl, pairCount, pairTtl, ipCount, ipTtl] = await this.redis
      .multi()
      .ttl(keys.pairCooldown)
      .ttl(keys.ipCooldown)
      .get(keys.pair)
      .ttl(keys.pair)
      .get(keys.ip)
      .ttl(keys.ip)
      .exec()
      .then((rows) => rows?.map((entry) => entry[1]) ?? []);
    const ipRetryAfterSeconds = Math.max(Number(ipCooldownTtl ?? -1), 0);
    if (ipRetryAfterSeconds > 0) {
      return {
        limit: this.policy.ipLimit,
        remaining: 0,
        resetSeconds: ipRetryAfterSeconds,
        retryAfterSeconds: ipRetryAfterSeconds,
      };
    }
    const pairRetryAfterSeconds = Math.max(Number(pairCooldownTtl ?? -1), 0);
    if (pairRetryAfterSeconds > 0) {
      return {
        limit: this.policy.pairLimit,
        remaining: 0,
        resetSeconds: pairRetryAfterSeconds,
        retryAfterSeconds: pairRetryAfterSeconds,
      };
    }
    const pairRemaining = Math.max(0, this.policy.pairLimit - Number(pairCount ?? 0));
    const ipRemaining = Math.max(0, this.policy.ipLimit - Number(ipCount ?? 0));
    return {
      limit: pairRemaining <= ipRemaining ? this.policy.pairLimit : this.policy.ipLimit,
      remaining: Math.min(pairRemaining, ipRemaining),
      resetSeconds: Math.max(Number(pairTtl ?? 0), Number(ipTtl ?? 0), 0),
    };
  }

  async recordInvalid(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders> {
    const keys = this.keys(credential, ipAddress);
    const result = (await this.redis.eval(
      incrementScript,
      4,
      keys.pair,
      keys.ip,
      keys.pairCooldown,
      keys.ipCooldown,
      this.policy.windowSeconds,
      this.policy.pairLimit,
      this.policy.ipLimit,
      this.policy.cooldownSeconds,
    )) as [number, number, number, number, number, number];
    const [pairCount, ipCount, pairTtl, ipTtl, pairCooldownTtl, ipCooldownTtl] = result.map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const pairRemaining = Math.max(0, this.policy.pairLimit - pairCount);
    const ipRemaining = Math.max(0, this.policy.ipLimit - ipCount);
    return {
      limit: ipCooldownTtl > 0 || ipRemaining < pairRemaining ? this.policy.ipLimit : this.policy.pairLimit,
      remaining: Math.min(pairRemaining, ipRemaining),
      resetSeconds: ipCooldownTtl || pairCooldownTtl || Math.max(pairTtl, ipTtl, 0),
      ...(ipCooldownTtl > 0
        ? { retryAfterSeconds: ipCooldownTtl }
        : pairCooldownTtl > 0
          ? { retryAfterSeconds: pairCooldownTtl }
          : {}),
    };
  }

  async recordSuccess(credential: string, ipAddress: string): Promise<void> {
    const keys = this.keys(credential, ipAddress);
    await this.redis.del(keys.pair, keys.pairCooldown);
  }
}

export class NoopScoringAccessRateLimiter implements ScoringAccessRateLimiter {
  fingerprints(credential: string, ipAddress: string): { credential: Buffer; ip: Buffer } {
    return {
      credential: createHmac("sha256", "test-scoring-access-rate-limit-key").update(credential, "utf8").digest(),
      ip: createHmac("sha256", "test-scoring-access-rate-limit-key").update(ipAddress, "utf8").digest(),
    };
  }
  async assertAllowed(): Promise<ScoringAccessRateLimitHeaders> {
    return { limit: IP_LIMIT, remaining: IP_LIMIT, resetSeconds: WINDOW_SECONDS };
  }

  async recordInvalid(): Promise<ScoringAccessRateLimitHeaders> {
    return { limit: IP_LIMIT, remaining: IP_LIMIT - 1, resetSeconds: WINDOW_SECONDS };
  }

  async recordSuccess(): Promise<void> {}
}

export function scoringAccessRateLimited(state: ScoringAccessRateLimitHeaders): boolean {
  return Boolean(state.retryAfterSeconds && state.retryAfterSeconds > 0);
}
