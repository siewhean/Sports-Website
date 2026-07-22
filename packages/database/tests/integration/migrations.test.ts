import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_migrations_${randomUUID().replaceAll("-", "")}`;
const concurrentSchema = `test_migrations_concurrent_${randomUUID().replaceAll("-", "")}`;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
// Full-suite integration runs intentionally contend for the same local PostgreSQL instance.
// Keep the larger ceiling scoped to the two tests that apply the complete migration chain.
const fullMigrationChainTimeoutMs = 15_000;

beforeAll(async () => Promise.all([schema, concurrentSchema].map((name) => dropTestSchema(config.databaseUrl, name))));
afterAll(async () => Promise.all([schema, concurrentSchema].map((name) => dropTestSchema(config.databaseUrl, name))));

describe("foundation migrations", () => {
  it(
    "apply from an empty schema and are idempotent",
    async () => {
      const expectedMigrations = (await readdir(migrationsDirectory))
        .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
        .sort();
      const first = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
      const second = await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
      expect(first.applied).toEqual(expectedMigrations);
      expect(second.applied).toEqual([]);
      expect(second.current).toEqual(expectedMigrations);

      const sql = postgres(config.databaseUrl, { max: 1, connection: { search_path: schema } });
      try {
        const [dependencies] = await sql<
          { hashSemanticsPreserved: boolean; scheduleDependsOnSha: boolean; shaDependsOnCanonical: boolean }[]
        >`
        SELECT
          phase4_schedule_problem_hash(
            jsonb_build_object('job_id', '00000000-0000-4000-8000-000000000001', 'value', 1)
          ) = phase4_sha256_json(jsonb_build_object('value', 1)) AS "hashSemanticsPreserved",
          EXISTS (
            SELECT 1
            FROM pg_depend dependency
            WHERE dependency.classid = 'pg_proc'::regclass
              AND dependency.refclassid = 'pg_proc'::regclass
              AND dependency.objid = to_regprocedure(${`${schema}.phase4_schedule_problem_hash(jsonb)`})
              AND dependency.refobjid = to_regprocedure(${`${schema}.phase4_sha256_json(jsonb)`})
          ) AS "scheduleDependsOnSha",
          EXISTS (
            SELECT 1
            FROM pg_depend dependency
            WHERE dependency.classid = 'pg_proc'::regclass
              AND dependency.refclassid = 'pg_proc'::regclass
              AND dependency.objid = to_regprocedure(${`${schema}.phase4_sha256_json(jsonb)`})
              AND dependency.refobjid = to_regprocedure(${`${schema}.phase3_canonical_jsonb(jsonb)`})
          ) AS "shaDependsOnCanonical"
      `;
        expect(dependencies).toEqual({
          hashSemanticsPreserved: true,
          scheduleDependsOnSha: true,
          shaDependsOnCanonical: true,
        });
      } finally {
        await sql.end({ timeout: 2 });
      }
    },
    fullMigrationChainTimeoutMs,
  );

  it(
    "serializes concurrent migration attempts for the same empty schema",
    async () => {
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
    },
    fullMigrationChainTimeoutMs,
  );

  it("rejects checksum drift in an already-applied migration", async () => {
    const copiedDirectory = await mkdtemp(path.join(os.tmpdir(), "matchday-migrations-"));
    const sql = postgres(config.databaseUrl, { max: 1, connection: { search_path: schema } });
    try {
      await sql`UPDATE schema_migrations SET checksum=NULL WHERE name='0001_foundation.sql'`;
      await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory, schema });
      const [pinned] = await sql<{ checksum: string | null }[]>`
        SELECT checksum FROM schema_migrations WHERE name='0001_foundation.sql'`;
      expect(pinned?.checksum).toMatch(/^[0-9a-f]{64}$/);

      await cp(migrationsDirectory, copiedDirectory, { recursive: true });
      await appendFile(path.join(copiedDirectory, "0001_foundation.sql"), "\n-- unexpected drift\n");
      await expect(
        migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory: copiedDirectory, schema }),
      ).rejects.toThrow(/checksum mismatch: 0001_foundation\.sql/i);
    } finally {
      await sql.end({ timeout: 2 });
      await rm(copiedDirectory, { recursive: true, force: true });
    }
  });
});
