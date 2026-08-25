import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { AdminRuntime } from "../../src/admin-runtime.js";

describe("Admin & Support Tooling (ADM-001 through ADM-007)", () => {
  const adminActor = { accountId: "acc-1" };
  const organiserActor = { accountId: "acc-2" };

  it("ADM-001: enforces platform_admin role restriction", async () => {
    const mockSql = {
      unsafe: (async (query: string, params?: unknown[]) => {
        if (query.includes("account_platform_roles")) {
          return params && params[0] === "acc-1" ? [{ role: "platform_admin" }] : [];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    const runtime = new AdminRuntime(mockSql);

    await expect(runtime.assertPlatformAdmin(organiserActor)).rejects.toThrow();
    await expect(runtime.assertPlatformAdmin(adminActor)).resolves.toBeUndefined();
  });

  it("ADM-002: lists organisations with subscription and competition metrics", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("account_platform_roles")) {
          return [{ role: "platform_admin" }];
        }
        return [
          {
            id: "org-1",
            name: "National League",
            created_at: new Date("2026-08-01T00:00:00Z"),
            tier: "organiser_pro",
            sub_status: "active",
            competition_count: 5,
            member_count: 12,
          },
        ];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    const runtime = new AdminRuntime(mockSql);
    const result = await runtime.listOrganisations(adminActor);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "org-1",
      name: "National League",
      tier: "organiser_pro",
      competition_count: 5,
      member_count: 12,
    });
  });

  it("ADM-004 / ADM-005: aggregates AI usage accounting & cost monitoring", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("account_platform_roles")) {
          return [{ role: "platform_admin" }];
        }
        if (query.includes("sum(estimated_cost_usd)")) {
          return [
            {
              total_requests: 100,
              cache_hits: 20,
              total_prompt_tokens: 50000,
              total_completion_tokens: 10000,
              total_cost_usd: "0.250000",
              avg_latency_ms: 120,
            },
          ];
        }
        if (query.includes("GROUP BY action")) {
          return [
            {
              action: "text_to_brief",
              request_count: 70,
              total_tokens: 42000,
              total_cost_usd: "0.175000",
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    const runtime = new AdminRuntime(mockSql);
    const summary = await runtime.getAiAccountingSummary(adminActor);

    expect(summary.total_requests).toBe(100);
    expect(summary.cache_hit_rate).toBe(0.2);
    expect(summary.total_tokens).toBe(60000);
    expect(summary.total_cost_usd).toBe(0.25);
    expect(summary.actions).toHaveLength(1);
  });
});
