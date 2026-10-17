/**
 * Track R8: staging database safety guards shared by the staging replica seeder
 * and the operator-run marker script (staging-mark-database.ts).
 *
 * Layered model (each layer must pass; none is sufficient on its own):
 *   1. URL guard (assertSafeNonProductionDatabase): env, blocked production IP, host/db-name
 *      patterns, staging host allowlist, explicit opt-in for non-loopback hosts.
 *   2. Server identity guard (assertDatabaseServerIdentity): asks the *connected* server for
 *      pg_control_system().system_identifier and inet_server_addr() and requires the identifier
 *      to be in STAGING_DB_SYSTEM_IDENTIFIERS. This is what covers SSH tunnels / port-forwards:
 *      a tunnel makes production look like "127.0.0.1" to the URL guard, but the server still
 *      reports its own cluster identifier, which will not be in the staging allowlist.
 *   3. Marker guard (assertDatabaseStagingMarker): requires a staging_environment_markers row
 *      that an operator created with the separate marker script, bound to the same
 *      system_identifier (so a staging dump restored onto another cluster is rejected).
 *
 * The seeder never creates the marker. Client-side SSH environment variables and local network
 * interfaces are not inspected: they describe the machine running the script, not the database
 * server, so they cannot detect a tunnel and gave false assurance.
 */

import type { Sql } from "postgres";

export const BLOCKED_PRODUCTION_IP = "129.146.6.204";

export const DEFAULT_ALLOWED_STAGING_SERVERS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "staging.matchday.internal",
  "staging-db.matchday.internal",
  "matchday-staging",
  "staging.internal",
  "staging-db.internal",
];

const BLOCKED_HOST_PATTERNS = [
  "poladex.shop",
  "onrender.com",
  "neon.tech",
  "aws",
  "rds",
  "supabase",
  "prod",
  "production",
];

