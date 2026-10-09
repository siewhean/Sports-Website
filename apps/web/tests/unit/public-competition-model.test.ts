import { describe, expect, it } from "vitest";
import type { CompetitionView, MatchView, PublicDivisionView } from "@/lib/phase2";
import {
  allMatches,
  availableTabs,
  bracketModel,
  competitionPhase,
  defaultScheduleDay,
  filterMatches,
  followedTeamStorageKey,
  followedTeamSummary,
  groupMatchesByDay,
  latestResults,
  liveMatches,
  parsePublicViewState,
  publicDivisions,
  resolveFollowedTeam,
  scoreChanges,
  selectDivision,
  serializePublicViewState,
  standingsShowDraws,
  upNext,
} from "@/lib/public-competition-model";

const tz = "Asia/Singapore";

function match(id: string, overrides: Partial<MatchView> = {}): MatchView {
  return {
    id,
    label: `Match ${id}`,
    stage: "Group A",
    time: "09:00",
    area: "Court 1",
    home: "Alpha",
    away: "Bravo",
    status: "scheduled",
    ...overrides,
  };
}

function division(id: string, matches: MatchView[], extra: Partial<PublicDivisionView> = {}): PublicDivisionView {
  return {
    division: { id, name: `Division ${id}`, teamCount: 4, matchCount: matches.length },
    teams: ["Alpha", "Bravo", "Charlie", "Delta"],
    areas: ["Court 1", "Court 2"],
    matches,
    standings: [],
    bracket: [],
    ...extra,
  };
}

function competition(divisions: PublicDivisionView[], extra: Partial<CompetitionView> = {}): CompetitionView {
  const first = divisions[0]!;
  return {
    id: "c1",
    slug: "open",
    name: "Open",
    sportCode: "volleyball",
    sport: "Volleyball",
    venue: "Hall",
    timezone: tz,
    dateLabel: "19–20 September 2026",
    status: "published",
    startsOn: "2026-09-19",
    endsOn: "2026-09-20",
    publicationRevision: "r1",
    publishedAt: "2026-09-18T00:00:00Z",
    lastUpdated: "19 Sep 09:00",
    division: first.division,
    publicDivisions: divisions,
    teams: first.teams,
    areas: first.areas,
    matches: first.matches,
    standings: first.standings,
    bracket: first.bracket,
    audit: [],
    ...extra,
  } as CompetitionView;
}

describe("view state in the URL", () => {
  it("round-trips and omits defaults so shared links stay short", () => {
    const state = parsePublicViewState("?tab=schedule&division=women&team=Alpha&court=Court%202&day=2026-09-20");
    expect(state).toEqual({ tab: "schedule", division: "women", team: "Alpha", court: "Court 2", day: "2026-09-20" });
    expect(parsePublicViewState(serializePublicViewState(state))).toEqual(state);
    expect(serializePublicViewState(parsePublicViewState(""))).toBe("");
  });

  it("falls back on unknown or malformed values", () => {
    const state = parsePublicViewState(`?tab=admin&day=tomorrow&team=${"x".repeat(300)}`);
    expect(state).toMatchObject({ tab: "live", day: null, team: null });
  });
});

describe("divisions and tabs", () => {
  it("selects the requested division or the first one", () => {
    const divisions = [division("open", []), division("women", [])];
    expect(selectDivision(divisions, "women").division.id).toBe("women");
    expect(selectDivision(divisions, "missing").division.id).toBe("open");
  });

  it("only offers the Bracket tab for knockout rounds", () => {
    const groupOnly = division("open", [], {
      bracket: [{ id: "g1", round: "Group A · Round 1", fixture: "Alpha · Bravo", score: "–", state: "TBD" }],
    });
    expect(availableTabs(groupOnly)).toEqual(["live", "schedule", "table"]);
    const knockout = division("open", [], {
      bracket: [{ id: "f", round: "Final", fixture: "Alpha · Bravo", score: "–", state: "TBD" }],
    });
    expect(availableTabs(knockout)).toContain("bracket");
  });
});

describe("bracket model", () => {
  it("never shows a group match under the grand final", () => {
    const model = bracketModel([
      {
        id: "g1",
        round: "Group G1 · Round 2",
        fixture: "A · B",
        score: "1–0",
        state: "Final",
        stageKind: "grand_final",
      },
      {
        id: "u1",
        round: "Upper bracket · Round 1",
        fixture: "A · B",
        score: "2–0",
        state: "Final",
        stageKind: "upper",
      },
      {
        id: "l1",
        round: "Lower bracket · Round 1",
        fixture: "C · D",
        score: "2–1",
        state: "Final",
        stageKind: "lower",
      },
      { id: "gf", round: "Grand final", fixture: "A · C", score: "–", state: "TBD", stageKind: "grand_final" },
    ]);
    expect(model.format).toBe("double");
    expect(model.finals.flatMap((round) => round.matches.map((row) => row.id))).toEqual(["gf"]);
    expect(model.upper.flatMap((round) => round.matches.map((row) => row.id))).toEqual(["u1"]);
    expect(model.lower.flatMap((round) => round.matches.map((row) => row.id))).toEqual(["l1"]);
  });

  it("detects single elimination and keeps round order", () => {
    const model = bracketModel([
      { id: "s1", round: "Semi-final", fixture: "A · B", score: "–", state: "TBD" },
      { id: "s2", round: "Semi-final", fixture: "C · D", score: "–", state: "TBD" },
      { id: "f", round: "Final", fixture: "TBD · TBD", score: "–", state: "TBD" },
    ]);
    expect(model.format).toBe("single");
    expect(model.upper.map((round) => [round.title, round.matches.length])).toEqual([
      ["Semi-final", 2],
      ["Final", 1],
    ]);
  });
});

