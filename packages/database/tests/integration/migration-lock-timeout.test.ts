import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "@matchday/config";
import { dropTestSchema, migrateDatabase } from "../../src/migrations.js";

const config = parseConfig(process.env);
const schema = `test_migration_lock_${randomUUID().replaceAll("-", "")}`;
let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "matchday-migration-lock-"));
  await writeFile(path.join(directory, "0001_create.sql"), "CREATE TABLE contended (id integer PRIMARY KEY);\n");
  await dropTestSchema(config.databaseUrl, schema);
  await migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory: directory, schema });
  await writeFile(path.join(directory, "0002_alter.sql"), "ALTER TABLE contended ADD COLUMN note text;\n");
});

afterAll(async () => {
  await dropTestSchema(config.databaseUrl, schema);
  await rm(directory, { recursive: true, force: true });
});

describe("migration lock timeout", () => {
  it("fails fast with a clear error, without recording the migration, when its table is locked", async () => {
    const blocker = postgres(config.databaseUrl, { max: 1, onnotice: () => undefined });
    const warnings: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A long application transaction holding a conflicting lock on the table.
    const holder = blocker.begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE "${schema}".contended IN ACCESS SHARE MODE`);
      locked();
      await released;
    });
    await lockTaken;
    const started = Date.now();
    try {
      await expect(
        migrateDatabase({
          databaseUrl: config.databaseUrl,
          migrationsDirectory: directory,
          schema,
          lockTimeoutMs: 200,
          lockRetries: 2,
          lockRetryBaseDelayMs: 50,
          logger: { info: () => undefined, warn: (message) => warnings.push(message) },
        }),
      ).rejects.toThrow(/0002_alter\.sql could not acquire its locks within lock_timeout after 3 attempt/u);
      // 3 x 200 ms lock waits plus ~150 ms of backoff instead of an indefinite hang
      // (the bound is loose because parallel suites may hold the migration advisory lock first).
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(warnings).toHaveLength(2);
    } finally {
      release();
      await holder;
      await blocker.end({ timeout: 1 });
    }

    const sql = postgres(config.databaseUrl, {
      max: 1,
      onnotice: () => undefined,
      connection: { search_path: schema },
    });
    try {
      expect(await sql`SELECT name FROM schema_migrations ORDER BY name`).toEqual([{ name: "0001_create.sql" }]);
    } finally {
      await sql.end({ timeout: 1 });
    }

    // Once the blocking session has finished, the same run applies the migration.
    await expect(
      migrateDatabase({ databaseUrl: config.databaseUrl, migrationsDirectory: directory, schema, lockTimeoutMs: 200 }),
    ).resolves.toMatchObject({ applied: ["0002_alter.sql"] });
  }, 30_000);
});
