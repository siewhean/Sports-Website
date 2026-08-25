import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { ExportRuntime } from "../../src/export-runtime.js";

describe("Exports Runtime (EXP-003 through EXP-006)", () => {
  const adminActor = { accountId: "acc-1" };

  it("EXP-003: formats competition matches into valid CSV rows", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [{ id: "c1", organisation_id: "org-1", status: "in_progress" }];
        }
        if (query.includes("FROM published_schedules")) {
          return [{ id: "pub-1" }];
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

  it("EXP-004: exports standings and table CSV format", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [{ id: "c1", organisation_id: "org-1", status: "published" }];
        }
        if (query.includes("FROM published_schedules")) {
          return [{ id: "pub-1" }];
        }
        if (query.includes("FROM division_entries")) {
          return [
            {
              division_name: "Open Division",
              team_name: "Alpha Club",
              rank: 1,
              played: 3,
              won: 3,
              drawn: 0,
              lost: 0,
              goals_for: 10,
              goals_against: 2,
              goal_diff: 8,
              points: 9,
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new ExportRuntime(mockSql);
    const standingsCsv = await runtime.generateStandingsCsv("c1");

    expect(standingsCsv).toContain(
      "Division,Rank,Team,Played,Won,Drawn,Lost,Goals For,Goals Against,Goal Difference,Points",
    );
    expect(standingsCsv).toContain("Open Division,1,Alpha Club,3,3,0,0,10,2,8,9");
  });

  it("EXP-004: exports bracket structure CSV", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [{ id: "c1", organisation_id: "org-1", status: "published" }];
        }
        if (query.includes("FROM published_schedules")) {
          return [{ id: "pub-1" }];
        }
        if (query.includes("FROM matches")) {
          return [
            {
              division_name: "Championship",
              match_id: "GF1",
              stage: "Grand Final",
              home_name: "Phoenix",
              away_name: "Titans",
              state: "scheduled",
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new ExportRuntime(mockSql);
    const bracketCsv = await runtime.generateBracketCsv("c1");

    expect(bracketCsv).toContain("Division,Stage,Match,Home Team,Away Team,State");
    expect(bracketCsv).toContain("Championship,Grand Final,GF1,Phoenix,Titans,scheduled");
  });

  it("EXP-005: exports competition manager audit history", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [{ id: "c1", organisation_id: "org-1", status: "published" }];
        }
        if (query.includes("FROM organisation_memberships")) {
          return [{ role: "owner" }];
        }
        if (query.includes("FROM audit_events")) {
          return [
            {
              id: "ev-1",
              action: "format.published",
              actor_account_id: "acc-1",
              actor_type: "account",
              target_type: "competition",
              target_id: "c1",
              created_at: new Date("2026-08-25T12:00:00Z"),
            },
          ];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new ExportRuntime(mockSql);
    const auditCsv = await runtime.generateAuditHistoryExport(adminActor, "c1");

    expect(auditCsv).toContain("Timestamp,Action,Actor ID,Actor Type,Target Type,Target ID");
    expect(auditCsv).toContain("2026-08-25T12:00:00.000Z,format.published,acc-1,account,competition,c1");
  });

  it("Security Boundary: rejects unauthenticated export of unpublished competition", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [{ id: "c1", organisation_id: "org-1", status: "draft" }];
        }
        if (query.includes("FROM published_schedules")) {
          return []; // unpublished!
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new ExportRuntime(mockSql);
    await expect(runtime.generateCompetitionCsv("c1")).rejects.toThrow(
      /Unpublished competition schedule cannot be exported/,
    );
  });

  it("EXP-006: generates full competition JSON archive and validates round-trip equivalence", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [
            {
              id: "c1",
              name: "Summer Championship",
              sport_code: "basketball",
              status: "in_progress",
              created_at: new Date("2026-08-01T00:00:00Z"),
              organisation_id: "org-1",
            },
          ];
        }
        if (query.includes("FROM published_schedules")) {
          return [{ id: "pub-1" }];
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
        if (query.includes("FROM competition_branding")) {
          return [
            {
              primary_color: "#112233",
              secondary_color: "#445566",
              logo_url: null,
              banner_url: null,
              hide_platform_badge: false,
            },
          ];
        }
        if (query.includes("FROM competition_sponsors")) {
          return [{ name: "Local Gym", tier: "headline", logo_url: null, website_url: null, sort_order: 1 }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new ExportRuntime(mockSql);
    const archive = await runtime.generateCompetitionJson("c1");

    expect(archive.schema_version).toBe("1.0");
    expect(archive.competition).toMatchObject({ id: "c1", name: "Summer Championship" });
    expect(Array.isArray(archive.divisions)).toBe(true);

    const validation = runtime.validateCompetitionArchive(archive);
    expect(validation.valid).toBe(true);
    expect(validation.competition?.name).toBe("Summer Championship");
    expect(validation.divisionsCount).toBe(1);
    expect(validation.entriesCount).toBe(1);
    expect(validation.matchesCount).toBe(1);
  });
});
