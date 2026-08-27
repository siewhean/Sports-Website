import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { ProductionAdminRuntime } from "../../src/production-admin-runtime.js";

type QueryCall = { query: string; params: readonly unknown[] | undefined };

function adminSql(calls: QueryCall[]): PostgresJsSql {
  const sql = {
    unsafe: (async (query: string, params?: readonly unknown[]) => {
      calls.push({ query, params });
      if (query.includes("account_platform_roles")) return [{ ok: 1 }];
      if (query.includes("SELECT id, competition_id, revoked_at FROM scoring_access_passes")) {
        return [{ id: "pass-1", competition_id: "competition-1", revoked_at: null }];
      }
      if (query.includes("SELECT id, competition_id FROM scoring_access_passes")) {
        return [{ id: "pass-1", competition_id: "competition-1" }];
      }
      if (query.includes("SELECT c.organisation_id")) return [{ organisation_id: "organisation-1" }];
      if (query.includes("SELECT version FROM sport_pack_versions") && !query.includes("status='active'")) {
        return [{ version: "1" }];
      }
      if (query.includes("status='active' FOR UPDATE")) return [{ version: "1" }];
      return [];
    }) as PostgresJsSql["unsafe"],
    begin: async <T>(callback: (tx: PostgresJsSql) => Promise<T>) => callback(sql as unknown as PostgresJsSql),
  };
  return sql as unknown as PostgresJsSql;
}

describe("ProductionAdminRuntime", () => {
  it("reads the append-only audit timestamp from occurred_at", async () => {
    const queries: string[] = [];
    const auditTime = new Date("2026-08-26T03:00:00.000Z");
    const sql = {
      unsafe: (async (query: string) => {
        queries.push(query);
        if (query.includes("account_platform_roles")) return [{ ok: 1 }];
        if (query.includes("FROM audit_events")) {
          return [
            {
              id: "audit-1",
              request_id: "req-1",
              actor_account_id: "account-1",
              actor_type: "platform_admin",
              organisation_id: null,
              action: "admin.lookup",
              target_type: "competition",
              target_id: "competition-1",
              metadata: {},
              created_at: auditTime,
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new ProductionAdminRuntime(sql);
    const events = await runtime.getAuditEvents({ accountId: "account-1" }, {});

    expect(queries.find((query) => query.includes("FROM audit_events"))).toContain("occurred_at AS created_at");
    expect(queries.find((query) => query.includes("FROM audit_events"))).toContain("ORDER BY occurred_at DESC");
    expect(events[0]?.created_at).toBe(auditTime.toISOString());
  });

  it("appends platform-admin audit evidence for access-pass revoke and reset", async () => {
    const calls: QueryCall[] = [];
    const runtime = new ProductionAdminRuntime(adminSql(calls));
    const actor = { accountId: "admin-1" };

    await runtime.revokeAccessPass(actor, "pass-1", "Compromised code");
    await runtime.resetAccessPass(actor, "pass-1");

    const auditCalls = calls.filter((call) => call.query.includes("INSERT INTO audit_events"));
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls[0]?.params).toEqual(
      expect.arrayContaining(["admin-1", "organisation-1", "admin.access_pass.revoked", "pass-1"]),
    );
    expect(auditCalls[1]?.params).toEqual(
      expect.arrayContaining(["admin-1", "organisation-1", "admin.access_pass.reset", "pass-1"]),
    );
  });

  it("appends platform-admin audit evidence for sport-default updates", async () => {
    const calls: QueryCall[] = [];
    const runtime = new ProductionAdminRuntime(adminSql(calls));

    const result = await runtime.updateSportDefaults({ accountId: "admin-1" }, "basketball", {
      schema_version: 1,
    });

    expect(result.version).toBe("2");
    const audit = calls.find(
      (call) =>
        call.query.includes("INSERT INTO audit_events") && call.params?.includes("admin.sport_defaults.updated"),
    );
    expect(audit?.params).toEqual(expect.arrayContaining(["admin-1", "admin.sport_defaults.updated", "basketball"]));
  });
});
