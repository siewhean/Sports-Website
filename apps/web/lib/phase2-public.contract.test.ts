import { describe, expect, it } from "vitest";
import type { PublicCompetitionProjection, PublicDivisionProjection } from "@matchday/contracts";
import {
  STANDINGS_SPORT_PACKS,
  calculateCanoePoloStandings,
  calculateStandings,
  generateBalancedCanoePoloFormat,
  resolveBracket,
  type CompetitionEntry,
} from "@matchday/domain";
import {
  PublicDataUnavailableError,
  classifyPublicResponse,
  publicStageLabel,
  standingsView,
  toCompetitionSummaryView,
  toCompetitionView,
} from "./phase2-public.server";

const entries: CompetitionEntry[] = [
  { id: "e1", name: "Alpha", seed: 1 },
  { id: "e2", name: "Bravo", seed: 2 },
  { id: "e3", name: "Charlie", seed: 3 },
  { id: "e4", name: "Delta", seed: 4 },
];

// Alpha beat Bravo 5-2, Charlie drew Delta 1-1, Alpha beat Charlie 3-0.
const matches = [
  { matchId: "m1", homeEntryId: "e1", awayEntryId: "e2", home: 5, away: 2 },
  { matchId: "m2", homeEntryId: "e3", awayEntryId: "e4", home: 1, away: 1 },
  { matchId: "m3", homeEntryId: "e1", awayEntryId: "e3", home: 3, away: 0 },
];

