import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { ProductionAdminRuntime } from "../../src/production-admin-runtime.js";

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
});
