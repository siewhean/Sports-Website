import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STANDINGS_SPORT_PACKS,
  calculateStandings,
  type StandingsEngineConfig,
  type StandingsMatchResult,
  type StandingsParticipant,
  type StandingsSport,
} from "../src/index.js";

const entries: StandingsParticipant[] = [
  { id: "a", name: "Alpha", seed: 1 },
  { id: "b", name: "Bravo", seed: 2 },
  { id: "c", name: "Charlie", seed: 3 },
];

const fixture = JSON.parse(
  readFileSync(new URL("../../../validation/phase-3/standings/five-sport-packs.json", import.meta.url), "utf8"),
) as {
  cases: readonly {
    sport: StandingsSport;
    results: readonly StandingsMatchResult[];
    order: readonly string[];
  }[];
};

const headToHeadFixture = JSON.parse(
  readFileSync(new URL("../../../validation/phase-3/standings/scoped-head-to-head.json", import.meta.url), "utf8"),
) as { tiedScope: readonly string[]; expectedOrder: readonly string[] };

function customConfig(overrides: Partial<StandingsEngineConfig> = {}): StandingsEngineConfig {
  return { ...STANDINGS_SPORT_PACKS.canoe_polo, ...overrides };
}

describe("Phase 3 configurable standings engine and sport criteria", () => {
  it.each(Object.entries(STANDINGS_SPORT_PACKS))(
    "leaves exact $0 ties unresolved and deeply freezes its versioned default policy",
    (_sport, pack) => {
      expect(pack.criteria).not.toContain("seed");
      expect(pack.terminalFallback).toBe("unresolved");
      expect(Object.isFrozen(pack)).toBe(true);
      expect(Object.isFrozen(pack.criteria)).toBe(true);
      expect(Object.isFrozen(pack.forfeitScore)).toBe(true);
      if (pack.forfeitScore.homeSegments) expect(Object.isFrozen(pack.forfeitScore.homeSegments)).toBe(true);
      if (pack.forfeitScore.awaySegments) expect(Object.isFrozen(pack.forfeitScore.awaySegments)).toBe(true);

      const tied = calculateStandings(
        [
          { id: "a", name: "Alpha", seed: 99 },
          { id: "z", name: "Zulu", seed: 1 },
        ],
        [],
        pack,
      );
      expect(tied.map((row) => row.entryId)).toEqual(["a", "z"]);
      expect(tied.map((row) => row.rank)).toEqual([1, 1]);
      expect(tied.map((row) => row.displayOrder)).toEqual([1, 2]);
      expect(tied.every((row) => row.sportingTie && row.resolvedBy === "unresolved")).toBe(true);
      expect(tied.every((row) => !row.eligibleForAdvancement)).toBe(true);
    },
  );

  it("uses seed only when an organiser explicitly selects that terminal resolution policy", () => {
    const explicitlyResolved = calculateStandings(
      [
        { id: "a", name: "Alpha", seed: 2 },
        { id: "z", name: "Zulu", seed: 1 },
      ],
      [],
      customConfig({ terminalFallback: "seed_then_entry_id" }),
    );
    expect(explicitlyResolved.map((row) => row.entryId)).toEqual(["z", "a"]);
    expect(explicitlyResolved.map((row) => row.rank)).toEqual([1, 2]);
    expect(explicitlyResolved.every((row) => row.resolvedBy === "seed" && row.eligibleForAdvancement)).toBe(true);
  });

  it.each(fixture.cases)("matches the independent $sport order", ({ sport, results, order }) => {
    const standings = calculateStandings(entries, results, STANDINGS_SPORT_PACKS[sport]);
    expect(standings.map((row) => row.entryId)).toEqual(order);
    expect(standings.every((row) => row.explanations.length >= STANDINGS_SPORT_PACKS[sport].criteria.length)).toBe(
      true,
    );
  });

  it("compares rational criteria exactly instead of converting ratios to floating point", () => {
    const closeRatioEntries: StandingsParticipant[] = [
      { id: "a", name: "A", seed: 1 },
      { id: "b", name: "B", seed: 2 },
      { id: "c", name: "C", seed: 3 },
      { id: "d", name: "D", seed: 4 },
    ];
    const results: StandingsMatchResult[] = [
      {
        matchId: "m-a",
        homeEntryId: "a",
        awayEntryId: "c",
        homeScore: 9_007_199_254_740_000,
        awayScore: 9_007_199_254_739_999,
        homeSegments: [9_007_199_254_740_000],
        awaySegments: [9_007_199_254_739_999],
        status: "final",
        version: 1,
      },
      {
        matchId: "m-b",
        homeEntryId: "b",
        awayEntryId: "d",
        homeScore: 9_007_199_254_739_999,
        awayScore: 9_007_199_254_739_998,
        homeSegments: [9_007_199_254_739_999],
        awaySegments: [9_007_199_254_739_998],
        status: "final",
        version: 1,
      },
    ];
    const config = { ...STANDINGS_SPORT_PACKS.volleyball, criteria: ["score_ratio"] as const };
    const standings = calculateStandings(closeRatioEntries, results, config);
    expect(standings.findIndex((row) => row.entryId === "b")).toBeLessThan(
      standings.findIndex((row) => row.entryId === "a"),
    );
    expect(standings.find((row) => row.entryId === "b")?.explanations[0]?.value).toBe(
      "9007199254739999/9007199254739998",
    );
  });

  it("uses games or sets—not aggregate rally points—to determine segmented-sport match wins", () => {
    const standings = calculateStandings(
      entries.slice(0, 2),
      [
        {
          matchId: "badminton-three-games",
          homeEntryId: "a",
          awayEntryId: "b",
          homeScore: 42,
          awayScore: 48,
          homeSegments: [21, 0, 21],
          awaySegments: [3, 30, 15],
          status: "final",
          version: 1,
        },
      ],
      STANDINGS_SPORT_PACKS.badminton,
    );
    expect(standings.map((row) => row.entryId)).toEqual(["a", "b"]);
    expect(standings[0]).toMatchObject({ won: 1, segmentsWon: 2, scoreFor: 42, scoreAgainst: 48 });
  });

  it("defines all-zero ratios, all-draw tables, and a deterministic terminal fallback", () => {
    const allDraws: StandingsMatchResult[] = [
      { matchId: "m1", homeEntryId: "a", awayEntryId: "b", homeScore: 0, awayScore: 0, status: "final", version: 1 },
      { matchId: "m2", homeEntryId: "b", awayEntryId: "c", homeScore: 0, awayScore: 0, status: "final", version: 1 },
      { matchId: "m3", homeEntryId: "c", awayEntryId: "a", homeScore: 0, awayScore: 0, status: "final", version: 1 },
    ];
    const standings = calculateStandings(
      entries,
      allDraws,
      customConfig({ criteria: ["score_ratio"], terminalFallback: "entry_id" }),
    );
    expect(standings.map((row) => row.entryId)).toEqual(["a", "b", "c"]);
    expect(standings.every((row) => row.explanations[0]?.value === "0/1 (0/0 defined as 0)")).toBe(true);
    expect(standings.every((row) => row.sportingTie && row.resolvedBy === "entry_id")).toBe(true);
  });

  it("rebuilds head-to-head as a mini-table scoped only to the tied entries", () => {
    const scopedEntries: StandingsParticipant[] = [
      ...entries,
      { id: "x", name: "Outsider", seed: 4 },
      { id: "y", name: "Bottom", seed: 5 },
    ];
    const results: StandingsMatchResult[] = [
      { matchId: "ab", homeEntryId: "a", awayEntryId: "b", homeScore: 1, awayScore: 0, status: "final", version: 1 },
      { matchId: "bx", homeEntryId: "b", awayEntryId: "x", homeScore: 1, awayScore: 0, status: "final", version: 1 },
      { matchId: "xa", homeEntryId: "x", awayEntryId: "a", homeScore: 1, awayScore: 0, status: "final", version: 1 },
      { matchId: "xy", homeEntryId: "x", awayEntryId: "y", homeScore: 1, awayScore: 0, status: "final", version: 1 },
    ];
    const standings = calculateStandings(
      scopedEntries,
      results,
      customConfig({ criteria: ["table_points", "head_to_head"], terminalFallback: "entry_id" }),
    );
    expect(standings.map((row) => row.entryId)).toEqual(headToHeadFixture.expectedOrder);
    const headToHead = standings
      .find((row) => row.entryId === "a")
      ?.explanations.find((detail) => detail.criterion === "head_to_head");
    expect(headToHead?.comparedWithinEntryIds).toEqual(headToHeadFixture.tiedScope);
    expect(headToHead?.value).toBe(3);
  });

  it("rejects ambiguous configurations and invalid active result projections", () => {
    expect(() => calculateStandings(entries, [], customConfig({ version: "" }))).toThrow(/versioned/);
    expect(() => calculateStandings(entries, [], customConfig({ criteria: ["table_points", "table_points"] }))).toThrow(
      /unique/,
    );
    const duplicate: StandingsMatchResult = {
      matchId: "same",
      homeEntryId: "a",
      awayEntryId: "b",
      homeScore: 1,
      awayScore: 0,
      status: "final",
      version: 1,
    };
    expect(() =>
      calculateStandings(entries, [duplicate, { ...duplicate, status: "corrected", version: 2 }], customConfig()),
    ).toThrow(/Multiple active results/);
  });
});