export function assertSafeNonProductionDatabase(rawUrl: string, allowStagingFlag = false): void {
  if (process.env.APP_ENV === "production" || process.env.NODE_ENV === "production") {
    throw new Error(
      "Safety guard triggered: Seed script cannot run in production environment (APP_ENV or NODE_ENV is 'production').",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid database URL format: "${rawUrl}"`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\//, "").toLowerCase();

  if (hostname === BLOCKED_PRODUCTION_IP || parsed.host.includes(BLOCKED_PRODUCTION_IP)) {
    throw new Error(
      `Safety guard triggered: Database host matches blocked production IP ${BLOCKED_PRODUCTION_IP}. Seeding aborted.`,
    );
  }

  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (hostname.includes(pattern)) {
      throw new Error(
        `Safety guard triggered: Database host "${hostname}" matches protected production pattern "${pattern}". Seeding aborted.`,
      );
    }
  }

  if (dbName.includes("prod") || dbName.includes("production")) {
    throw new Error(
      `Safety guard triggered: Database name "${dbName}" matches protected production keyword. Seeding aborted.`,
    );
  }

  const customAllowed = (process.env.ALLOWED_STAGING_SERVERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowedSet = new Set([...DEFAULT_ALLOWED_STAGING_SERVERS, ...customAllowed]);

  if (!allowedSet.has(hostname)) {
    throw new Error(
      `Safety guard triggered: Database host "${hostname}" is not in the allowed staging servers whitelist (${Array.from(allowedSet).join(", ")}).`,
    );
  }

  const isLoopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0";

  const allowStaging =
    allowStagingFlag || process.env.ALLOW_STAGING_SEED === "1" || process.argv.includes("--allow-staging-seed");

  if (!isLoopback && !allowStaging) {
    throw new Error(
      `Safety guard triggered: Database host "${hostname}" is a non-loopback host. ` +
        `Seeding a remote/staging database requires explicit confirmation via '--allow-staging-seed' CLI flag or 'ALLOW_STAGING_SEED=1' env.`,
    );
  }
}

export function parseStagingSystemIdentifierAllowlist(raw = process.env.STAGING_DB_SYSTEM_IDENTIFIERS): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
  );
}

export interface DatabaseServerIdentity {
  systemIdentifier: string;
  serverAddr: string | null;
  database: string;
}

export async function readDatabaseServerIdentity(sql: Sql): Promise<DatabaseServerIdentity> {
  let rows: { system_identifier: string | null; server_addr: string | null; database: string }[];
  try {
    rows = await sql<{ system_identifier: string | null; server_addr: string | null; database: string }[]>`
      SELECT
        (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
        host(inet_server_addr()) AS server_addr,
        current_database() AS database;
    `;
  } catch (error) {
    throw new Error(
      `Safety guard triggered: Unable to read database server identity (pg_control_system / inet_server_addr): ${
        error instanceof Error ? error.message : String(error)
      }. Refusing to continue without a verifiable server identity.`,
    );
  }
  const row = rows[0];
  if (!row?.system_identifier) {
    throw new Error(
      "Safety guard triggered: Database server did not report a system_identifier. Refusing to continue.",
    );
  }
  return { systemIdentifier: row.system_identifier, serverAddr: row.server_addr, database: row.database };
}

/**
 * Verifies the server actually connected to (not the URL) is an allowlisted staging cluster.
 * Fails closed: an empty/missing STAGING_DB_SYSTEM_IDENTIFIERS allowlist refuses.
 */
export async function assertDatabaseServerIdentity(
  sql: Sql,
  allowlist: Set<string> = parseStagingSystemIdentifierAllowlist(),
): Promise<DatabaseServerIdentity> {
  const identity = await readDatabaseServerIdentity(sql);

  if (identity.serverAddr === BLOCKED_PRODUCTION_IP) {
    throw new Error(
      `Safety guard triggered: Connected database server reports address ${BLOCKED_PRODUCTION_IP} (production). Refusing to continue.`,
    );
  }

  if (allowlist.size === 0) {
    throw new Error(
      "Safety guard triggered: STAGING_DB_SYSTEM_IDENTIFIERS is empty. Set it to the comma-separated pg_control_system() " +
        `system_identifier values of approved staging clusters (connected server reports ${identity.systemIdentifier}).`,
    );
  }

  if (!allowlist.has(identity.systemIdentifier)) {
    throw new Error(
      `Safety guard triggered: Connected database server system_identifier ${identity.systemIdentifier} is not in ` +
        "STAGING_DB_SYSTEM_IDENTIFIERS. This catches tunnels/port-forwards that make another cluster look local. Refusing to continue.",
    );
  }

  return identity;
}

/**
 * Requires an operator-created staging marker bound to the connected cluster's system_identifier.
 * This function never creates the marker; use apps/api/scripts/staging-mark-database.ts on the staging host.
 */
export async function assertDatabaseStagingMarker(sql: Sql, expectedSystemIdentifier: string): Promise<void> {
  const tableCheck = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'staging_environment_markers'
    ) AS exists;
  `;

  if (!tableCheck[0]?.exists) {
    const [dbNameRow] = await sql<{ current_database: string }[]>`SELECT current_database();`;
    const dbName = dbNameRow?.current_database ?? "unknown";
    throw new Error(
      `Safety guard triggered: Database "${dbName}" lacks a verified 'this is staging' marker in table 'staging_environment_markers'. ` +
        "The seeder never creates this marker. An operator must run 'pnpm staging:mark-database' on the staging host " +
        "(see docs/operations/STAGING_REPLICA_RUNBOOK.md).",
    );
  }

  const rows = await sql<{ is_staging: boolean; environment: string; system_identifier: string | null }[]>`
    SELECT is_staging, environment, system_identifier FROM staging_environment_markers WHERE id = 'primary_marker';
  `;
  const marker = rows[0];
  if (!marker || marker.is_staging !== true || marker.environment !== "staging") {
    throw new Error(
      "Safety guard triggered: Database marker table 'staging_environment_markers' exists but is not marked as staging.",
    );
  }
  if (marker.system_identifier !== expectedSystemIdentifier) {
    throw new Error(
      `Safety guard triggered: Staging marker is bound to system_identifier ${marker.system_identifier ?? "null"} but the ` +
        `connected server reports ${expectedSystemIdentifier} (restored dump or different cluster). Re-mark on the staging host.`,
    );
  }
}
