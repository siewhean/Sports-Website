import { createHmac } from "node:crypto";
import type { Redis } from "ioredis";
import { rateLimitIpSubject } from "./client-ip.js";
import { noopScoringAccessHmacMetrics, type ScoringAccessHmacMetricRecorder } from "./scoring-access-hmac-metrics.js";

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

type LimiterLogger = {
  warn: (payload: Record<string, unknown>, message: string) => void;
  error: (payload: Record<string, unknown>, message: string) => void;
};

// The limiter is constructed before Fastify's logger exists, so default to one
// structured JSON line on stderr (the container log stream).
const consoleLimiterLogger: LimiterLogger = {
  warn: (payload, message) => console.warn(JSON.stringify({ level: "warn", msg: message, ...payload })),
  error: (payload, message) => console.error(JSON.stringify({ level: "error", msg: message, ...payload })),
};

export type ScoringAccessRateLimiterOptions = {
  logger?: LimiterLogger;
  now?: () => number;
  /** Failed exchanges across ALL clients per window that trip the brute-force alarm. */
  globalFailureAlarmThreshold?: number;
  /** Bound on in-memory fallback entries so an IP-rotating flood cannot exhaust memory. */
  fallbackMaxEntries?: number;
  warnIntervalMs?: number;
};

type MemoryEntry = { count: number; expiresAt: number };

/*
 * Per-process mirror of the Redis policy used only while Redis is unavailable.
 * Failing open would let a brute-force attempt run unthrottled for the length
 * of an outage; failing closed (the previous behaviour) locked every scorer out
 * mid-match. The in-memory fallback keeps both the per-pair and per-IP limits
 * on each instance (so an attacker gets at most `instances x limit` attempts
 * during an outage) while honest scorers keep exchanging codes. Only keyed
 * HMAC digests are held, never raw credentials or IPs.
 */
class InMemoryScoringAccessState {
  private readonly counters = new Map<string, MemoryEntry>();
  private readonly cooldowns = new Map<string, number>();

  constructor(
    private readonly policy: ScoringAccessRateLimitPolicy,
    private readonly now: () => number,
    private readonly maxEntries: number,
  ) {}

  private remainingSeconds(expiresAt: number | undefined): number {
    if (expiresAt === undefined) return 0;
    return Math.max(0, Math.ceil((expiresAt - this.now()) / 1_000));
  }

