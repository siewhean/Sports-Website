import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { PublishedExportRuntime } from "../../src/published-export-runtime.js";

describe("PublishedExportRuntime", () => {
  it("projects unauthenticated CSV from the exact published schedule and result cutoff", async () => {
    const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const resultsPublishedAt = new Date("2026-08-25T12:00:00.000Z");
    const mockSql = {
      unsafe: (async (sql: string, params?: readonly unknown[]) => {
        queries.push(params !== undefined ? { sql, params } : { sql });
        if (sql.includes("FROM competitions c")) {
          return [
            {
              status: "published",
              published_schedule_revision_id: "00000000-0000-4000-8000-000000000001",
              schedule_published_at: new Date("2026-08-25T10:00:00.000Z"),
              results_published_at: resultsPublishedAt,
              format_revision_id: "00000000-0000-4000-8000-000000000002",
            },
          ];
        }
        if (sql.includes("FROM scheduled_matches sm")) {
          return [
            {
              division_name: "Open",
              stage_name: "Final",
              match_code: "GF1",
              home_name: "Alpha",
              away_name: "Beta",
              state: "final",
              pitch_name: "Court 1",
              start_time: new Date("2026-08-25T11:00:00.000Z"),
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new PublishedExportRuntime(mockSql);
    const csv = await runtime.generateCompetitionCsv("00000000-0000-4000-8000-000000000003");

    expect(csv).toContain("Open,Final,GF1,Alpha,Beta,final,Court 1,2026-08-25T11:00:00.000Z");
    const projectionQuery = queries.find((entry) => entry.sql.includes("FROM scheduled_matches sm"));
    expect(projectionQuery?.sql).toContain("sm.schedule_revision_id=$2");
    expect(projectionQuery?.sql).toContain("m.format_revision_id=$3");
    expect(projectionQuery?.sql).toContain("snapshot.created_at <= $4");
    expect(projectionQuery?.params).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      resultsPublishedAt,
    ]);
  });

  it("fails closed when there is no current published schedule", async () => {
    const mockSql = {
      unsafe: (async (sql: string) => {
        if (sql.includes("FROM competitions c")) {
          return [
            {
              status: "draft",
              published_schedule_revision_id: null,
              schedule_published_at: null,
              results_published_at: null,
              format_revision_id: null,
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new PublishedExportRuntime(mockSql);
    await expect(runtime.generateCompetitionCsv("00000000-0000-4000-8000-000000000003")).rejects.toThrow(
      /no published schedule export/i,
    );
  });
});
