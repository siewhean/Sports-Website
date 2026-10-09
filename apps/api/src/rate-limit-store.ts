import { createRequire } from "node:module";
import type { FastifyRateLimitOptions, FastifyRateLimitStore, FastifyRateLimitStoreCtor } from "@fastify/rate-limit";
import type { Redis } from "ioredis";

type StoreResult = { current: number; ttl: number };
type StoreCallback = (error: Error | null, result?: StoreResult) => void;
// The plugin passes its merged internal params, which carry these flags but are not in the public types.
type StoreOptions = FastifyRateLimitOptions & { continueExceeding?: boolean; exponentialBackoff?: boolean };
type RouteOptions = StoreOptions & { routeInfo: { method?: string; url?: string } };
type InternalStore = {
  incr(key: string, callback: StoreCallback, timeWindow: number, max: number): void;
  read?(key: string, callback: StoreCallback, timeWindow: number, max: number): void;
  child(routeOptions: RouteOptions): InternalStore;
};

// @fastify/rate-limit ships its stores as CommonJS without type declarations.
const require = createRequire(import.meta.url);
const RedisStore = require("@fastify/rate-limit/store/RedisStore.js") as new (
  continueExceeding: boolean,
  exponentialBackoff: boolean,
  redis: Redis,
  key?: string,
) => InternalStore;
const LocalStore = require("@fastify/rate-limit/store/LocalStore.js") as new (
  continueExceeding: boolean,
  exponentialBackoff: boolean,
  cache?: number,
) => InternalStore;

export type RateLimitFallbackLogger = {
  warn: (payload: Record<string, unknown>, message: string) => void;
  info?: (payload: Record<string, unknown>, message: string) => void;
};

type SharedState = {
  degraded: boolean;
  lastWarnAt: number;
  failuresSinceWarn: number;
};

/**
 * A Redis rate-limit store that degrades to a per-process in-memory store when
 * Redis is unavailable instead of failing every request (the plugin default)
 * or failing fully open (`skipOnError` alone). During a Redis blip each API
 * instance enforces the same limits locally, so the effective limit is at most
 * `instances x max` until Redis recovers; counters are not merged back.
 */
export function redisStoreWithLocalFallback(input: {
  redis: Redis;
  nameSpace?: string;
  logger: RateLimitFallbackLogger;
  localCacheSize?: number;
  warnIntervalMs?: number;
  commandTimeoutMs?: number;
  now?: () => number;
}): FastifyRateLimitStoreCtor {
  const now = input.now ?? Date.now;
  const timeoutMs = input.commandTimeoutMs ?? 500;
  const warnIntervalMs = input.warnIntervalMs ?? 30_000;
  const state: SharedState = { degraded: false, lastWarnAt: Number.NEGATIVE_INFINITY, failuresSinceWarn: 0 };

  const onRedisError = (error: Error) => {
    state.failuresSinceWarn += 1;
    const at = now();
    if (!state.degraded || at - state.lastWarnAt >= warnIntervalMs) {
      input.logger.warn(
        {
          event: "rate_limit_redis_unavailable",
          failures_since_last_warning: state.failuresSinceWarn,
          error_name: error.name,
          error_message: error.message,
        },
        "Rate-limit Redis store unavailable; enforcing per-instance in-memory limits",
      );
      state.lastWarnAt = at;
      state.failuresSinceWarn = 0;
    }
    state.degraded = true;
  };
  const onRedisSuccess = () => {
    if (!state.degraded) return;
    state.degraded = false;
    state.failuresSinceWarn = 0;
    input.logger.info?.({ event: "rate_limit_redis_recovered" }, "Rate-limit Redis store recovered");
  };

  class FallbackStore implements FastifyRateLimitStore {
    private readonly primary: InternalStore;
    private readonly fallback: InternalStore;

    constructor(options: FastifyRateLimitOptions, stores?: { primary: InternalStore; fallback: InternalStore }) {
      this.primary =
        stores?.primary ??
        new RedisStore(
          (options as StoreOptions).continueExceeding ?? false,
          (options as StoreOptions).exponentialBackoff ?? false,
          input.redis,
          input.nameSpace ?? "fastify-rate-limit-",
        );
      this.fallback =
        stores?.fallback ??
        new LocalStore(
          (options as StoreOptions).continueExceeding ?? false,
          (options as StoreOptions).exponentialBackoff ?? false,
          input.localCacheSize ?? 20_000,
        );
    }

    private run(method: "incr" | "read", key: string, callback: StoreCallback, timeWindow: number, max: number): void {
      const local = () => {
        const fallbackMethod = this.fallback[method];
        if (!fallbackMethod) return callback(null, { current: 0, ttl: 0 });
        fallbackMethod.call(this.fallback, key, callback, timeWindow, max);
      };
      const primaryMethod = this.primary[method];
      if (!primaryMethod) return local();
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        onRedisError(error);
        local();
      };
      // A connected-but-stalled Redis must not stall every request behind it.
      const timer = setTimeout(() => fail(new Error("Rate-limit Redis command timed out")), timeoutMs);
      timer.unref?.();
      try {
        primaryMethod.call(
          this.primary,
          key,
          (error, result) => {
            if (error || !result) return fail(error ?? new Error("Empty rate-limit store response"));
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            onRedisSuccess();
            callback(null, result);
          },
          timeWindow,
          max,
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }

    incr(key: string, callback: StoreCallback, timeWindow: number, max: number): void {
      this.run("incr", key, callback, timeWindow, max);
    }

    read(key: string, callback: StoreCallback, timeWindow: number, max: number): void {
      this.run("read", key, callback, timeWindow, max);
    }

    child(routeOptions: Parameters<FastifyRateLimitStore["child"]>[0]): FastifyRateLimitStore {
      // The plugin actually passes its merged limiter params (with routeInfo).
      const merged = routeOptions as unknown as RouteOptions;
      return new FallbackStore(merged, {
        primary: this.primary.child(merged),
        fallback: this.fallback.child(merged),
      });
    }
  }

  return FallbackStore as unknown as FastifyRateLimitStoreCtor;
}
