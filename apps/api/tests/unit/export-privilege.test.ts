import { describe, expect, it } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import { ExportRuntime } from "../../src/export-runtime.js";
import { PublishedExportRuntime } from "../../src/published-export-runtime.js";

const COMPETITION = "00000000-0000-4000-8000-000000000003";
const SCHEDULE_REVISION = "00000000-0000-4000-8000-000000000001";
const FORMAT_REVISION = "00000000-0000-4000-8000-000000000002";
const RESULTS_PUBLISHED_AT = new Date("2026-08-25T12:00:00.000Z");

type Who = "anonymous" | "stranger" | "viewer" | "organiser" | "admin";
type Recorded = { sql: string; params: readonly unknown[] };

const actors: Record<Who, { accountId: string } | undefined> = {
  anonymous: undefined,
  stranger: { accountId: "stranger" },
  viewer: { accountId: "viewer" },
  organiser: { accountId: "organiser" },
  admin: { accountId: "admin" },
};

const createSql = (published: boolean, who: Who) => {
  const queries: Recorded[] = [];
  const unsafe = (async (sql: string, params: readonly unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("organisation_id, status FROM competitions")) {
      return [{ id: COMPETITION, organisation_id: "org-1", status: published ? "published" : "draft" }];
    }
    if (sql.includes("FROM competition_publications") && sql.includes("schedule_published_at")) {
      return published
        ? [
            {
              published_schedule_revision_id: SCHEDULE_REVISION,
              schedule_published_at: new Date(0),
              results_published_at: RESULTS_PUBLISHED_AT,
            },
          ]
        : [];
    }
    if (sql.includes("FROM organisation_memberships")) {
      // The membership lookup only matches owners/organisers; viewers and strangers have no privileged row.
      expect(sql).toContain("role IN ('owner','organiser')");
      return who === "organiser" ? [{ role: "organiser" }] : [];
    }
    if (sql.includes("FROM account_platform_roles")) return who === "admin" ? [{ role: "platform_admin" }] : [];
    if (sql.includes("FROM competitions c")) {
      return [
        published
          ? {
              status: "published",
              published_schedule_revision_id: SCHEDULE_REVISION,
              schedule_published_at: new Date(0),
              results_published_at: RESULTS_PUBLISHED_AT,
              format_revision_id: FORMAT_REVISION,
            }
          : {
              status: "draft",
              published_schedule_revision_id: null,
              schedule_published_at: null,
              results_published_at: null,
              format_revision_id: null,
            },
      ];
    }
    if (sql.includes("FROM competitions WHERE id=$1")) {
      return [{ id: COMPETITION, name: "Cup", sport_code: "football", status: "published", created_at: new Date(0) }];
    }
    return [];
  }) as PostgresJsSql["unsafe"];
  return { sql: { unsafe } as unknown as PostgresJsSql, queries };
};

const hit = (queries: Recorded[], fragment: string) => queries.some((query) => query.sql.includes(fragment));

// Fragments that only exist in the draft-capable (organiser) query for each export...
const PRIVATE_MARKER = {
  csv: "LEFT JOIN scheduled_matches sm",
  standings: "FROM division_entries e",
  bracket: "LEFT JOIN division_entries e_home",
  json: "FROM divisions WHERE competition_id=$1",
} as const;
// ...and the published-only projection.
const PUBLIC_MARKER = {
  csv: "FROM scheduled_matches sm",
  standings: "published_results",
  bracket: "FROM scheduled_matches sm",
  json: "FROM scheduled_matches sm",
} as const;

type Kind = keyof typeof PRIVATE_MARKER;
const run = (runtime: ExportRuntime, kind: Kind, who: Who) => {
  const actor = actors[who];
  switch (kind) {
    case "csv":
      return runtime.generateCompetitionCsv(COMPETITION, actor);
    case "standings":
      return runtime.generateStandingsCsv(COMPETITION, actor);
    case "bracket":
      return runtime.generateBracketCsv(COMPETITION, actor);
    case "json":
      return runtime.generateCompetitionJson(COMPETITION, actor);
  }
};

