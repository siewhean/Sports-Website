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

export type MigrationLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export type MigrationTimeouts = {
  /** lock_timeout for each migration transaction and the bootstrap DDL (default 5 s). */
  lockTimeoutMs?: number;
  /** statement_timeout for each migration transaction (default 10 min; 0 disables). */
  statementTimeoutMs?: number;
  /** Additional attempts after a migration fails on lock_timeout (default 3). */
  lockRetries?: number;
  /** First retry delay; doubles per attempt with jitter (default 1 s). */
  lockRetryBaseDelayMs?: number;
};

export const defaultMigrationTimeouts = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 10 * 60_000,
  lockRetries: 3,
  lockRetryBaseDelayMs: 1_000,
} as const satisfies Required<MigrationTimeouts>;

/** Default for library callers (tests, e2e harnesses): only lock retries are reported. */
const quietMigrationLogger: MigrationLogger = {
  info: () => undefined,
  warn: (message) => console.warn(message),
};

export const consoleMigrationLogger: MigrationLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
};

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

/** PostgreSQL lock_not_available, raised when lock_timeout expires. */
export function isLockTimeoutError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "55P03");
}

/** PostgreSQL query_canceled, raised when statement_timeout expires. */
export function isStatementTimeoutError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "57014");
}

/**
 * Runs one migration, retrying only when it lost a lock race (lock_timeout).
 * Each attempt is a fresh transaction, so a failed attempt has rolled back
 * completely before the next begins. Any other error, including a statement
 * timeout, fails immediately.
 */
export async function runWithLockRetry<T>(
  name: string,
  attempt: () => Promise<T>,
  options: {
    retries: number;
    baseDelayMs: number;
    logger: MigrationLogger;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  },
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  for (let attemptNumber = 0; ; attemptNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isLockTimeoutError(error)) throw error;
      if (attemptNumber >= options.retries) {
        throw new Error(
          `Migration ${name} could not acquire its locks within lock_timeout after ${attemptNumber + 1} attempt(s); ` +
            "another session holds a conflicting lock. Retry once the blocking session has finished.",
          { cause: error },
        );
      }
      const delay = Math.round(options.baseDelayMs * 2 ** attemptNumber * (0.5 + random()));
      options.logger.warn(
        `Migration ${name} hit lock_timeout (attempt ${attemptNumber + 1}/${options.retries + 1}); retrying in ${delay} ms`,
      );
      await sleep(delay);
    }
  }
}

function migrationChecksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function migrateDatabase(
  options: {
    databaseUrl: string;
    migrationsDirectory: string;
    schema?: string;
    logger?: MigrationLogger;
  } & MigrationTimeouts,
): Promise<MigrationResult> {
  const schema = options.schema ?? "public";
  if (!identifierPattern.test(schema)) throw new Error(`Invalid migration schema: ${schema}`);
  const lockTimeoutMs = nonNegativeInteger(
    options.lockTimeoutMs ?? defaultMigrationTimeouts.lockTimeoutMs,
    "Migration lock timeout",
  );
  const statementTimeoutMs = nonNegativeInteger(
    options.statementTimeoutMs ?? defaultMigrationTimeouts.statementTimeoutMs,
    "Migration statement timeout",
  );
  const lockRetries = nonNegativeInteger(
    options.lockRetries ?? defaultMigrationTimeouts.lockRetries,
    "Migration lock retries",
  );
  const lockRetryBaseDelayMs = nonNegativeInteger(
    options.lockRetryBaseDelayMs ?? defaultMigrationTimeouts.lockRetryBaseDelayMs,
    "Migration lock retry delay",
  );
  const logger = options.logger ?? quietMigrationLogger;

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
    // Set only after the advisory lock: waiting for a parallel migrator is
    // expected and must not time out, but bootstrap DDL must never queue
    // indefinitely behind application traffic.
    await sql.unsafe(`SET lock_timeout = ${lockTimeoutMs}`);
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
      const started = Date.now();
      try {
        await runWithLockRetry(
          name,
          () =>
            sql.begin(async (transaction) => {
              await transaction.unsafe(`SET LOCAL search_path TO "${schema}", public`);
              // A DDL lock request that waits also blocks every later reader and
              // writer of the table, so fail fast and retry instead of queueing
              // behind a long transaction (MIGRATION_0030_0031_RUNBOOK).
              await transaction.unsafe(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
              await transaction.unsafe(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
              await transaction.unsafe(contents);
              await transaction`INSERT INTO schema_migrations (name,checksum) VALUES (${name},${checksum})`;
            }),
          { retries: lockRetries, baseDelayMs: lockRetryBaseDelayMs, logger },
        );
      } catch (error) {
        if (isStatementTimeoutError(error)) {
          throw new Error(
            `Migration ${name} exceeded statement_timeout (${statementTimeoutMs} ms) and was rolled back`,
            { cause: error },
          );
        }
        throw error;
      }
      logger.info(`Migration ${name} applied in ${Date.now() - started} ms`);
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
