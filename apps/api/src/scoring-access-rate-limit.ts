import { createHmac } from "node:crypto";
import type { Redis } from "ioredis";
import {
  productionScoringAccessHmacMetrics,
  type ScoringAccessHmacMetricRecorder,
} from "./scoring-access-hmac-metrics.js";

const WINDOW_SECONDS = 10 * 60;
const COOLDOWN_SECONDS = 15 * 60;
const PAIR_LIMIT = 5;
const IP_LIMIT = 20;
const keyVersionPattern = /^[a-z][a-z0-9_-]{0,63}$/u;

export type ScoringAccessRateLimitPolicy = {
  windowSeconds: number;
  cooldownSeconds: number;
  pairLimit: number;
  ipLimit: number;
};

export type ScoringAccessRateLimitHmacKey = {
  version: string;
  secret: string;
};

export type ScoringAccessRateLimitHmacKeyring = {
  primary: ScoringAccessRateLimitHmacKey;
  verificationOnly: readonly ScoringAccessRateLimitHmacKey[];
  /**
   * A deployment-time commitment to the retained C1-C4 v1 key material.
   * It is needed only while the durable registry is being bootstrapped from
   * the zero-commitment legacy migration row; it is never used to derive a
   * Redis key and must not be exposed in diagnostics.
   */
  legacyV1MaterialCommitment?: string;
};

