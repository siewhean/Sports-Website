import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dropTestSchema, migrateDatabase } from "@matchday/database";
import type { PostgresJsSql } from "@matchday/identity";
import { Redis } from "ioredis";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";
import { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { reconcileScoringAccessHmacKeyring } from "../../src/scoring-access-hmac-keyring.js";
import { RedisScoringAccessRateLimiter } from "../../src/scoring-access-rate-limit.js";
import { healthyProbes, testConfig } from "../helpers.js";

const runInfraTests = process.env.RUN_INFRA_TESTS === "1";
const describeInfra = runInfraTests ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgres://matchday:matchday@127.0.0.1:5432/matchday";
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
const schema = `test_scoring_multi_api_${randomUUID().replaceAll("-", "")}`;
const namespace = `matchday:test:scoring-multi-api:${randomUUID()}:`;
const guardKey = `${namespace.slice(0, -1)}-unrelated-guard`;
const rateLimitKeyring = {
  primary: { version: "v2", secret: "multi-api-rate-limit-hmac-primary-secret" },
  verificationOnly: [{ version: "v1", secret: "multi-api-rate-limit-hmac-previous-secret" }],
  legacyV1MaterialCommitment: createHash("sha256")
    .update("matchday:scoring-access-hmac-key-material:v1:\u0000", "utf8")
    .update("multi-api-rate-limit-hmac-previous-secret", "utf8")
    .digest("hex"),
};
const fallbackCodeSecret = "multi-api-fallback-code-hmac-secret";
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/database/migrations",
);

let sql: Sql;
let redisConnections: Redis[] = [];
let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
let origins: string[] = [];

async function ownedKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${namespace}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

describeInfra("scoring access rate limits across real API instances", () => {
  beforeAll(async () => {
    await dropTestSchema(databaseUrl, schema);
    await migrateDatabase({ databaseUrl, migrationsDirectory, schema });
    sql = postgres(databaseUrl, { max: 6, onnotice: () => undefined, connection: { search_path: schema } });
    await reconcileScoringAccessHmacKeyring(sql as unknown as PostgresJsSql, rateLimitKeyring);
    redisConnections = [
      new Redis(redisUrl, { maxRetriesPerRequest: 1 }),
      new Redis(redisUrl, { maxRetriesPerRequest: 1 }),
    ];
    expect(await ownedKeys(redisConnections[0]!)).toEqual([]);
    await redisConnections[0]!.set(guardKey, "preserve", "EX", 60);
    apps = await Promise.all(
      redisConnections.map((redis) =>
        buildApp({
          config: testConfig({ DATABASE_URL: databaseUrl, REDIS_URL: redisUrl }),
          probes: healthyProbes,
          identityRuntime: {
            authenticate: async () => {
              throw new Error("Anonymous scoring exchange must not authenticate an organiser session.");
            },
            verifyCsrfToken: () => false,
          } as unknown as IdentityApiRuntime,
          phase2Runtime: new Phase2Runtime(
            sql as unknown as PostgresJsSql,
            phase2DomainAdapter,
            undefined,
            new RedisScoringAccessRateLimiter(redis, rateLimitKeyring, namespace),
            fallbackCodeSecret,
          ),
          anonymousRateLimitMax: 1_000,
        }),
      ),
    );
    expect(
      apps.every((app) => app.hasRoute({ method: "POST", url: "/api/v1/scoring/access/exchange" })),
      apps[0]?.printRoutes(),
    ).toBe(true);
    origins = await Promise.all(apps.map((app) => app.listen({ host: "127.0.0.1", port: 0 })));
  });

  afterAll(async () => {
    await Promise.allSettled(apps.map((app) => app.close()));
    const redis = redisConnections[0];
    if (redis) {
      const keys = await ownedKeys(redis);
      if (keys.length > 0) await redis.unlink(...keys);
      expect(await ownedKeys(redis)).toEqual([]);
      expect(await redis.get(guardKey)).toBe("preserve");
      await redis.unlink(guardKey);
    }
    await Promise.allSettled(redisConnections.map((connection) => connection.quit()));
    await sql?.end({ timeout: 2 });
    await dropTestSchema(databaseUrl, schema);
  });

  it("enforces shared pair and IP cooldowns through the production exchange route", async () => {
    const invoke = async (instance: number, credential: string) =>
      fetch(new URL("/api/v1/scoring/access/exchange", origins[instance]).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: credential, device_id: randomUUID().repeat(2) }),
      });
    const pairCredential = "p".repeat(43);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await invoke(attempt % 2, pairCredential);
      expect(response.status, await response.text()).toBe(403);
      expect(response.headers.get("ratelimit-limit")).toBe("5");
    }
    const pairCooldown = await invoke(0, pairCredential);
    expect(pairCooldown.status).toBe(429);
    expect(pairCooldown.headers.get("ratelimit-limit")).toBe("5");
    expect(pairCooldown.headers.get("ratelimit-remaining")).toBe("0");
    expect(pairCooldown.headers.get("retry-after")).toBe("900");

    const sameNatNeighbour = await invoke(1, "n".repeat(43));
    expect(sameNatNeighbour.status).toBe(403);
    expect(sameNatNeighbour.headers.get("retry-after")).toBeNull();

    // Five pair attempts plus the neighbour consumed six of the shared IP budget.
    for (let attempt = 0; attempt < 13; attempt += 1) {
      expect((await invoke(attempt % 2, `${String(attempt).padStart(2, "0")}${"i".repeat(41)}`)).status).toBe(403);
    }
    const ipCooldown = await invoke(1, `19${"i".repeat(41)}`);
    expect(ipCooldown.status).toBe(429);
    expect(ipCooldown.headers.get("ratelimit-limit")).toBe("20");
    expect(ipCooldown.headers.get("ratelimit-remaining")).toBe("0");
    expect(ipCooldown.headers.get("retry-after")).toBe("900");

    const keys = await ownedKeys(redisConnections[0]!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join("\n")).not.toContain(pairCredential);
    expect(keys.join("\n")).not.toContain("127.0.0.1");
    expect(await redisConnections[0]!.get(guardKey)).toBe("preserve");
    expect(
      await sql`
        SELECT DISTINCT hmac_key_version
        FROM scoring_access_attempts
        ORDER BY hmac_key_version
      `,
    ).toEqual([{ hmac_key_version: "v2" }]);
  });
});