describe("schedule", () => {
  const twoDays = [
    match("d2", { startsAt: "2026-09-20T01:00:00Z" }),
    match("d1b", { startsAt: "2026-09-19T03:00:00Z", area: "Court 2", home: "Charlie", away: "Delta" }),
    match("d1a", { startsAt: "2026-09-19T01:00:00Z" }),
    // 23:30 UTC on the 19th is the 20th in Singapore.
    match("late", { startsAt: "2026-09-19T23:30:00Z" }),
    match("tbc"),
  ];

  it("groups by calendar day in the competition timezone, ordered, undated last", () => {
    const days = groupMatchesByDay(twoDays, tz, "en-SG", "Time to be confirmed");
    expect(days.map((day) => day.key)).toEqual(["2026-09-19", "2026-09-20", "unscheduled"]);
    expect(days[0]!.matches.map((item) => item.id)).toEqual(["d1a", "d1b"]);
    expect(days[1]!.matches.map((item) => item.id)).toEqual(["late", "d2"]);
    expect(days[0]!.label).toContain("19");
    expect(days.at(-1)!.label).toBe("Time to be confirmed");
    // Every match appears exactly once.
    expect(days.flatMap((day) => day.matches).length).toBe(twoDays.length);
  });

  it("defaults to today during the event, otherwise the next day", () => {
    const days = groupMatchesByDay(twoDays, tz, "en-SG", "TBC");
    expect(defaultScheduleDay(days, new Date("2026-09-20T05:00:00Z"), tz)).toBe("2026-09-20");
    expect(defaultScheduleDay(days, new Date("2026-09-01T00:00:00Z"), tz)).toBe("2026-09-19");
    expect(defaultScheduleDay(days, new Date("2026-10-01T00:00:00Z"), tz)).toBe("2026-09-20");
  });

  it("filters by team and court", () => {
    expect(filterMatches(twoDays, { team: "Charlie", court: null }).map((item) => item.id)).toEqual(["d1b"]);
    expect(filterMatches(twoDays, { team: null, court: "Court 2" }).map((item) => item.id)).toEqual(["d1b"]);
    expect(filterMatches(twoDays, { team: "Alpha", court: "Court 2" })).toEqual([]);
  });
});

describe("live, up next and results", () => {
  const open = division("open", [
    match("l1", { status: "live", area: "Court 2", homeScore: 1, awayScore: 0, currentSegment: 2 }),
    match("l2", { status: "live", area: "Court 1", homeScore: 0, awayScore: 0 }),
    match("n1", { startsAt: "2026-09-19T05:00:00Z", home: "Charlie", away: "Delta" }),
    match("n0", { startsAt: "2026-09-19T04:00:00Z" }),
    match("r1", { status: "final", homeScore: 2, awayScore: 1, updatedAt: "2026-09-19T02:00:00Z" }),
    match("r2", { status: "final", homeScore: 0, awayScore: 2, updatedAt: "2026-09-19T03:00:00Z" }),
  ]);
  const women = division("women", [match("w1", { status: "live", home: "Echo", away: "Foxtrot" })]);
  const items = allMatches([open, women]);

  it("shows every live match across divisions, but none once the competition is completed", () => {
    expect(liveMatches(items, "live").map(({ match: item }) => item.id)).toEqual(["l2", "w1", "l1"]);
    expect(liveMatches(items, "completed")).toEqual([]);
  });

  it("orders up next by start time and results by most recent", () => {
    expect(upNext(items).map(({ match: item }) => item.id)).toEqual(["n0", "n1"]);
    expect(latestResults(items).map(({ match: item }) => item.id)).toEqual(["r2", "r1"]);
  });

  it("summarises a followed team and drops a stored team that no longer exists", () => {
    const summary = followedTeamSummary(items, "Charlie", "live");
    expect(summary.next?.match.id).toBe("n1");
    expect(summary.live).toBeNull();
    expect(summary.recent).toBeNull();
    expect(followedTeamSummary(items, "Alpha", "live").live?.match.id).toBe("l2");
    expect(resolveFollowedTeam("Ghost", ["Alpha"])).toBeNull();
    expect(resolveFollowedTeam("Alpha", ["Alpha"])).toBe("Alpha");
    expect(followedTeamStorageKey("open")).toBe("matchday.followed-team.open");
  });

  it("never reports the competition live after it has finished", () => {
    const done = competition([open], { status: "completed" });
    expect(competitionPhase(done, new Date("2026-09-20T05:00:00Z"))).toBe("completed");
    expect(competitionPhase(competition([open]), new Date("2026-09-19T05:00:00Z"))).toBe("live");
  });
});

describe("score changes and standings", () => {
  it("detects changed and newly finished scores only", () => {
    const before = competition([
      division("open", [match("a", { status: "live", homeScore: 1, awayScore: 0 }), match("b")]),
    ]);
    const after = competition([
      division("open", [match("a", { status: "final", homeScore: 2, awayScore: 0 }), match("b")]),
    ]);
    expect(scoreChanges(before, after, () => true)).toEqual([
      { matchId: "a", home: "Alpha", away: "Bravo", homeScore: 2, awayScore: 0, finished: true },
    ]);
    expect(scoreChanges(after, after, () => true)).toEqual([]);
    expect(publicDivisions(after)).toHaveLength(1);
  });

  it("shows the D column only for sports with draws", () => {
    const row = { position: 1, team: "Alpha", played: 1, won: 1, drawn: 0, lost: 0, difference: 1, points: 3 };
    const plain = division("open", [], { standings: [row] });
    expect(standingsShowDraws(competition([plain]), plain)).toBe(false);
    expect(standingsShowDraws(competition([plain], { sportCode: "canoe_polo" }), plain)).toBe(true);
  });
});