  private counter(key: string): MemoryEntry | undefined {
    const entry = this.counters.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.counters.delete(key);
      return undefined;
    }
    return entry;
  }

  private cooldown(key: string): number {
    const expiresAt = this.cooldowns.get(key);
    const seconds = this.remainingSeconds(expiresAt);
    if (expiresAt !== undefined && seconds === 0) this.cooldowns.delete(key);
    return seconds;
  }

  private evict(): void {
    if (this.counters.size + this.cooldowns.size <= this.maxEntries) return;
    const at = this.now();
    for (const [key, entry] of this.counters) if (entry.expiresAt <= at) this.counters.delete(key);
    for (const [key, expiresAt] of this.cooldowns) if (expiresAt <= at) this.cooldowns.delete(key);
    // Still full: drop the oldest counters first; cooldowns are kept longest.
    for (const key of this.counters.keys()) {
      if (this.counters.size + this.cooldowns.size <= this.maxEntries) return;
      this.counters.delete(key);
    }
    for (const key of this.cooldowns.keys()) {
      if (this.cooldowns.size <= this.maxEntries) return;
      this.cooldowns.delete(key);
    }
  }

  private cooldownState(limit: number, seconds: number): ScoringAccessRateLimitHeaders {
    return { limit, remaining: 0, resetSeconds: seconds, retryAfterSeconds: seconds };
  }

  state(pairKey: string, ipKey: string): ScoringAccessRateLimitHeaders {
    const ipCooldown = this.cooldown(`cooldown:${ipKey}`);
    if (ipCooldown > 0) return this.cooldownState(this.policy.ipLimit, ipCooldown);
    const pairCooldown = this.cooldown(`cooldown:${pairKey}`);
    if (pairCooldown > 0) return this.cooldownState(this.policy.pairLimit, pairCooldown);
    const pair = this.counter(pairKey);
    const ip = this.counter(ipKey);
    const pairRemaining = Math.max(0, this.policy.pairLimit - (pair?.count ?? 0));
    const ipRemaining = Math.max(0, this.policy.ipLimit - (ip?.count ?? 0));
    return {
      limit: pairRemaining <= ipRemaining ? this.policy.pairLimit : this.policy.ipLimit,
      remaining: Math.min(pairRemaining, ipRemaining),
      resetSeconds: Math.max(this.remainingSeconds(pair?.expiresAt), this.remainingSeconds(ip?.expiresAt)),
    };
  }

  invalid(pairKey: string, ipKey: string): ScoringAccessRateLimitHeaders {
    const ipCooldown = this.cooldown(`cooldown:${ipKey}`);
    const pairCooldown = this.cooldown(`cooldown:${pairKey}`);
    if (ipCooldown > 0) return this.cooldownState(this.policy.ipLimit, ipCooldown);
    if (pairCooldown > 0) return this.cooldownState(this.policy.pairLimit, pairCooldown);
    const increment = (key: string): MemoryEntry => {
      const entry = this.counter(key) ?? { count: 0, expiresAt: this.now() + this.policy.windowSeconds * 1_000 };
      entry.count += 1;
      this.counters.set(key, entry);
      return entry;
    };
    const pair = increment(pairKey);
    const ip = increment(ipKey);
    const cooldownUntil = this.now() + this.policy.cooldownSeconds * 1_000;
    let state: ScoringAccessRateLimitHeaders | undefined;
    if (ip.count >= this.policy.ipLimit) {
      this.cooldowns.set(`cooldown:${ipKey}`, cooldownUntil);
      state = this.cooldownState(this.policy.ipLimit, this.policy.cooldownSeconds);
    }
    if (pair.count >= this.policy.pairLimit) {
      this.cooldowns.set(`cooldown:${pairKey}`, cooldownUntil);
      state ??= this.cooldownState(this.policy.pairLimit, this.policy.cooldownSeconds);
    }
    this.evict();
    if (state) return state;
    const pairRemaining = Math.max(0, this.policy.pairLimit - pair.count);
    const ipRemaining = Math.max(0, this.policy.ipLimit - ip.count);
    return {
      limit: ipRemaining < pairRemaining ? this.policy.ipLimit : this.policy.pairLimit,
      remaining: Math.min(pairRemaining, ipRemaining),
      resetSeconds: Math.max(this.remainingSeconds(pair.expiresAt), this.remainingSeconds(ip.expiresAt)),
    };
  }

  success(pairKey: string): void {
    this.counters.delete(pairKey);
    this.cooldowns.delete(`cooldown:${pairKey}`);
  }
}

/*
 * Per-IP limits cannot see a distributed brute force (many IPs, few attempts
 * each). This alarm counts failed exchanges across every client and emits an
 * error-level log once per window when the total crosses the threshold. It is
 * deliberately alert-only: a global block would let one attacker lock out
 * every scorer, which is the outage the per-client keys exist to prevent.
 */
class GlobalFailureAlarm {
  private windowStartedAt = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private readonly clients = new Set<string>();
  private alarmed = false;

  constructor(
    private readonly windowMs: number,
    private readonly threshold: number,
    private readonly now: () => number,
    private readonly logger: LimiterLogger,
  ) {}

  record(ipSubjectDigest: string, degraded: boolean): void {
    const at = this.now();
    if (at - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = at;
      this.failures = 0;
      this.clients.clear();
      this.alarmed = false;
    }
    this.failures += 1;
    if (this.clients.size < 10_000) this.clients.add(ipSubjectDigest);
    if (!this.alarmed && this.failures >= this.threshold) {
      this.alarmed = true;
      this.logger.error(
        {
          event: "scoring_access_global_failure_alarm",
          failed_attempts: this.failures,
          distinct_clients: this.clients.size,
          window_seconds: Math.round(this.windowMs / 1_000),
          threshold: this.threshold,
          rate_limit_store_degraded: degraded,
        },
        "Scoring access failed-attempt volume exceeds the global alarm threshold; possible distributed brute force",
      );
    }
  }

  snapshot(): { failures: number; distinctClients: number; alarmed: boolean } {
    return { failures: this.failures, distinctClients: this.clients.size, alarmed: this.alarmed };
  }
}

