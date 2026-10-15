import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  assertSafeNonProductionDatabase,
  assertDatabaseServerIdentity,
  assertDatabaseStagingMarker,
  BLOCKED_PRODUCTION_IP,
} from "../../scripts/seed-staging-production-replica.js";
import { parseStagingSystemIdentifierAllowlist } from "../../scripts/staging-db-guards.js";
import { markStagingDatabase } from "../../scripts/staging-mark-database.js";

type FakeSql = Parameters<typeof assertDatabaseStagingMarker>[0];

function fakeSql(respond: (query: string) => unknown, executed: string[] = []): FakeSql {
  return vi.fn().mockImplementation((strings: TemplateStringsArray) => {
    const q = strings.join(" ");
    executed.push(q);
    try {
      return Promise.resolve(respond(q));
    } catch (error) {
      return Promise.reject(error);
    }
  }) as unknown as FakeSql;
}

const STAGING_ID = "7300000000000000001";
const OTHER_ID = "7300000000000000999";

describe("assertSafeNonProductionDatabase", () => {
  const originalAppEnv = process.env.APP_ENV;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowStaging = process.env.ALLOW_STAGING_SEED;
  const originalSshClient = process.env.SSH_CLIENT;
  const originalSshConnection = process.env.SSH_CONNECTION;
  const originalAllowedServers = process.env.ALLOWED_STAGING_SERVERS;

  beforeEach(() => {
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;
    delete process.env.ALLOW_STAGING_SEED;
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_CONNECTION;
    delete process.env.ALLOWED_STAGING_SERVERS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAppEnv !== undefined) process.env.APP_ENV = originalAppEnv;
    else delete process.env.APP_ENV;

    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;

    if (originalAllowStaging !== undefined) process.env.ALLOW_STAGING_SEED = originalAllowStaging;
    else delete process.env.ALLOW_STAGING_SEED;

    if (originalSshClient !== undefined) process.env.SSH_CLIENT = originalSshClient;
    else delete process.env.SSH_CLIENT;

    if (originalSshConnection !== undefined) process.env.SSH_CONNECTION = originalSshConnection;
    else delete process.env.SSH_CONNECTION;

    if (originalAllowedServers !== undefined) process.env.ALLOWED_STAGING_SERVERS = originalAllowedServers;
    else delete process.env.ALLOWED_STAGING_SERVERS;
  });

  it("permits local loopback database URLs without extra flags", () => {
    expect(() =>
      assertSafeNonProductionDatabase("postgres://matchday:matchday@127.0.0.1:5432/matchday_staging"),
    ).not.toThrow();
    expect(() =>
      assertSafeNonProductionDatabase("postgres://matchday:matchday@localhost:5432/matchday_dev"),
    ).not.toThrow();
  });

  it("blocks execution if APP_ENV or NODE_ENV is set to production", () => {
    process.env.APP_ENV = "production";
    expect(() => assertSafeNonProductionDatabase("postgres://matchday:matchday@127.0.0.1:5432/matchday_test")).toThrow(
      /cannot run in production environment/,
    );

    delete process.env.APP_ENV;
    process.env.NODE_ENV = "production";
    expect(() => assertSafeNonProductionDatabase("postgres://matchday:matchday@127.0.0.1:5432/matchday_test")).toThrow(
      /cannot run in production environment/,
    );
  });

  it("strictly blocks production IP 129.146.6.204 in database URL", () => {
    expect(() =>
      assertSafeNonProductionDatabase(`postgres://u:p@${BLOCKED_PRODUCTION_IP}:5432/matchday_staging`, true),
    ).toThrow(/matches blocked production IP 129.146.6.204/);
  });

  it("does not rely on client-side SSH env vars (tunnels are covered by the server identity check)", () => {
    process.env.SSH_CONNECTION = "129.146.6.204 54321 10.0.0.1 22";
    // The URL guard cannot see through a tunnel; assertDatabaseServerIdentity is the protection.
    expect(() =>
      assertSafeNonProductionDatabase("postgres://matchday:matchday@127.0.0.1:5432/matchday_staging"),
    ).not.toThrow();
  });

  it("strictly blocks production host patterns", () => {
    const dangerousHosts = [
      "postgres://u:p@db.poladex.shop/matchday",
      "postgres://u:p@app-prod.onrender.com/matchday",
      "postgres://u:p@ep-silent-sea-1234.us-east-2.aws.neon.tech/matchday",
      "postgres://u:p@matchday-prod.c49s.rds.amazonaws.com/matchday",
      "postgres://u:p@db.supabase.co/matchday",
      "postgres://u:p@production-postgres.internal:5432/matchday",
    ];

    for (const url of dangerousHosts) {
      expect(() => assertSafeNonProductionDatabase(url, true)).toThrow(/matches protected production pattern/);
    }
  });

  it("strictly blocks database names with 'prod' or 'production'", () => {
    expect(() => assertSafeNonProductionDatabase("postgres://u:p@127.0.0.1:5432/matchday_production")).toThrow(
      /matches protected production keyword/,
    );
    expect(() => assertSafeNonProductionDatabase("postgres://u:p@127.0.0.1:5432/prod_matchday")).toThrow(
      /matches protected production keyword/,
    );
  });

  it("enforces staging servers whitelist", () => {
    // Non-whitelisted host
    expect(() =>
      assertSafeNonProductionDatabase("postgres://u:p@unauthorized-host.example.com:5432/matchday_staging", true),
    ).toThrow(/not in the allowed staging servers whitelist/);

    // Whitelisted host with flag
    expect(() =>
      assertSafeNonProductionDatabase("postgres://u:p@staging.matchday.internal:5432/matchday_staging", true),
    ).not.toThrow();

    // Whitelist extended via env var
    process.env.ALLOWED_STAGING_SERVERS = "custom-staging-node.lan";
    expect(() =>
      assertSafeNonProductionDatabase("postgres://u:p@custom-staging-node.lan:5432/matchday_staging", true),
    ).not.toThrow();
  });

  it("requires explicit confirmation flag for non-loopback hosts", () => {
    const remoteStaging = "postgres://u:p@staging-db.internal:5432/matchday_staging";

    // Without flag: throws
    expect(() => assertSafeNonProductionDatabase(remoteStaging)).toThrow(/requires explicit confirmation/);

    // With allowStagingFlag = true: succeeds
    expect(() => assertSafeNonProductionDatabase(remoteStaging, true)).not.toThrow();

    // With ALLOW_STAGING_SEED=1: succeeds
    process.env.ALLOW_STAGING_SEED = "1";
    expect(() => assertSafeNonProductionDatabase(remoteStaging)).not.toThrow();
  });
});

