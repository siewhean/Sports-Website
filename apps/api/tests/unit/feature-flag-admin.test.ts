import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { AdminRuntime } from "../../src/admin-runtime.js";

describe("OPS-018: Feature Flag Administration (Unit / Access Control)", () => {
  const adminActor = { accountId: "admin-uuid-1" };
  const normalActor = { accountId: "normal-uuid-2" };

  function createMockSql(isAdmin: boolean = false, extraRows?: { exists?: boolean; audit?: unknown[] }) {
    const executedQueries: { query: string; params?: readonly unknown[] }[] = [];
    let storedOverride: {
      id: string;
      key: string;
      scope_type: string;
      scope_id: string | null;
      enabled: boolean;
      reason: string;
      updated_by: string;
      updated_at: string;
    } | null = null;

    const mockSql = {
      unsafe: (async (query: string, params?: readonly unknown[]) => {
        if (params !== undefined) {
          executedQueries.push({ query, params });
        } else {
          executedQueries.push({ query });
        }

        if (query.includes("account_platform_roles")) {
          return isAdmin ? [{ role: "platform_admin" }] : [];
        }

        if (query.includes("FROM organisations WHERE id =")) {
          return extraRows?.exists ? [{ id: params?.[0] }] : [];
        }

        if (query.includes("FROM competitions WHERE id =")) {
          return extraRows?.exists ? [{ id: params?.[0] }] : [];
        }

        if (query.includes("FROM accounts WHERE id =")) {
          return extraRows?.exists ? [{ id: params?.[0] }] : [];
        }

        if (query.includes("pg_advisory_xact_lock")) {
          return [{ ok: 1 }];
        }

        if (query.includes("INSERT INTO feature_flag_overrides") && query.includes("RETURNING")) {
          storedOverride = {
            id: "override-uuid-1",
            key: String(params?.[0]),
            scope_type: String(params?.[1]),
            scope_id: params?.[2] ? String(params?.[2]) : null,
            enabled: Boolean(params?.[3]),
            reason: String(params?.[4]),
            updated_by: String(params?.[5]),
            updated_at: "2026-10-07T00:00:00.000Z",
          };
          return [storedOverride];
        }

        if (query.includes("FROM feature_flag_overrides")) {
          return storedOverride ? [storedOverride] : [];
        }

        if (query.includes("FROM audit_events")) {
          return extraRows?.audit ?? [];
        }

        return [];
      }) as PostgresJsSql["unsafe"],
      begin: async <T>(callback: (tx: PostgresJsSql) => Promise<T>) => callback(mockSql as unknown as PostgresJsSql),
    } as unknown as PostgresJsSql;

    return { mockSql, executedQueries };
  }

  // --- Checkpoint F7: Access Control ---
  describe("Checkpoint F7: Access Control & Authorization", () => {
    it("denies access to non-platform-admin users", async () => {
      const { mockSql } = createMockSql(false);
      const runtime = new AdminRuntime(mockSql);

      await expect(runtime.listFeatureFlags(normalActor)).rejects.toThrow("Platform administrator privileges required");
      await expect(runtime.getFeatureFlag(normalActor, "maintenance.global")).rejects.toThrow(
        "Platform administrator privileges required",
      );
      await expect(
        runtime.setFeatureFlagOverride(
          normalActor,
          "maintenance.global",
          {
            scope: { kind: "global" },
            value: true,
            reason: "emergency maintenance",
          },
          "req-1",
        ),
      ).rejects.toThrow("Platform administrator privileges required");
      await expect(
        runtime.deleteFeatureFlagOverride(
          normalActor,
          "maintenance.global",
          {
            scope: { kind: "global" },
            reason: "maintenance completed",
          },
          "req-2",
        ),
      ).rejects.toThrow("Platform administrator privileges required");
    });

    it("allows authorized platform admins to inspect flags", async () => {
      const { mockSql } = createMockSql(true);
      const runtime = new AdminRuntime(mockSql);

      const result = await runtime.listFeatureFlags(adminActor);
      expect(result.flags).toBeInstanceOf(Array);
      expect(result.flags.length).toBeGreaterThan(0);
      expect(result.flags.some((f) => f.key === "maintenance.global")).toBe(true);
    });

    it("prevents cross-scope abuse when scoped target entity does not exist", async () => {
      const { mockSql } = createMockSql(true, { exists: false });
      const runtime = new AdminRuntime(mockSql);

      await expect(
        runtime.setFeatureFlagOverride(
          adminActor,
          "maintenance.global",
          {
            scope: { kind: "organization", id: "00000000-0000-0000-0000-000000000099" },
            value: true,
            reason: "org testing",
          },
          "req-test",
        ),
      ).rejects.toThrow("Organisation 00000000-0000-0000-0000-000000000099 does not exist");
    });

    it("allows valid target scope entity mutation when entity exists", async () => {
      const { mockSql } = createMockSql(true, { exists: true });
      const runtime = new AdminRuntime(mockSql);

      const result = await runtime.setFeatureFlagOverride(
        adminActor,
        "maintenance.global",
        {
          scope: { kind: "organization", id: "00000000-0000-0000-0000-000000000001" },
          value: true,
          reason: "org maintenance override",
        },
        "req-ok",
      );

      expect(result.success).toBe(true);
    });
  });

  // --- Checkpoint F8: Validation & Safe Defaults ---
  describe("Checkpoint F8: Flag Validation & Safe Defaults", () => {
    it("rejects unknown flag keys", async () => {
      const { mockSql } = createMockSql(true);
      const runtime = new AdminRuntime(mockSql);

      await expect(
        runtime.setFeatureFlagOverride(
          adminActor,
          "unknown.flag.nonexistent" as unknown as "maintenance.global",
          {
            scope: { kind: "global" },
            value: true,
            reason: "trying invalid flag",
          },
          "req-val-1",
        ),
      ).rejects.toThrow("Feature flag unknown.flag.nonexistent not found in registry");
    });

    it("rejects invalid non-boolean value types for boolean flags", async () => {
      const { mockSql } = createMockSql(true);
      const runtime = new AdminRuntime(mockSql);

      await expect(
        runtime.setFeatureFlagOverride(
          adminActor,
          "maintenance.global",
          {
            scope: { kind: "global" },
            value: "yes" as unknown as boolean,
            reason: "invalid value type",
          },
          "req-val-2",
        ),
      ).rejects.toThrow("Invalid value for feature flag maintenance.global");
    });

    it("rejects empty reason string", async () => {
      const { mockSql } = createMockSql(true);
      const runtime = new AdminRuntime(mockSql);

      await expect(
        runtime.setFeatureFlagOverride(
          adminActor,
          "maintenance.global",
          {
            scope: { kind: "global" },
            value: true,
            reason: "  ",
          },
          "req-val-3",
        ),
      ).rejects.toThrow("A non-empty reason of at least 3 characters is required");
    });

    it("returns typed registry safe default when no override exists", async () => {
      const { mockSql } = createMockSql(true);
      const runtime = new AdminRuntime(mockSql);

      const effective = await runtime.getEffectiveFeatureFlag(adminActor, "maintenance.global", {});
      expect(effective.key).toBe("maintenance.global");
      expect(effective.effective_value).toBe(false);
      expect(effective.source).toBe("default");
    });
  });

  // --- Checkpoint F9: Concurrency Control ---
  describe("Checkpoint F9: Optimistic Concurrency Control", () => {
    it("enforces expected_updated_at concurrency check", async () => {
      const { mockSql } = createMockSql(true);
      const runtime = new AdminRuntime(mockSql);

      // Set initial override
      const firstSet = await runtime.setFeatureFlagOverride(
        adminActor,
        "maintenance.global",
        {
          scope: { kind: "global" },
          value: true,
          reason: "initial override setup",
        },
        "req-conc-1",
      );

      expect(firstSet.success).toBe(true);

      // Attempt mutation with stale timestamp
      await expect(
        runtime.setFeatureFlagOverride(
          adminActor,
          "maintenance.global",
          {
            scope: { kind: "global" },
            value: false,
            reason: "stale mutation attempt",
            expected_updated_at: "2020-01-01T00:00:00.000Z",
          },
          "req-conc-2",
        ),
      ).rejects.toThrow();

      // Mutation without stale check succeeds
      const secondSet = await runtime.setFeatureFlagOverride(
        adminActor,
        "maintenance.global",
        {
          scope: { kind: "global" },
          value: false,
          reason: "valid updated mutation",
        },
        "req-conc-3",
      );

      expect(secondSet.success).toBe(true);
    });
  });

  // --- Checkpoint F10: Audit History Retention ---
  describe("Checkpoint F10: Audit History Retention", () => {
    it("fetches audit records for a feature flag", async () => {
      const auditRecord = {
        id: "audit-evt-1",
        request_id: "req-audit-1",
        actor_account_id: adminActor.accountId,
        actor_type: "platform_admin",
        organisation_id: null,
        action: "feature_flag.override_set",
        target_type: "feature_flag",
        target_id: "maintenance.global:global",
        reason: "scheduled system downtime",
        before_state: null,
        after_state: { value: true },
        metadata: { flag_key: "maintenance.global" },
        created_at: new Date("2026-10-07T00:00:00.000Z"),
      };

      const { mockSql } = createMockSql(true, { audit: [auditRecord] });
      const runtime = new AdminRuntime(mockSql);

      const history = await runtime.getFeatureFlagAudit(adminActor, "maintenance.global");
      expect(history.flag_key).toBe("maintenance.global");
      expect(history.events).toHaveLength(1);
      expect(history.events[0]?.action).toBe("feature_flag.override_set");
      expect(history.events[0]?.reason).toBe("scheduled system downtime");
      expect(history.events[0]?.target_id).toBe("maintenance.global:global");
    });
  });
});
