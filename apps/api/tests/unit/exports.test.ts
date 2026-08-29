import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { ExportRuntime } from "../../src/export-runtime.js";

describe("Exports Runtime (EXP-003 through EXP-006)", () => {
  const adminActor = { accountId: "acc-1" };

  it("EXP-003: formats competition matches into valid CSV rows for published schedule", async () => {
    const executedQueries: string[] = [];
    const mockSql = {
      unsafe: (async (query: string) => {
        executedQueries.push(query);
        if (query.includes("FROM competitions")) {
          return [{ id: "c1", organisation_id: "org-1", status: "published" }];
        }
        if (query.includes("FROM competition_publications")) {
          return [{ published_schedule_revision_id: "rev-pub-1", schedule_published_at: new Date() }];
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

  it("EXP-004: exports standings and table CSV format strictly from published matches", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [{ id: "c1", organisation_id: "org-1", status: "published" }];
        }
        if (query.includes("FROM competition_publications")) {
          return [{ published_schedule_revision_id: "rev-pub-1", schedule_published_at: new Date() }];
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
        if (query.includes("FROM competition_publications")) {
          return [{ published_schedule_revision_id: "rev-pub-1", schedule_published_at: new Date() }];
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

  it("EXP-005: exports competition manager audit history strictly scoped to competition", async () => {
    const executedQueries: string[] = [];
    const mockSql = {
      unsafe: (async (query: string) => {
        executedQueries.push(query);
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
              occurred_at: new Date("2026-08-25T12:00:00Z"),
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
    expect(executedQueries.some((q) => q.includes("target_id = $1") && q.includes("organisation_id = $2"))).toBe(true);
  });

  it("Security Boundary: rejects unauthenticated export of unpublished competition", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM competitions")) {
          return [{ id: "c1", organisation_id: "org-1", status: "draft" }];
        }
        if (query.includes("FROM competition_publications")) {
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

  it("allows an active platform administrator, but rejects revoked and expired grants, for unpublished exports", async () => {
    const platformActor = { accountId: "platform-admin" };
    const createRuntime = (grant: "active" | "revoked" | "expired") => {
      const mockSql = {
        unsafe: (async (query: string) => {
          if (query.includes("FROM competitions")) return [{ id: "c1", organisation_id: "org-1", status: "draft" }];
          if (query.includes("FROM competition_publications")) return [];
          if (query.includes("FROM organisation_memberships")) return [];
          if (query.includes("FROM account_platform_roles")) {
            const activeGrantPredicate =
              query.includes("revoked_at IS NULL") && query.includes("expires_at IS NULL OR expires_at > now()");
            return grant === "active" && activeGrantPredicate ? [{ role: "platform_admin" }] : [];
          }
          if (query.includes("FROM matches")) return [];
          return [];
        }) as PostgresJsSql["unsafe"],
      } as unknown as PostgresJsSql;
      return new ExportRuntime(mockSql);
    };

    await expect(createRuntime("active").generateCompetitionCsv("c1", platformActor)).resolves.toContain(
      "Division,Stage",
    );
    await expect(createRuntime("revoked").generateCompetitionCsv("c1", platformActor)).rejects.toThrow(
      /Access denied to unpublished competition/,
    );
    await expect(createRuntime("expired").generateCompetitionCsv("c1", platformActor)).rejects.toThrow(
      /Access denied to unpublished competition/,
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
              status: "published",
              created_at: new Date("2026-08-01T00:00:00Z"),
              organisation_id: "org-1",
            },
          ];
        }
        if (query.includes("FROM competition_publications")) {
          return [{ published_schedule_revision_id: "rev-pub-1", schedule_published_at: new Date() }];
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

    // Semantic equivalence of identical archives
    const eqSelf = runtime.compareSemanticEquivalence(archive, archive);
    expect(eqSelf.equivalent).toBe(true);
    expect(eqSelf.differences).toHaveLength(0);

    // Semantic equivalence detects division modifications
    const modifiedArchive = JSON.parse(JSON.stringify(archive));
    modifiedArchive.divisions[0].entries.push({ id: "e2", name: "Extra Team", seed: 2 });
    const eqMod = runtime.compareSemanticEquivalence(archive, modifiedArchive);
    expect(eqMod.equivalent).toBe(false);
    expect(eqMod.differences.some((d) => d.includes("Entry count mismatch"))).toBe(true);
  });

  it("EXP-006: imports competition archive cleanly into target organisation", async () => {
    const executedQueries: string[] = [];
    const mockSql = {
      unsafe: (async (query: string) => {
        executedQueries.push(query);
        if (query.includes("FROM organisation_memberships")) {
          return [{ role: "owner" }];
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const validArchive = {
      schema_version: "1.0",
      exported_at: "2026-08-25T00:00:00.000Z",
      competition: {
        id: "c-old",
        name: "Spring Invitational",
        sport_code: "volleyball",
        status: "completed",
      },
      branding: {
        primary_color: "#112233",
        secondary_color: "#aabbcc",
        hide_platform_badge: true,
      },
      sponsors: [{ name: "Sports Bar", tier: "headline", sort_order: 1 }],
      divisions: [
        {
          id: "d-old",
          name: "Division A",
          entries: [
            { id: "e-old-1", name: "Spikers", seed: 1 },
            { id: "e-old-2", name: "Blockers", seed: 2 },
          ],
          matches: [
            {
              id: "m-old-1",
              code: "M01",
              stage: "Pool Play",
              home_entry_id: "e-old-1",
              away_entry_id: "e-old-2",
              state: "completed",
            },
          ],
        },
      ],
    };

    const runtime = new ExportRuntime(mockSql);
    const result = await runtime.importCompetitionArchive(adminActor, "org-dest-1", validArchive, "(Re-imported)");

    expect(result.competition_id).toBeDefined();
    expect(result.name).toBe("Spring Invitational (Re-imported)");
    expect(result.divisions_count).toBe(1);
    expect(result.entries_count).toBe(2);
    expect(result.matches_count).toBe(1);

    expect(executedQueries.some((q) => q.includes("INSERT INTO competitions") && q.includes("'draft'"))).toBe(true);
    expect(executedQueries.some((q) => q.includes("INSERT INTO competition_sport_settings"))).toBe(true);
    expect(executedQueries.some((q) => q.includes("INSERT INTO competition_branding"))).toBe(true);
    expect(executedQueries.some((q) => q.includes("INSERT INTO competition_sponsors"))).toBe(true);
    expect(executedQueries.some((q) => q.includes("INSERT INTO divisions"))).toBe(true);
    expect(executedQueries.some((q) => q.includes("INSERT INTO division_entries"))).toBe(true);
    expect(executedQueries.some((q) => q.includes("INSERT INTO matches"))).toBe(true);
  });

  it("EXP-006: rejects malformed archives and unauthorized import actors", async () => {
    const mockSql = {
      unsafe: (async (query: string) => {
        if (query.includes("FROM organisation_memberships")) {
          // This actor is an active viewer. The runtime must include the editor-role predicate,
          // otherwise this mock would incorrectly authorize the import.
          return query.includes("role IN ('owner','organiser')") ? [] : [{ role: "viewer" }];
        }
        if (query.includes("FROM account_platform_roles")) {
          return []; // non-admin!
        }
        return [];
      }) as PostgresJsSql["unsafe"],
    } as unknown as PostgresJsSql;

    const runtime = new ExportRuntime(mockSql);

    // Malformed schema
    const malformed = { schema_version: "2.0", competition: { name: "Bad" } };
    expect(runtime.validateCompetitionArchive(malformed).valid).toBe(false);

    await expect(runtime.importCompetitionArchive(adminActor, "org-1", malformed)).rejects.toThrow(
      /Unsupported schema_version/,
    );

    // Valid archive but unauthorized actor
    const validArchive = {
      schema_version: "1.0",
      competition: { id: "c1", name: "Valid", sport_code: "basketball" },
      divisions: [],
    };
    await expect(runtime.importCompetitionArchive(adminActor, "org-1", validArchive)).rejects.toThrow(
      /Access denied to target organisation/,
    );
  });

  it("permits only active platform-admin grants to import an archive", async () => {
    const archive = {
      schema_version: "1.0",
      competition: { id: "c1", name: "Valid", sport_code: "basketball" },
      divisions: [],
    };
    const createRuntime = (grant: "active" | "revoked" | "expired") => {
      const mockSql = {
        unsafe: (async (query: string) => {
          if (query.includes("FROM organisation_memberships")) return [];
          if (query.includes("FROM account_platform_roles")) {
            const activeGrantPredicate =
              query.includes("revoked_at IS NULL") && query.includes("expires_at IS NULL OR expires_at > now()");
            return grant === "active" && activeGrantPredicate ? [{ role: "platform_admin" }] : [];
          }
          return [];
        }) as PostgresJsSql["unsafe"],
      } as unknown as PostgresJsSql;
      return new ExportRuntime(mockSql);
    };

    await expect(createRuntime("active").importCompetitionArchive(adminActor, "org-1", archive)).resolves.toMatchObject(
      {
        divisions_count: 0,
        entries_count: 0,
        matches_count: 0,
      },
    );
    await expect(createRuntime("revoked").importCompetitionArchive(adminActor, "org-1", archive)).rejects.toThrow(
      /Access denied to target organisation/,
    );
    await expect(createRuntime("expired").importCompetitionArchive(adminActor, "org-1", archive)).rejects.toThrow(
      /Access denied to target organisation/,
    );
  });
});