export class RedisScoringAccessRateLimiter implements ScoringAccessRateLimiter {
  private readonly keyring: ScoringAccessRateLimitHmacKeyring;
  private readonly logger: LimiterLogger;
  private readonly now: () => number;
  private readonly memory: InMemoryScoringAccessState;
  private readonly alarm: GlobalFailureAlarm;
  private readonly warnIntervalMs: number;
  private degraded = false;
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly redis: Redis,
    keyring: ScoringAccessRateLimitHmacKeyring | string,
    private readonly namespace = "matchday:scoring-access:",
    private readonly policy: ScoringAccessRateLimitPolicy = productionPolicy,
    private readonly hmacMetrics: ScoringAccessHmacMetricRecorder = noopScoringAccessHmacMetrics,
    options: ScoringAccessRateLimiterOptions = {},
  ) {
    this.keyring = normalizeKeyring(keyring);
    this.logger = options.logger ?? consoleLimiterLogger;
    this.now = options.now ?? Date.now;
    this.warnIntervalMs = options.warnIntervalMs ?? 30_000;
    this.memory = new InMemoryScoringAccessState(policy, this.now, options.fallbackMaxEntries ?? 50_000);
    this.alarm = new GlobalFailureAlarm(
      policy.windowSeconds * 1_000,
      options.globalFailureAlarmThreshold ?? 200,
      this.now,
      this.logger,
    );
  }

  /** Failed-attempt totals for the current global alarm window (for diagnostics and tests). */
  globalFailureSnapshot(): { failures: number; distinctClients: number; alarmed: boolean } {
    return this.alarm.snapshot();
  }

  private memoryKeys(credential: string, ipAddress: string): { pair: string; ip: string } {
    const credentialHash = this.digest(this.keyring.primary, `credential:${credential}`);
    const ipHash = this.digest(this.keyring.primary, `ip:${rateLimitIpSubject(ipAddress)}`);
    return { pair: `pair:${credentialHash}:${ipHash}`, ip: `ip:${ipHash}` };
  }

  private redisFailed(operation: string, error: unknown): void {
    const at = this.now();
    if (!this.degraded || at - this.lastWarnAt >= this.warnIntervalMs) {
      this.lastWarnAt = at;
      this.logger.warn(
        {
          event: "scoring_access_rate_limit_redis_unavailable",
          operation,
          error_message: error instanceof Error ? error.message : String(error),
        },
        "Scoring access rate-limit Redis unavailable; enforcing per-instance in-memory limits",
      );
    }
    this.degraded = true;
  }

  private redisRecovered(): void {
    this.degraded = false;
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
    // Counters key on the rate-limit subject (IPv6 /64, IPv4 unchanged) so an
    // IPv6 client cannot rotate addresses to escape the IP limit. Durable
    // attempt fingerprints above keep the exact address.
    const ipHash = this.digest(key, `ip:${rateLimitIpSubject(ipAddress)}`);
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
      const ipHash = this.digest(legacyV1, `ip:${rateLimitIpSubject(ipAddress)}`);
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
    let state: ScoringAccessRateLimitHeaders;
    try {
      state = await this.aggregateState(this.allKeys(credential, ipAddress));
      this.redisRecovered();
    } catch (error) {
      this.redisFailed("assert", error);
      const keys = this.memoryKeys(credential, ipAddress);
      state = this.memory.state(keys.pair, keys.ip);
    }
    this.hmacMetrics.rateLimit({
      primaryVersion: this.keyring.primary.version,
      acceptedVersionCount: 1 + this.keyring.verificationOnly.length,
      operation: "assert",
    });
    return state;
  }

  async recordInvalid(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders> {
    const memoryKeys = this.memoryKeys(credential, ipAddress);
    let state: ScoringAccessRateLimitHeaders;
    try {
      state = await this.recordInvalidInRedis(credential, ipAddress);
      this.redisRecovered();
    } catch (error) {
      this.redisFailed("invalid", error);
      state = this.memory.invalid(memoryKeys.pair, memoryKeys.ip);
    }
    this.alarm.record(memoryKeys.ip, this.degraded);
    this.hmacMetrics.rateLimit({
      primaryVersion: this.keyring.primary.version,
      acceptedVersionCount: 1 + this.keyring.verificationOnly.length,
      operation: "invalid",
    });
    return state;
  }

  private async recordInvalidInRedis(credential: string, ipAddress: string): Promise<ScoringAccessRateLimitHeaders> {
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
    return state;
  }

  async recordSuccess(credential: string, ipAddress: string): Promise<void> {
    const keys = this.allKeys(credential, ipAddress);
    const memoryKeys = this.memoryKeys(credential, ipAddress);
    this.memory.success(memoryKeys.pair);
    try {
      await this.redis.del(...keys.flatMap((key) => [key.pair, key.pairCooldown]));
      this.redisRecovered();
    } catch (error) {
      // A stale pair counter only expires naturally; it must not abort a valid exchange.
      this.redisFailed("success", error);
    }
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