describe("PublishedExportRuntime privilege split (published competition)", () => {
  for (const kind of ["csv", "standings", "bracket", "json"] as const) {
    for (const who of ["anonymous", "stranger", "viewer"] as const) {
      it(`${kind}: ${who} only ever receives the published-only projection`, async () => {
        const { sql, queries } = createSql(true, who);
        await run(new PublishedExportRuntime(sql), kind, who);
        expect(hit(queries, PRIVATE_MARKER[kind])).toBe(false);
        expect(hit(queries, PUBLIC_MARKER[kind])).toBe(true);
      });
    }

    for (const who of ["organiser", "admin"] as const) {
      it(`${kind}: ${who} gets the draft-capable path`, async () => {
        const { sql, queries } = createSql(true, who);
        await run(new PublishedExportRuntime(sql), kind, who);
        expect(hit(queries, PRIVATE_MARKER[kind])).toBe(true);
      });
    }
  }

  it("unpublished competition: signed-in non-members and viewers are refused for every export", async () => {
    for (const kind of ["csv", "standings", "bracket", "json"] as const) {
      for (const who of ["anonymous", "stranger", "viewer"] as const) {
        const { sql, queries } = createSql(false, who);
        await expect(run(new PublishedExportRuntime(sql), kind, who)).rejects.toMatchObject({ statusCode: 403 });
        expect(hit(queries, PRIVATE_MARKER[kind])).toBe(false);
      }
    }
  });

  it("unpublished competition: organisers still export drafts", async () => {
    const { sql, queries } = createSql(false, "organiser");
    await new PublishedExportRuntime(sql).generateCompetitionCsv(COMPETITION, actors.organiser);
    expect(hit(queries, PRIVATE_MARKER.csv)).toBe(true);
  });

  it("audit export requires a privileged actor; strangers and read-only viewers are refused", async () => {
    for (const who of ["stranger", "viewer"] as const) {
      const { sql } = createSql(true, who);
      await expect(
        new PublishedExportRuntime(sql).generateAuditHistoryExport(actors[who]!, COMPETITION),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    for (const who of ["organiser", "admin"] as const) {
      const { sql } = createSql(true, who);
      await expect(
        new PublishedExportRuntime(sql).generateAuditHistoryExport(actors[who]!, COMPETITION),
      ).resolves.toContain("Timestamp,Action");
    }
  });
});

describe("base ExportRuntime fails closed for signed-in non-members", () => {
  it("restricts match, standings, bracket and JSON queries to the published revision and result cutoff", async () => {
    for (const kind of ["csv", "standings", "bracket", "json"] as const) {
      const { sql, queries } = createSql(true, "stranger");
      await run(new ExportRuntime(sql), kind, "stranger");
      const restrictedMarker = kind === "json" ? "FROM matches m" : PRIVATE_MARKER[kind];
      const dataQuery = queries.find((query) => query.sql.includes(restrictedMarker));
      expect(dataQuery, kind).toBeDefined();
      const bound = dataQuery!.params.map((param) => (param instanceof Date ? param.toISOString() : param));
      expect(bound, kind).toContain(SCHEDULE_REVISION);
    }
    const { sql, queries } = createSql(true, "stranger");
    await new ExportRuntime(sql).generateStandingsCsv(COMPETITION, actors.stranger);
    const standings = queries.find((query) => query.sql.includes("FROM division_entries e"))!;
    expect(standings.params).toEqual([COMPETITION, true, RESULTS_PUBLISHED_AT, SCHEDULE_REVISION]);
  });

  it("does not restrict an organiser", async () => {
    const { sql, queries } = createSql(true, "organiser");
    await new ExportRuntime(sql).generateStandingsCsv(COMPETITION, actors.organiser);
    const standings = queries.find((query) => query.sql.includes("FROM division_entries e"))!;
    expect(standings.params).toEqual([COMPETITION, false, null, null]);
  });
});