export type ScoringAccessRateLimitFingerprint = {
  keyVersion: string;
  credential: Buffer;
  ip: Buffer;
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
  primaryKeyVersion?(): string;
  fingerprints(credential: string, ipAddress: string): ScoringAccessRateLimitFingerprint;
  assertAllowed(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders>;
  recordInvalid(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders>;
  recordSuccess(credential: string, ipAddress: string): Promise<void>;
};

type VersionedRedisKeys = {
  pair: string;
  ip: string;
  pairCooldown: string;
  ipCooldown: string;
};

/*
 * The first key quartet belongs to the primary HMAC key. Historical key
 * quartets are read into the same total before the primary values are
 * incremented. This makes key promotion incapable of resetting or splitting
 * the pair/IP budget while allowing only the primary namespace to receive new
 * writes.
 */
const incrementAcrossVersionsScript = `
local version_count = tonumber(ARGV[5])
local pair_cooldown = 0
local ip_cooldown = 0
for version = 0, version_count - 1 do
  local offset = version * 4
  pair_cooldown = math.max(pair_cooldown, math.max(redis.call("TTL", KEYS[offset + 3]), 0))
  ip_cooldown = math.max(ip_cooldown, math.max(redis.call("TTL", KEYS[offset + 4]), 0))
end
if pair_cooldown > 0 or ip_cooldown > 0 then
  return { 0, 0, 0, 0, pair_cooldown, ip_cooldown, 1 }
end

local primary_pair_count = redis.call("INCR", KEYS[1])
if primary_pair_count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local primary_ip_count = redis.call("INCR", KEYS[2])
if primary_ip_count == 1 then redis.call("EXPIRE", KEYS[2], ARGV[1]) end

local pair_count = 0
local ip_count = 0
local pair_ttl = 0
local ip_ttl = 0
for version = 0, version_count - 1 do
  local offset = version * 4
  pair_count = pair_count + tonumber(redis.call("GET", KEYS[offset + 1]) or "0")
  ip_count = ip_count + tonumber(redis.call("GET", KEYS[offset + 2]) or "0")
  pair_ttl = math.max(pair_ttl, math.max(redis.call("TTL", KEYS[offset + 1]), 0))
  ip_ttl = math.max(ip_ttl, math.max(redis.call("TTL", KEYS[offset + 2]), 0))
end
if pair_count >= tonumber(ARGV[2]) then
  redis.call("SET", KEYS[3], "1", "EX", ARGV[4])
  pair_cooldown = tonumber(ARGV[4])
end
if ip_count >= tonumber(ARGV[3]) then
  redis.call("SET", KEYS[4], "1", "EX", ARGV[4])
  ip_cooldown = tonumber(ARGV[4])
end
return { pair_count, ip_count, pair_ttl, ip_ttl, pair_cooldown, ip_cooldown, 0 }
`;

function normalizeKeyring(keyring: ScoringAccessRateLimitHmacKeyring | string): ScoringAccessRateLimitHmacKeyring {
  const normalized =
    typeof keyring === "string" ? { primary: { version: "v1", secret: keyring }, verificationOnly: [] } : keyring;
  const keys = [normalized.primary, ...normalized.verificationOnly];
  if (keys.length === 0 || keys.length > 8) {
    throw new Error("Scoring access rate-limit HMAC keyring must contain between one and eight keys.");
  }
  const versions = new Set<string>();
  const secrets = new Set<string>();
  for (const key of keys) {
    if (!keyVersionPattern.test(key.version)) {
      throw new Error("Scoring access rate-limit HMAC key versions must be lowercase machine identifiers.");
    }
    if (Buffer.byteLength(key.secret, "utf8") < 32) {
      throw new Error("Scoring access rate-limit HMAC secrets must contain at least 32 bytes.");
    }
    if (versions.has(key.version) || secrets.has(key.secret)) {
      throw new Error("Scoring access rate-limit HMAC key versions and material must be unique.");
    }
    versions.add(key.version);
    secrets.add(key.secret);
  }
  return normalized;
}

export class RedisScoringAccessRateLimiter implements ScoringAccessRateLimiter {
  private readonly keyring: ScoringAccessRateLimitHmacKeyring;

  constructor(
    private readonly redis: Redis,
    keyring: ScoringAccessRateLimitHmacKeyring | string,
    private readonly namespace = "matchday:scoring-access:",
    private readonly policy: ScoringAccessRateLimitPolicy = productionPolicy,
    private readonly hmacMetrics: ScoringAccessHmacMetricRecorder = productionScoringAccessHmacMetrics,
  ) {
    this.keyring = normalizeKeyring(keyring);
  }

  private digest(key: ScoringAccessRateLimitHmacKey, value: string): string {
    return createHmac("sha256", key.secret).update(value, "utf8").digest("hex");
  }

  primaryKeyVersion(): string {
    return this.keyring.primary.version;
  }

  fingerprints(credential: string, ipAddress: string): ScoringAccessRateLimitFingerprint {
    return this.fingerprintsForVersion(this.keyring.primary.version, credential, ipAddress);
  }

  fingerprintsForVersion(keyVersion: string, credential: string, ipAddress: string): ScoringAccessRateLimitFingerprint {
    const key = [this.keyring.primary, ...this.keyring.verificationOnly].find(
      (candidate) => candidate.version === keyVersion,
    );
    if (!key) {
      throw new Error(`Scoring access rate-limit HMAC key version ${keyVersion} is unknown or retired.`);
    }
    return {
      keyVersion: key.version,
      credential: Buffer.from(this.digest(key, `credential:${credential}`), "hex"),
      ip: Buffer.from(this.digest(key, `ip:${ipAddress}`), "hex"),
    };
  }

  private keys(key: ScoringAccessRateLimitHmacKey, credential: string, ipAddress: string): VersionedRedisKeys {
    const credentialHash = this.digest(key, `credential:${credential}`);
    const ipHash = this.digest(key, `ip:${ipAddress}`);
    const versionNamespace = `${this.namespace}v:${key.version}:`;
    return this.keysForNamespace(versionNamespace, credentialHash, ipHash);
  }

  private keysForNamespace(namespace: string, credentialHash: string, ipHash: string): VersionedRedisKeys {
    return {
      pair: `${namespace}invalid:pair:${credentialHash}:${ipHash}`,
      ip: `${namespace}invalid:ip:${ipHash}`,
      pairCooldown: `${namespace}cooldown:pair:${credentialHash}:${ipHash}`,
      ipCooldown: `${namespace}cooldown:ip:${ipHash}`,
    };
  }

  private allKeys(credential: string, ipAddress: string): VersionedRedisKeys[] {
    const configuredKeys = [this.keyring.primary, ...this.keyring.verificationOnly];
    const keys = configuredKeys.map((key) => this.keys(key, credential, ipAddress));
    // C1-C4 used an unversioned v1 namespace. Keep that quartet in aggregate
    // reads only while v1 remains an accepted configured key; new writes always
    // target the primary versioned namespace. Registry retirement is fenced by
    // the maximum Redis TTL, so this compatibility path cannot outlive old keys.
    const legacyV1 = configuredKeys.find((key) => key.version === "v1");
    if (legacyV1) {
      const credentialHash = this.digest(legacyV1, `credential:${credential}`);
      const ipHash = this.digest(legacyV1, `ip:${ipAddress}`);
      keys.push(this.keysForNamespace(this.namespace, credentialHash, ipHash));
    }
    return keys;
  }

  private async aggregateState(keys: readonly VersionedRedisKeys[]): Promise<ScoringAccessRateLimitHeaders> {
    const state = await Promise.all(
      keys.map(async (key) => {
        const [pairCooldownTtl, ipCooldownTtl, pairCount, pairTtl, ipCount, ipTtl] = await this.redis
          .multi()
          .ttl(key.pairCooldown)
          .ttl(key.ipCooldown)
          .get(key.pair)
          .ttl(key.pair)
          .get(key.ip)
          .ttl(key.ip)
          .exec()
          .then((rows) => rows?.map((entry) => entry[1]) ?? []);
        return {
          pairCooldownTtl: Math.max(Number(pairCooldownTtl ?? -1), 0),
          ipCooldownTtl: Math.max(Number(ipCooldownTtl ?? -1), 0),
          pairCount: Number(pairCount ?? 0),
          pairTtl: Math.max(Number(pairTtl ?? 0), 0),
          ipCount: Number(ipCount ?? 0),
          ipTtl: Math.max(Number(ipTtl ?? 0), 0),
        };
      }),
    );
    const pairCooldownTtl = Math.max(...state.map((entry) => entry.pairCooldownTtl));
    const ipCooldownTtl = Math.max(...state.map((entry) => entry.ipCooldownTtl));
    if (ipCooldownTtl > 0) {
      return {
        limit: this.policy.ipLimit,
        remaining: 0,
        resetSeconds: ipCooldownTtl,
        retryAfterSeconds: ipCooldownTtl,
      };
    }
    if (pairCooldownTtl > 0) {
      return {
        limit: this.policy.pairLimit,
        remaining: 0,
        resetSeconds: pairCooldownTtl,
        retryAfterSeconds: pairCooldownTtl,
      };
    }
    const pairRemaining = Math.max(
      0,
      this.policy.pairLimit - state.reduce((total, entry) => total + entry.pairCount, 0),
    );
    const ipRemaining = Math.max(0, this.policy.ipLimit - state.reduce((total, entry) => total + entry.ipCount, 0));
    return {
      limit: pairRemaining <= ipRemaining ? this.policy.pairLimit : this.policy.ipLimit,
      remaining: Math.min(pairRemaining, ipRemaining),
      resetSeconds: Math.max(...state.map((entry) => Math.max(entry.pairTtl, entry.ipTtl))),
    };
  }

  async assertAllowed(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders> {
    const state = await this.aggregateState(this.allKeys(credential, ipAddress));
    this.hmacMetrics.rateLimit({
      primaryVersion: this.keyring.primary.version,
      acceptedVersionCount: 1 + this.keyring.verificationOnly.length,
      operation: "assert",
    });
    return state;
  }

  async recordInvalid(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders> {
    const keys = this.allKeys(credential, ipAddress);
    const redisKeys = keys.flatMap((key) => [key.pair, key.ip, key.pairCooldown, key.ipCooldown]);
    const result = (await this.redis.eval(
      incrementAcrossVersionsScript,
      redisKeys.length,
      ...redisKeys,
      this.policy.windowSeconds,
      this.policy.pairLimit,
      this.policy.ipLimit,
      this.policy.cooldownSeconds,
      keys.length,
    )) as [number, number, number, number, number, number, number];
    const [pairCount, ipCount, pairTtl, ipTtl, pairCooldownTtl, ipCooldownTtl] = result.map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    let state: ScoringAccessRateLimitHeaders;
    if (ipCooldownTtl > 0) {
      state = {
        limit: this.policy.ipLimit,
        remaining: 0,
        resetSeconds: ipCooldownTtl,
        retryAfterSeconds: ipCooldownTtl,
      };
    } else if (pairCooldownTtl > 0) {
      state = {
        limit: this.policy.pairLimit,
        remaining: 0,
        resetSeconds: pairCooldownTtl,
        retryAfterSeconds: pairCooldownTtl,
      };
    } else {
      const pairRemaining = Math.max(0, this.policy.pairLimit - pairCount);
      const ipRemaining = Math.max(0, this.policy.ipLimit - ipCount);
      state = {
        limit: ipRemaining < pairRemaining ? this.policy.ipLimit : this.policy.pairLimit,
        remaining: Math.min(pairRemaining, ipRemaining),
        resetSeconds: Math.max(pairTtl, ipTtl, 0),
      };
    }
    this.hmacMetrics.rateLimit({
      primaryVersion: this.keyring.primary.version,
      acceptedVersionCount: 1 + this.keyring.verificationOnly.length,
      operation: "invalid",
    });
    return state;
  }

  async recordSuccess(credential: string, ipAddress: string): Promise<void> {
    const keys = this.allKeys(credential, ipAddress);
    await this.redis.del(...keys.flatMap((key) => [key.pair, key.pairCooldown]));
    this.hmacMetrics.rateLimit({
      primaryVersion: this.keyring.primary.version,
      acceptedVersionCount: 1 + this.keyring.verificationOnly.length,
      operation: "success",
    });
  }
}

export class NoopScoringAccessRateLimiter implements ScoringAccessRateLimiter {
  fingerprints(credential: string, ipAddress: string): ScoringAccessRateLimitFingerprint {
    return {
      keyVersion: "v1",
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