describe("assertDatabaseServerIdentity", () => {
  const identityRow =
    (system_identifier: string | null, server_addr: string | null = "10.0.0.5") =>
    () => [{ system_identifier, server_addr, database: "matchday_staging" }];

  it("accepts a server whose system_identifier is allowlisted", async () => {
    await expect(
      assertDatabaseServerIdentity(fakeSql(identityRow(STAGING_ID)), new Set([STAGING_ID])),
    ).resolves.toMatchObject({ systemIdentifier: STAGING_ID });
  });

  it("refuses a tunnelled/other cluster whose system_identifier is not allowlisted", async () => {
    await expect(
      assertDatabaseServerIdentity(fakeSql(identityRow(OTHER_ID, "127.0.0.1")), new Set([STAGING_ID])),
    ).rejects.toThrow(/not in STAGING_DB_SYSTEM_IDENTIFIERS/);
  });

  it("fails closed when the allowlist is empty", async () => {
    await expect(assertDatabaseServerIdentity(fakeSql(identityRow(STAGING_ID)), new Set())).rejects.toThrow(
      /STAGING_DB_SYSTEM_IDENTIFIERS is empty/,
    );
  });

  it("refuses when the server reports the production address", async () => {
    await expect(
      assertDatabaseServerIdentity(fakeSql(identityRow(STAGING_ID, BLOCKED_PRODUCTION_IP)), new Set([STAGING_ID])),
    ).rejects.toThrow(/reports address 129.146.6.204/);
  });

  it("fails closed when the identity query errors or returns no identifier", async () => {
    const erroring = fakeSql(() => {
      throw new Error("permission denied for function pg_control_system");
    });
    await expect(assertDatabaseServerIdentity(erroring, new Set([STAGING_ID]))).rejects.toThrow(
      /Unable to read database server identity/,
    );
    await expect(assertDatabaseServerIdentity(fakeSql(identityRow(null)), new Set([STAGING_ID]))).rejects.toThrow(
      /did not report a system_identifier/,
    );
  });

  it("parses the allowlist from env, ignoring non-numeric entries", () => {
    expect([...parseStagingSystemIdentifierAllowlist(` ${STAGING_ID}, ,abc,${OTHER_ID}`)]).toEqual([
      STAGING_ID,
      OTHER_ID,
    ]);
    expect(parseStagingSystemIdentifierAllowlist(undefined).size).toBe(0);
  });
});

