import { probeDatabase } from "@matchday/database";
import { createClient } from "redis";
import type { AppConfig } from "@matchday/config";

export type DependencyProbes = {
  database: () => Promise<boolean>;
  redis: () => Promise<boolean>;
  queue: () => Promise<boolean>;
};

async function probeRedis(redisUrl: string): Promise<boolean> {
  const client = createClient({ url: redisUrl, socket: { connectTimeout: 2_000 } });
  client.on("error", () => undefined);
  try {
    await client.connect();
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    if (client.isOpen) await client.quit();
  }
}

export function createDependencyProbes(config: AppConfig): DependencyProbes {
  return {
    database: () => probeDatabase(config.databaseUrl),
    redis: () => probeRedis(config.redisUrl),
    queue: () => probeRedis(config.redisUrl),
  };
}
