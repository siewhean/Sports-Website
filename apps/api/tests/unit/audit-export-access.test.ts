import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { ExportRuntime } from "../../src/export-runtime.js";

type GrantState = "none" | "active" | "revoked" | "expired";

const actor = { accountId: "actor-1" };
const auditHeader = "Timestamp,Action,Actor ID,Actor Type,Target Type,Target ID";
const publicHeader = "Division,Stage,Match,Home Team,Away Team,Status,Court/Pitch,Scheduled Start";

const createRuntime = (published: boolean, member = false, platformGrant: GrantState = "none"): ExportRuntime => {
  const mockSql = {
    unsafe: (async (query: string) => {
      if (query.includes("FROM competitions")) {
        return [{ id: "c1", organisation_id: "org-1", status: published ? "published" : "draft" }];
      }
      if (query.includes("FROM competition_publications")) {
        return published ? [{ published_schedule_revision_id: "rev-pub-1", schedule_published_at: new Date(0) }] : [];
      }
      if (query.includes("FROM organisation_memberships")) {
        return member ? [{ role: "organiser" }] : [];
      }
      if (query.includes("FROM account_platform_roles")) {
        expect(query).toContain("revoked_at IS NULL");
        expect(query).toContain("expires_at IS NULL OR expires_at > now()");
        return platformGrant === "active" ? [{ role: "platform_admin" }] : [];
      }
      if (query.includes("FROM audit_events") || query.includes("FROM matches")) {
        return [];
      }
      return [];
    }) as PostgresJsSql["unsafe"],
  } as unknown as PostgresJsSql;

  return new ExportRuntime(mockSql);
};

const auditExport = (runtime: ExportRuntime) => runtime.generateAuditHistoryExport(actor, "c1");

describe("audit export access boundary", () => {
  it("allows members and active admins", async () => {
    await expect(auditExport(createRuntime(true, true))).resolves.toContain(auditHeader);
    await expect(auditExport(createRuntime(false, false, "active"))).resolves.toContain(auditHeader);
  });

  it("rejects unrelated authenticated users", async () => {
    await expect(auditExport(createRuntime(true))).rejects.toMatchObject({ statusCode: 403 });
    await expect(auditExport(createRuntime(false))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects inactive admin grants", async () => {
    await expect(auditExport(createRuntime(true, false, "revoked"))).rejects.toMatchObject({ statusCode: 403 });
    await expect(auditExport(createRuntime(true, false, "expired"))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("keeps published fixture exports public", async () => {
    await expect(createRuntime(true).generateCompetitionCsv("c1")).resolves.toContain(publicHeader);
  });
});
