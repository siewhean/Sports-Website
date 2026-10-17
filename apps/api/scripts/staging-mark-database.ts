/**
 * Track R8: operator-only staging marker creation.
 *
 * Marks the connected database as staging by writing a staging_environment_markers row bound to
 * the server's pg_control_system().system_identifier. The staging replica seeder refuses to run
 * without this marker and never creates it itself.
 *
 * Run ON THE STAGING HOST, interactively (see docs/operations/STAGING_REPLICA_RUNBOOK.md):
 *   STAGING_DB_SYSTEM_IDENTIFIERS=<id> DATABASE_URL=postgres://... pnpm staging:mark-database
 *
 * Refuses when: APP_ENV/NODE_ENV is production, the URL fails the production/allowlist URL guard,
 * the server reports the production address, the system_identifier is not allowlisted, stdin is not
 * an interactive TTY, or the operator does not type the exact system_identifier to confirm.
 */

import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { assertDatabaseServerIdentity, assertSafeNonProductionDatabase } from "./staging-db-guards.js";

export async function markStagingDatabase(options: {
  databaseUrl: string;
  confirm: (prompt: string) => Promise<string>;
  log?: (msg: string) => void;
}): Promise<{ systemIdentifier: string; database: string }> {
  const log = options.log ?? console.log;
  // Marking is always explicit, so the non-loopback opt-in is implied by running this command.
  assertSafeNonProductionDatabase(options.databaseUrl, true);

  const sql = postgres(options.databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const identity = await assertDatabaseServerIdentity(sql);
    log(`Connected server: database=${identity.database} address=${identity.serverAddr ?? "unix-socket"}`);
    log(`system_identifier: ${identity.systemIdentifier}`);

    const typed = (await options.confirm("Type the system_identifier above to mark this database as STAGING: ")).trim();
    if (typed !== identity.systemIdentifier) {
      throw new Error("Confirmation did not match the server system_identifier. Nothing was written.");
    }

    await sql.begin(async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS staging_environment_markers (
          id text PRIMARY KEY,
          is_staging boolean NOT NULL DEFAULT true,
          environment text NOT NULL DEFAULT 'staging',
          system_identifier text NOT NULL,
          marked_by text NOT NULL DEFAULT current_user,
          created_at timestamptz NOT NULL DEFAULT now()
        );
      `;
      await tx`
        INSERT INTO staging_environment_markers (id, is_staging, environment, system_identifier)
        VALUES ('primary_marker', true, 'staging', ${identity.systemIdentifier})
        ON CONFLICT (id) DO UPDATE
          SET is_staging = true, environment = 'staging', system_identifier = EXCLUDED.system_identifier,
              marked_by = current_user, created_at = now();
      `;
    });
    log(`Marked database "${identity.database}" as staging (system_identifier ${identity.systemIdentifier}).`);
    return { systemIdentifier: identity.systemIdentifier, database: identity.database };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[REFUSED] DATABASE_URL is required.");
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error("[REFUSED] staging-mark-database must be run interactively (stdin is not a TTY).");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  markStagingDatabase({ databaseUrl, confirm: (prompt) => rl.question(prompt) })
    .then(() => {
      rl.close();
      process.exit(0);
    })
    .catch((err: unknown) => {
      rl.close();
      console.error("[REFUSED]", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
