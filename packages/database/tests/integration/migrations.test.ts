import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_migrations_${randomUUID().replaceAll("-", "")}`;
const concurrentSchema = `test_migrations_concurrent_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

beforeAll(async () => Promise.all([schema, concurrentSchema].map((name) => dropTestSchema(config.databaseUrl, name))));
afterAll(async () => Promise.all([schema, concurrentSchema].map((name) => dropTestSchema(config.databaseUrl, name))));

describe("foundation migrations", () => {
  it("apply from an empty schema and are idempotent", async () => {
    const expectedMigrations = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    const first = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
    const second = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
    expect(first.applied).toEqual(expectedMigrations);
    expect(second.applied).toEqual([]);
    expect(second.current).toEqual(expectedMigrations);
  });

  it("serializes concurrent migration attempts for the same empty schema", async () => {
    const expectedMigrations = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema: concurrentSchema }),
      ),
    );

    expect(results.map((result) => result.applied.length).sort((left, right) => left - right)).toEqual([
      0,
      expectedMigrations.length,
    ]);
    expect(results.every((result) => result.current.join() === expectedMigrations.join())).toBe(true);
  });
});