/** jsonb round trip, exactly what the API stores in standings_snapshots / bracket_snapshots. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectionWith(standings: unknown, bracket: unknown): PublicCompetitionProjection {
  const division: PublicDivisionProjection = {
    division: { id: "open", name: "Open" },
    schedule: [
      {
        id: "m1",
        code: "groups-G1-r1-m2",
        stage: "group",
        home: { id: "e1", name: "Alpha" },
        away: { id: "e2", name: "Bravo" },
        starts_at: "2026-09-19T00:00:00.000Z",
        ends_at: "2026-09-19T00:30:00.000Z",
        area: { id: "court-1", name: "Court 1" },
      },
      {
        id: "m3",
        code: "groups-G1-r3-m1",
        stage: "group",
        home: { id: "e1", name: "Alpha" },
        away: { id: "e3", name: "Charlie" },
        starts_at: "2026-09-19T02:00:00.000Z",
        ends_at: "2026-09-19T02:30:00.000Z",
        area: { id: "court-1", name: "Court 1" },
      },
    ],
    results: [
      {
        id: "m1",
        code: "groups-G1-r1-m2",
        stage: "group",
        home: { id: "e1", name: "Alpha" },
        away: { id: "e2", name: "Bravo" },
        home_score: 5,
        away_score: 2,
        state: "final",
        updated_at: "2026-09-19T00:35:00.000Z",
      },
    ],
    standings: standings as PublicDivisionProjection["standings"],
    bracket: bracket as PublicDivisionProjection["bracket"],
  };
  return {
    competition: {
      id: "c1",
      name: "Cup",
      slug: "cup",
      sport_code: "canoe_polo",
      timezone: "Asia/Singapore",
      starts_on: "2026-09-19",
      ends_on: "2026-09-20",
      status: "completed",
    },
    divisions: [division],
    division: division.division,
    publication: { schedule_version: 3, result_version: 5 },
    schedule: division.schedule,
    results: division.results,
    standings: division.standings,
    bracket: division.bracket,
    last_updated_at: "2026-09-19T08:35:00.000Z",
  };
}

describe("public projection contract with the real domain builders", () => {
  it("maps configurable-engine standings (tablePoints / scoreDifference) without zeroing them", () => {
    const rows = calculateStandings(
      entries.map((entry) => ({ id: entry.id, name: entry.name, seed: entry.seed })),
      matches.map((match, index) => ({
        matchId: match.matchId,
        homeEntryId: match.homeEntryId,
        awayEntryId: match.awayEntryId,
        homeScore: match.home,
        awayScore: match.away,
        status: "final" as const,
        version: index + 1,
      })),
      STANDINGS_SPORT_PACKS.canoe_polo,
    );
    // Guard the premise: the engine really emits the keys the mapper reads.
    expect(rows[0]).toMatchObject({ entryName: "Alpha", tablePoints: 6, scoreDifference: 6 });
    expect(rows[0]).not.toHaveProperty("points");

    const view = toCompetitionView(projectionWith({ standings: wire(rows), explanation: [] }, null));
    const alpha = view.standings.find((row) => row.team === "Alpha");
    expect(alpha).toMatchObject({ position: 1, played: 2, won: 2, drawn: 0, lost: 0, difference: 6, points: 6 });
    const charlie = view.standings.find((row) => row.team === "Charlie");
    expect(charlie).toMatchObject({ drawn: 1, lost: 1, difference: -3, points: 1 });
    expect(view.standings.every((row) => Number.isFinite(row.points) && Number.isFinite(row.difference))).toBe(true);
  });

  it("maps legacy canoe-polo standings (points / goalDifference)", () => {
    const rows = calculateCanoePoloStandings(
      entries,
      matches.map((match, index) => ({
        matchId: match.matchId,
        homeEntryId: match.homeEntryId,
        awayEntryId: match.awayEntryId,
        homeGoals: match.home,
        awayGoals: match.away,
        status: "final" as const,
        version: index + 1,
      })),
    );
    const view = toCompetitionView(projectionWith({ standings: wire(rows), explanation: [] }, null));
    expect(view.standings[0]).toMatchObject({ team: "Alpha", points: 6, difference: 6 });
  });

  it("fails loudly instead of showing 0 when a standings row drifts from the contract", () => {
    const drifted = [{ rank: 1, entryName: "Alpha", played: 2, won: 2, drawn: 0, lost: 0 }];
    expect(() => standingsView({ standings: drifted })).toThrow(/scoreDifference \| goalDifference/);
    expect(() =>
      standingsView({
        standings: [{ ...drifted[0], tablePoints: 6, scoreDifference: Number.NaN }],
      }),
    ).toThrow(/scoreDifference/);
  });

  it("maps a resolved bracket and never leaks internal match codes to spectators", () => {
    const format = generateBalancedCanoePoloFormat(
      Array.from({ length: 8 }, (_, index) => ({ id: `t${index + 1}`, name: `Team ${index + 1}`, seed: index + 1 })),
    );
    const resolution = resolveBracket(format, []);
    expect(resolution.matches.length).toBeGreaterThan(0);
    const first = resolution.matches[0]!;
    const projection = projectionWith(
      null,
      wire({ bracket: { ...resolution, matches: [{ ...first, matchId: "m1" }] }, conflicts: [] }),
    );
    const view = toCompetitionView(projection);
    expect(view.bracket).toHaveLength(1);
    expect(view.bracket[0]).toMatchObject({ id: "m1", fixture: "Alpha · Bravo", score: "5–2" });

    const visible = JSON.stringify({
      labels: view.matches.map(({ label, stage, home, away, area }) => ({ label, stage, home, away, area })),
      bracket: view.bracket,
    });
    expect(visible).not.toMatch(/groups-G1/i);
    expect(view.matches.map((match) => match.label)).toEqual(["Match 1", "Match 2"]);
    expect(view.matches.map((match) => match.stage)).toEqual(["Group G1 · Round 1", "Group G1 · Round 3"]);
    expect(view.matches[0]).toMatchObject({ code: "groups-G1-r1-m2", date: "19 September 2026", time: "08:00" });
  });

  it("derives freshness from the projection and keeps internal revision ids out of display fields", () => {
    const view = toCompetitionView(projectionWith(null, null));
    expect(view.lastUpdated).toMatch(/16:35/);
    expect(view.lastUpdated).toMatch(/SGT|GMT\+8/);
    expect(view).toMatchObject({ status: "completed", startsOn: "2026-09-19", endsOn: "2026-09-20" });
  });

  it("classifies summaries with the shared phase helper", () => {
    const summary = toCompetitionSummaryView(
      {
        id: "c1",
        name: "Cup",
        slug: "cup",
        sport_code: "canoe_polo",
        timezone: "Asia/Singapore",
        starts_on: "2026-09-19",
        ends_on: "2026-09-20",
        status: "active",
      },
      new Date("2026-10-09T09:00:00Z"),
    );
    expect(summary.phase).toBe("completed");
  });
});

describe("public stage labels", () => {
  it.each([
    ["group", "groups-G1-r2-m3", "Group G1 · Round 2"],
    ["group", "unparsed", "Group stage"],
    ["semifinal", "knockout-r2-m1", "Semifinal"],
    ["upper-bracket", "upper-bracket-r1-m1", "Upper bracket · Round 1"],
    ["lower-bracket", "lower-r2-m1", "Lower bracket · Round 2"],
    ["grand-final", "grand-final-r1-m1", "Grand final"],
    ["grand-final", "grand-final-reset-r1-m1", "Grand final reset"],
  ])("%s / %s -> %s", (stage, code, label) => {
    expect(publicStageLabel(stage, code)).toBe(label);
  });
});

describe("public response classification", () => {
  it("only treats 404 as not found; throttling and server errors are outages", () => {
    expect(classifyPublicResponse(404)).toBe("not_found");
    for (const status of [429, 500, 502, 503, 504]) expect(classifyPublicResponse(status)).toBe("unavailable");
    expect(new PublicDataUnavailableError("x", 503).status).toBe(503);
  });
});