describe("assertDatabaseStagingMarker", () => {
  it("rejects a database without a marker and never creates one", async () => {
    const executed: string[] = [];
    const sql = fakeSql((q) => {
      if (q.includes("information_schema.tables")) return [{ exists: false }];
      if (q.includes("current_database")) return [{ current_database: "test_db" }];
      return [];
    }, executed);

    await expect(assertDatabaseStagingMarker(sql, STAGING_ID)).rejects.toThrow(
      /lacks a verified 'this is staging' marker in table 'staging_environment_markers'.*never creates/,
    );
    expect(executed.some((q) => /CREATE TABLE|INSERT INTO/i.test(q))).toBe(false);
  });

  it("ignores INIT_STAGING_MARKER / --init-staging-marker (removed path)", async () => {
    process.env.INIT_STAGING_MARKER = "1";
    process.argv.push("--init-staging-marker");
    const executed: string[] = [];
    try {
      const sql = fakeSql((q) => {
        if (q.includes("information_schema.tables")) return [{ exists: false }];
        if (q.includes("current_database")) return [{ current_database: "test_db" }];
        return [];
      }, executed);
      await expect(assertDatabaseStagingMarker(sql, STAGING_ID)).rejects.toThrow(/lacks a verified/);
      expect(executed.some((q) => /CREATE TABLE|INSERT INTO/i.test(q))).toBe(false);
    } finally {
      delete process.env.INIT_STAGING_MARKER;
      process.argv.splice(process.argv.indexOf("--init-staging-marker"), 1);
    }
  });

  it("accepts a marker bound to the connected server's system_identifier", async () => {
    const sql = fakeSql((q) => {
      if (q.includes("information_schema.tables")) return [{ exists: true }];
      if (q.includes("staging_environment_markers"))
        return [{ is_staging: true, environment: "staging", system_identifier: STAGING_ID }];
      return [];
    });
    await expect(assertDatabaseStagingMarker(sql, STAGING_ID)).resolves.toBeUndefined();
  });

  it("rejects a marker bound to a different cluster (e.g. restored dump)", async () => {
    const sql = fakeSql((q) => {
      if (q.includes("information_schema.tables")) return [{ exists: true }];
      if (q.includes("staging_environment_markers"))
        return [{ is_staging: true, environment: "staging", system_identifier: OTHER_ID }];
      return [];
    });
    await expect(assertDatabaseStagingMarker(sql, STAGING_ID)).rejects.toThrow(/bound to system_identifier/);
  });

  it("rejects a marker row that is not marked as staging", async () => {
    const sql = fakeSql((q) => {
      if (q.includes("information_schema.tables")) return [{ exists: true }];
      if (q.includes("staging_environment_markers"))
        return [{ is_staging: false, environment: "production", system_identifier: STAGING_ID }];
      return [];
    });
    await expect(assertDatabaseStagingMarker(sql, STAGING_ID)).rejects.toThrow(/not marked as staging/);
  });
});

describe("markStagingDatabase (operator step)", () => {
  it("refuses production URLs before connecting", async () => {
    const confirm = vi.fn();
    await expect(
      markStagingDatabase({
        databaseUrl: `postgres://u:p@${BLOCKED_PRODUCTION_IP}:5432/matchday`,
        confirm,
        log: () => undefined,
      }),
    ).rejects.toThrow(/blocked production IP/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refuses when APP_ENV is production", async () => {
    process.env.APP_ENV = "production";
    try {
      await expect(
        markStagingDatabase({
          databaseUrl: "postgres://u:p@127.0.0.1:5432/matchday_staging",
          confirm: vi.fn(),
          log: () => undefined,
        }),
      ).rejects.toThrow(/production environment/);
    } finally {
      delete process.env.APP_ENV;
    }
  });
});
