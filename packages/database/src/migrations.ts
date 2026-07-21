import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const identifierPattern = /^[a-z][a-z0-9_]*$/;
const migrationAdvisoryLockId = 1_450_121_337;

export type MigrationResult = {
  applied: readonly string[];
  current: readonly string[];
};

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
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await sql.unsafe(`SET search_path TO "${schema}", public`);
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const currentRows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const current = new Set(currentRows.map((row) => row.name));
    const applied: string[] = [];

    for (const name of migrationNames) {
      if (current.has(name)) continue;
      const contents = await readFile(path.join(options.migrationsDirectory, name), "utf8");
      await sql.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL search_path TO "${schema}", public`);
        await transaction.unsafe(contents);
        await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
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
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await sql.end();
  }
}
