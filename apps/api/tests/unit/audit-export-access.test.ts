import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { ExportRuntime } from "../../src/export-runtime.js";

type GrantState = "none" | "active" | "revoked" | "expired";

const auditHeader = "Timestamp,Action,Actor ID,Actor Type,Target Type,Target ID";
const publicHeader = "Division,Stage,Match,Home Team,Away Team,Status,Court/Pitch,Scheduled Start";

const createRuntime = ({
  published,
  member = false,
  platformGrant = "none",
}: {
  published: boolean;
  member?: boolean;
  platformGrant?: GrantState;
}): ExportRuntime => {
  const mockSql = {
    unsafe: (async (query: string) => {
      if (query.includes("FROM competitions")) {
        return [
          {
            id: "c1",
            organisation_id: "org-1",
            status: published ? "published" : "draft",
          },
        ];
      }
      if (query.includes("FROM competition_publications")) {
        return published
          ? [
              {
                published_schedule_revision_id: "rev-pub-1",
                schedule_published_at: new Date("2026-08-30T00:00:00Z"),
              },
            ]
          : [];
      }
      if (query.includes("FROM organisation_memberships")) {
        return member ? [{ role: "organiser" }] : [];
      }
      if (query.includes("FROM account_platform_roles")) {
        const checksLifecycle =
          query.includes("revoked_at IS NULL") && query.includes("expires_at IS NULL OR expires_at > now()");
        return platformGrant === "active" && checksLifecycle ? [{ role: "platform_admin" }] : [];
      }
      if (query.includes("FROM audit_events") || query.includes("FROM matches")) {
        return [];
      }
      return [];
    }) as PostgresJsSql["unsafe"],
  } as unknown as PostgresJsSql;

  return new ExportRuntime(mockSql);
};

describe("audit export access boundary", () => {
  const actor = { accountId: "actor-1" };

  it("allows members and active admins", async () => {
    const memberRuntime = createRuntime({ published: true, member: true });
    await expect(
      memberRuntime.generateAuditHistoryExport(actor, "c1"),
    ).resolves.toContain(auditHeader);

    const adminRuntime = createRuntime({
      published: false,
      platformGrant: "active",
    });
    await expect(
      adminRuntime.generateAuditHistoryExport(actor, "c1"),
    ).resolves.toContain(auditHeader);
  });

  it("rejects unrelated authenticated users", async () => {
    await expect(
      createRuntime({ published: true }).generateAuditHistoryExport(actor, "c1"),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      createRuntime({ published: false }).generateAuditHistoryExport(actor, "c1"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects inactive admin grants", async () => {
    await expect(
      createRuntime({
        published: true,
        platformGrant: "revoked",
      }).generateAuditHistoryExport(actor, "c1"),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      createRuntime({
        published: true,
        platformGrant: "expired",
      }).generateAuditHistoryExport(actor, "c1"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("keeps published fixture exports public", async () => {
    await expect(
      createRuntime({ published: true }).generateCompetitionCsv("c1"),
    ).resolves.toContain(publicHeader);
  });
});
