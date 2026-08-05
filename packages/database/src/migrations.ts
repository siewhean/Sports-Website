import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const identifierPattern = /^[a-z][a-z0-9_]*$/;
export const migrationAdvisoryLockId = 1_450_121_337;

export type MigrationResult = {
  applied: readonly string[];
  current: readonly string[];
};

function migrationChecksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function migrateDatabase(options: {
  databaseUrl: string;
  migrationsDirectory: string;
  schema?: string;
}): Promise<MigrationResult> {
  const schema = options.schema ?? "public";
  if (!identifierPattern.test(schema)) throw new Error(`Invalid migration schema: ${schema}`);

  const migrationNames = (await readdir(options.migrationsDirectory))
    .filter((name) => migrationPattern.test(name))
    .sort();
  if (migrationNames.length === 0) throw new Error("No database migrations found");

  const sql = postgres(options.databaseUrl, { max: 1, onnotice: () => undefined });
  let lockAcquired = false;
  try {
    // Extension creation and schema bookkeeping are database-global operations.
    // A session lock keeps parallel deploy/test migrators from racing before either transaction commits.
    await sql`SELECT pg_advisory_lock(${migrationAdvisoryLockId})`;
    lockAcquired = true;
    // Keep database-global extension objects out of isolated application/test
    // schemas. Otherwise dropping one schema can remove pgcrypto while another
    // schema is still using migration functions that depend on it.
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`;
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await sql.unsafe(`SET search_path TO "${schema}", public`);
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$')
      )
    `;
    // Older installations only recorded migration names. Adding a nullable
    // digest is backward compatible; the first run on that installation pins
    // the exact files present, and every later run rejects drift.
    await sql`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text`;
    await sql.unsafe(`DO $migration_checksum_constraint$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid='schema_migrations'::regclass
            AND conname='schema_migrations_checksum_check'
        ) THEN
          ALTER TABLE schema_migrations ADD CONSTRAINT schema_migrations_checksum_check
            CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$');
        END IF;
      END;
    $migration_checksum_constraint$`);

    const currentRows = await sql<{ name: string; checksum: string | null }[]>`
      SELECT name,checksum FROM schema_migrations ORDER BY name`;
    const current = new Set(currentRows.map((row) => row.name));
    const migrationContents = new Map<string, string>();
    for (const name of migrationNames) {
      migrationContents.set(name, await readFile(path.join(options.migrationsDirectory, name), "utf8"));
    }
    for (const row of currentRows) {
      const contents = migrationContents.get(row.name);
      if (contents === undefined) {
        throw new Error(`Applied migration is missing from disk: ${row.name}`);
      }
      const checksum = migrationChecksum(contents);
      if (row.checksum === null) {
        await sql`UPDATE schema_migrations SET checksum=${checksum} WHERE name=${row.name} AND checksum IS NULL`;
      } else if (row.checksum !== checksum) {
        throw new Error(`Applied migration checksum mismatch: ${row.name}`);
      }
    }
    const applied: string[] = [];

    for (const name of migrationNames) {
      if (current.has(name)) continue;
      const contents = migrationContents.get(name)!;
      const checksum = migrationChecksum(contents);
      await sql.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL search_path TO "${schema}", public`);
        await transaction.unsafe(contents);
        await transaction`INSERT INTO schema_migrations (name,checksum) VALUES (${name},${checksum})`;
      });
      current.add(name);
      applied.push(name);
    }

    return { applied, current: [...current].sort() };
  } finally {
    if (lockAcquired) await sql`SELECT pg_advisory_unlock(${migrationAdvisoryLockId})`;
    await sql.end();
  }
}

export async function dropTestSchema(databaseUrl: string, schema: string): Promise<void> {
  if (!identifierPattern.test(schema) || !schema.startsWith("test_")) {
    throw new Error("Refusing to drop a non-test schema");
  }
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    // A migrated test schema contains enough dependent objects that concurrent
    // DROP SCHEMA operations can exhaust PostgreSQL's shared lock table. Use
    // the same database-global lock as migrations so setup and teardown remain
    // isolated without weakening the rest of the integration suite's concurrency.
    // The transaction-scoped form also releases the lock automatically if the
    // DROP fails, so cleanup cannot strand the database-global migration lock.
    await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(${migrationAdvisoryLockId})`;
      await transaction.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    });
  } finally {
    await sql.end();
  }
}
