import { Redis } from "ioredis";
import postgres from "postgres";
import type { AppConfig } from "@matchday/config";

export type DependencyProbes = {
  database: () => Promise<boolean>;
  redis: () => Promise<boolean>;
  queue: () => Promise<boolean>;
  /** Releases long-lived probe connections; called from the app's onClose hook. */
  close?: () => Promise<void>;
};

const probeTimeoutMs = 2_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs = probeTimeoutMs): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Dependency probe timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/*
 * Readiness is polled frequently. Probes keep one lazily-opened connection per
 * dependency instead of opening (and TLS/AUTH-handshaking) a fresh connection
 * on every poll, which under a flaky dependency amplified connection churn.
 */
function redisProbe(redisUrl: string) {
  let client: Redis | undefined;
  const connection = () => {
    if (!client) {
      client = new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: probeTimeoutMs,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
      });
      client.on("error", () => undefined);
    }
    return client;
  };
  return {
    async probe(): Promise<boolean> {
      const redis = connection();
      try {
        if (redis.status === "wait" || redis.status === "end") await withTimeout(redis.connect());
        return (await withTimeout(redis.ping())) === "PONG";
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      client?.disconnect();
      client = undefined;
    },
  };
}

function databaseProbe(databaseUrl: string) {
  let sql: postgres.Sql | undefined;
  return {
    async probe(): Promise<boolean> {
      sql ??= postgres(databaseUrl, { connect_timeout: 2, idle_timeout: 60, max: 1, onnotice: () => undefined });
      try {
        const result = await withTimeout(sql<{ ok: number }[]>`SELECT 1 AS ok`);
        return result[0]?.ok === 1;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      const current = sql;
      sql = undefined;
      await current?.end({ timeout: 1 });
    },
  };
}

export function createDependencyProbes(config: AppConfig): DependencyProbes {
  const database = databaseProbe(config.databaseUrl);
  const redis = redisProbe(config.redisUrl);
  return {
    database: () => database.probe(),
    redis: () => redis.probe(),
    // BullMQ uses the same Redis deployment; one shared probe connection suffices.
    queue: () => redis.probe(),
    close: async () => {
      await Promise.allSettled([database.close(), redis.close()]);
    },
  };
}
