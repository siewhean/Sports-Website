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

  it("ADM-003: updates organisation entitlements and tops up AI units", async () => {
    const executedQueries: string[] = [];
    const mockSql = {
      unsafe: (async (query: string) => {
        executedQueries.push(query);
        if (query.includes("account_platform_roles")) {
          return [{ role: "platform_admin" }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new AdminRuntime(mockSql);
    const result = await runtime.updateEntitlements(
      adminActor,
      "org-1",
      { tier: "organiser_pro", topUpAiUnits: 50, reason: "Customer requested upgrade" },
      "req-1",
    );

    expect(result.success).toBe(true);
    expect(result.added_ai_units).toBe(50);
    expect(executedQueries.some((q) => q.includes("INSERT INTO organisation_subscriptions"))).toBe(true);
    expect(executedQueries.some((q) => q.includes("INSERT INTO entitlement_grants"))).toBe(true);
  });

  it("ADM-004: manages scoring access passes (revoke and reset) with exact schema columns", async () => {
    const executedQueries: string[] = [];
    const mockSql = {
      unsafe: (async (query: string) => {
        executedQueries.push(query);
        if (query.includes("account_platform_roles")) {
          return [{ role: "platform_admin" }];
        }
        if (query.includes("FROM scoring_access_passes")) {
          return [{ id: "pass-1", competition_id: "comp-1", revoked_at: null }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new AdminRuntime(mockSql);
    const revoked = await runtime.revokeAccessPass(adminActor, "pass-1", "Lost referee phone");
    expect(revoked.status).toBe("revoked");
    expect(revoked.pass_id).toBe("pass-1");
    expect(revoked.revocation_reason).toBe("Lost referee phone");
    expect(executedQueries.some((q) => q.includes("SET revoked_at=now()") && q.includes("revocation_reason=$3"))).toBe(
      true,
    );

    const reset = await runtime.resetAccessPass(adminActor, "pass-1");
    expect(reset.status).toBe("active");
    expect(reset.pass_id).toBe("pass-1");
    expect(reset.expires_at).toBeDefined();
    expect(executedQueries.some((q) => q.includes("SET revoked_at=NULL") && q.includes("revocation_reason=NULL"))).toBe(
      true,
    );
  });

  it("ADM-004: rejects pass operations from non-platform admin actors", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("account_platform_roles")) {
          return [];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new AdminRuntime(mockSql);
    const nonAdminActor = { accountId: "regular-user-id" };

    await expect(runtime.revokeAccessPass(nonAdminActor, "pass-1", "Unauthorized revoke")).rejects.toThrow(
      /Platform administrator privileges required/,
    );
    await expect(runtime.resetAccessPass(nonAdminActor, "pass-1")).rejects.toThrow(
      /Platform administrator privileges required/,
    );
  });

  it("ADM-004: rejects pass operations when pass does not exist", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("account_platform_roles")) {
          return [{ role: "platform_admin" }];
        }
        if (query.includes("FROM scoring_access_passes")) {
          return [];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new AdminRuntime(mockSql);

    await expect(runtime.revokeAccessPass(adminActor, "nonexistent-pass", "Lost device")).rejects.toThrow(
      /Scoring access pass not found/,
    );
    await expect(runtime.resetAccessPass(adminActor, "nonexistent-pass")).rejects.toThrow(
      /Scoring access pass not found/,
    );
  });

  it("ADM-005: manages sport default configuration versions with active status and text versions", async () => {
    const executedQueries: string[] = [];
    const mockSql = {
      unsafe: (async (query: string) => {
        executedQueries.push(query);
        if (query.includes("account_platform_roles")) {
          return [{ role: "platform_admin" }];
        }
        if (query.includes("SELECT version FROM sport_pack_versions WHERE sport_code=$1")) {
          return [{ version: "2" }];
        }
        if (query.includes("SELECT version FROM sport_pack_versions WHERE sport_code=$1 AND status='active'")) {
          return [{ version: "2" }];
        }
        if (query.includes("SELECT sport_code, version, definition FROM sport_pack_versions")) {
          return [{ sport_code: "basketball", version: "2", definition: { slotMinutes: 20 } }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new AdminRuntime(mockSql);
    const current = await runtime.getSportDefaults(adminActor, "basketball");
    expect(current.version).toBe("2");

    const updated = await runtime.updateSportDefaults(adminActor, "basketball", { slotMinutes: 25 });
    expect(updated.version).toBe("3");
    expect(updated.status).toBe("active");
    expect(
      executedQueries.some(
        (q) =>
          q.includes("UPDATE sport_pack_versions") &&
          q.includes("SET status='superseded'") &&
          q.includes("revision=revision+1"),
      ),
    ).toBe(true);
    expect(executedQueries.some((q) => q.includes("INSERT INTO sport_pack_versions") && q.includes("'active'"))).toBe(
      true,
    );
  });

  it("ADM-006 / ADM-007: aggregates AI usage accounting & cost monitoring", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("account_platform_roles")) {
          return [{ role: "platform_admin" }];
        }
        if (query.includes("SELECT\n           count(*)::integer as total_requests")) {
          return [
            {
              total_requests: 100,
              cache_hits: 25,
              total_prompt_tokens: 50000,
              total_completion_tokens: 15000,
              total_cost_usd: "0.125",
              avg_latency_ms: 320,
            },
          ];
        }
        if (query.includes("GROUP BY action")) {
          return [
            {
              action: "text_to_brief",
              request_count: 60,
              total_tokens: 40000,
              total_cost_usd: "0.080",
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;
    const runtime = new AdminRuntime(mockSql);
    const result = await runtime.getAiAccountingSummary(adminActor);

    expect(result.total_requests).toBe(100);
    expect(result.cache_hits).toBe(25);
    expect(result.cache_hit_rate).toBe(0.25);
    expect(result.total_cost_usd).toBe(0.125);
    expect(result.actions).toHaveLength(1);
  });
});
