import os from "node:os";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  assertSafeNonProductionDatabase,
  assertDatabaseStagingMarker,
  BLOCKED_PRODUCTION_IP,
} from "../../scripts/seed-staging-production-replica.js";

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

  it("strictly blocks execution if local network interfaces match production IP 129.146.6.204", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [
        {
          address: "129.146.6.204",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "129.146.6.204/24",
        },
      ],
    });

    expect(() =>
      assertSafeNonProductionDatabase("postgres://matchday:matchday@127.0.0.1:5432/matchday_staging"),
    ).toThrow(/Host network interface "eth0" has production IP 129.146.6.204/);
  });

  it("strictly blocks execution if SSH session involves production IP 129.146.6.204", () => {
    process.env.SSH_CONNECTION = "129.146.6.204 54321 10.0.0.1 22";
    expect(() =>
      assertSafeNonProductionDatabase("postgres://matchday:matchday@127.0.0.1:5432/matchday_staging"),
    ).toThrow(/Active SSH session contains production IP 129.146.6.204/);

    delete process.env.SSH_CONNECTION;
    process.env.SSH_CLIENT = "10.0.0.1 54321 129.146.6.204";
    expect(() =>
      assertSafeNonProductionDatabase("postgres://matchday:matchday@127.0.0.1:5432/matchday_staging"),
    ).toThrow(/Active SSH session contains production IP 129.146.6.204/);
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

describe("assertDatabaseStagingMarker", () => {
  it("rejects database without staging marker when allowMarkerInit is false", async () => {
    const fakeSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const q = strings.join(" ");
      if (q.includes("information_schema.tables")) {
        return Promise.resolve([{ exists: false }]);
      }
      if (q.includes("current_setting")) {
        return Promise.resolve([{ env: null }]);
      }
      if (q.includes("current_database")) {
        return Promise.resolve([{ current_database: "test_db" }]);
      }
      return Promise.resolve([]);
    });

    await expect(
      assertDatabaseStagingMarker(fakeSql as unknown as Parameters<typeof assertDatabaseStagingMarker>[0], false),
    ).rejects.toThrow(/lacks a verified 'this is staging' marker in table 'staging_environment_markers'/);
  });

  it("accepts database when staging marker table exists and has is_staging = true", async () => {
    const fakeSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const q = strings.join(" ");
      if (q.includes("information_schema.tables")) {
        return Promise.resolve([{ exists: true }]);
      }
      if (q.includes("staging_environment_markers")) {
        return Promise.resolve([{ is_staging: true, environment: "staging" }]);
      }
      return Promise.resolve([]);
    });

    await expect(
      assertDatabaseStagingMarker(fakeSql as unknown as Parameters<typeof assertDatabaseStagingMarker>[0], false),
    ).resolves.toBeUndefined();
  });

  it("initializes staging marker table when allowMarkerInit is true", async () => {
    const executedQueries: string[] = [];
    const fakeSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const q = strings.join(" ");
      executedQueries.push(q);
      if (q.includes("information_schema.tables")) {
        return Promise.resolve([{ exists: false }]);
      }
      if (q.includes("current_setting")) {
        return Promise.resolve([{ env: null }]);
      }
      return Promise.resolve([]);
    });

    await expect(
      assertDatabaseStagingMarker(fakeSql as unknown as Parameters<typeof assertDatabaseStagingMarker>[0], true),
    ).resolves.toBeUndefined();
    expect(executedQueries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS staging_environment_markers"))).toBe(
      true,
    );
  });
});
