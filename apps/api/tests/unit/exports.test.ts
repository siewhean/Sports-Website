import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { ExportRuntime } from "../../src/export-runtime.js";

describe("Exports Runtime (EXP-003, EXP-004)", () => {
  it("formats competition matches into valid CSV rows", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [{ id: "c1", name: "Summer Championship", sport_code: "basketball" }];
        }
        if (query.includes("FROM matches")) {
          return [
            {
              division_name: "Premier Division",
              stage_name: "Group Stage",
              match_code: "M01",
              home_name: "Red Dragons",
              away_name: "Blue Tigers",
              state: "completed",
              pitch_name: "Court 1",
              start_time: new Date("2026-08-25T10:00:00Z"),
            },
            {
              division_name: "Premier Division",
              stage_name: "Group Stage",
              match_code: "M02",
              home_name: 'Team "A"',
              away_name: "Team, B",
              state: "scheduled",
              pitch_name: null,
              start_time: null,
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new ExportRuntime(mockSql);
    const csv = await runtime.generateCompetitionCsv("c1");

    expect(csv).toContain("Division,Stage,Match,Home Team,Away Team,Status,Court/Pitch,Scheduled Start");
    expect(csv).toContain(
      "Premier Division,Group Stage,M01,Red Dragons,Blue Tigers,completed,Court 1,2026-08-25T10:00:00.000Z",
    );
    expect(csv).toContain('"Team ""A"""');
    expect(csv).toContain('"Team, B"');
  });

  it("formats competition into structured JSON export document", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [
            {
              id: "c1",
              name: "Summer Championship",
              sport_code: "basketball",
              status: "in_progress",
              created_at: new Date(),
            },
          ];
        }
        if (query.includes("FROM divisions")) {
          return [{ id: "d1", name: "Premier Division", sort_order: 1 }];
        }
        if (query.includes("FROM division_entries")) {
          return [{ id: "e1", division_id: "d1", name: "Red Dragons", seed: 1 }];
        }
        if (query.includes("FROM matches")) {
          return [
            {
              id: "m1",
              division_id: "d1",
              code: "M01",
              stage: "Main",
              home_entry_id: "e1",
              away_entry_id: null,
              state: "ready",
              scheduled_start: null,
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new ExportRuntime(mockSql);
    const json = await runtime.generateCompetitionJson("c1");

    expect(json.schema_version).toBe("1.0");
    expect(json.competition).toMatchObject({ id: "c1", name: "Summer Championship" });
    expect(Array.isArray(json.divisions)).toBe(true);
    const divisions = json.divisions as Array<{ entries: unknown[]; matches: unknown[] }>;
    expect(divisions[0]?.entries).toHaveLength(1);
    expect(divisions[0]?.matches).toHaveLength(1);
  });
});
