import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { assertSafeNonProductionDatabase } from "../../scripts/seed-staging-production-replica.js";

describe("assertSafeNonProductionDatabase", () => {
  const originalAppEnv = process.env.APP_ENV;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowStaging = process.env.ALLOW_STAGING_SEED;

  beforeEach(() => {
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;
    delete process.env.ALLOW_STAGING_SEED;
  });

  afterEach(() => {
    if (originalAppEnv !== undefined) process.env.APP_ENV = originalAppEnv;
    else delete process.env.APP_ENV;

    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;

    if (originalAllowStaging !== undefined) process.env.ALLOW_STAGING_SEED = originalAllowStaging;
    else delete process.env.ALLOW_STAGING_SEED;
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
