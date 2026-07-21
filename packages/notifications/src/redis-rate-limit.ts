import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";
import { NotificationRateLimitError, type NotificationRateLimiter } from "./rate-limit.js";

export interface RedisEvalClient {
  eval(script: string, options: { keys: readonly string[]; arguments: readonly string[] }): Promise<unknown>;
}

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local maximum = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= maximum then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = window
  if oldest[2] then retry_after = math.max(1, tonumber(oldest[2]) + window - now) end
  return {0, retry_after}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, 0}
`;

export type RedisNotificationRateLimiterOptions = {
  maximum: number;
  windowMs: number;
  keyPrefix?: string;
};

export class RedisNotificationRateLimiter implements NotificationRateLimiter {
  readonly #client: RedisEvalClient;
  readonly #keyPrefix: string;
  readonly #maximum: number;
  readonly #windowMs: number;

  constructor(client: RedisEvalClient, options: RedisNotificationRateLimiterOptions) {
    if (!Number.isInteger(options.maximum) || options.maximum < 1) {
      throw new Error("Notification rate limit maximum must be a positive integer");
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error("Notification rate limit window must be a positive integer");
    }
    this.#client = client;
    this.#keyPrefix = options.keyPrefix ?? "matchday:notifications:rate";
    this.#maximum = options.maximum;
    this.#windowMs = options.windowMs;
  }

  async assertAllowed(accountId: string, notificationType: string, now: Date): Promise<void> {
    const scopeHash = createHash("sha256").update(`${accountId}\u0000${notificationType}`).digest("base64url");
    const result = await this.#client.eval(SLIDING_WINDOW_SCRIPT, {
      keys: [`${this.#keyPrefix}:${scopeHash}`],
      arguments: [String(now.getTime()), String(this.#windowMs), String(this.#maximum), randomUUID()],
    });
    if (!Array.isArray(result) || typeof result[0] !== "number" || typeof result[1] !== "number") {
      throw new Error("Redis notification rate limiter returned an invalid response");
    }
    if (result[0] === 0) throw new NotificationRateLimitError(result[1]);
  }
}

export async function connectRedisNotificationRateLimiter(
  redisUrl: string,
  options: RedisNotificationRateLimiterOptions,
): Promise<{ limiter: RedisNotificationRateLimiter; close: () => Promise<void> }> {
  const client = createClient({ url: redisUrl });
  await client.connect();
  return {
    limiter: new RedisNotificationRateLimiter(client as RedisEvalClient, options),
    close: async () => client.close(),
  };
}
