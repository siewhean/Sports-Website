import { describe, expect, it } from "vitest";
import {
  DRAFT_SPORT_PACK_VERSION,
  ICF_HONOURABLE_PLAY_WEIGHTS,
  STANDINGS_SPORT_PACKS,
  BASKETBALL_FEDERATION_SPORT_PACK,
  TABLE_TENNIS_FEDERATION_SPORT_PACK,
  BADMINTON_FEDERATION_SPORT_PACK,
  BADMINTON_3X15_SPORT_PACK,
  CANOE_POLO_FEDERATION_SPORT_PACK,
  applyFederationStandingsRules,
  calculateStandings,
  describeTieBreaks,
  disciplinePointsFromActions,
  type StandingsEngineConfig,
  type StandingsMatchResult,
  type StandingsParticipant,
} from "../src/index.js";

const three: StandingsParticipant[] = [
  { id: "a", name: "Alpha", seed: 1 },
  { id: "b", name: "Bravo", seed: 2 },
  { id: "c", name: "Charlie", seed: 3 },
];

let next = 0;
function result(
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
  extra: Partial<StandingsMatchResult> = {},
): StandingsMatchResult {
  next += 1;
  return {
    matchId: `m${next}`,
    homeEntryId: home,
    awayEntryId: away,
    homeScore,
    awayScore,
    status: "final",
    version: 1,
    ...extra,
  };
}

function games(home: readonly number[], away: readonly number[]) {
  return {
    homeSegments: home,
    awaySegments: away,
    homeScore: home.reduce((total, value) => total + value, 0),
    awayScore: away.reduce((total, value) => total + value, 0),
  };
}

function basketball(criteria?: StandingsEngineConfig["criteria"]): StandingsEngineConfig {
  const config = applyFederationStandingsRules(
    STANDINGS_SPORT_PACKS.basketball,
    "basketball",
    "1.0.0",
    BASKETBALL_FEDERATION_SPORT_PACK.recommendedSettings,
  );
  return { ...config, criteria: criteria ?? ["table_points", "head_to_head", "score_difference", "score_for"] };
}

describe("federation classification points (D29)", () => {
  it("gives basketball and table tennis 2 for a win, 1 for a loss and 0 for a forfeit", () => {
    for (const pack of [BASKETBALL_FEDERATION_SPORT_PACK, TABLE_TENNIS_FEDERATION_SPORT_PACK])
      expect(pack.recommendedSettings).toMatchObject({ winPoints: 2, lossPoints: 1, forfeitLossPoints: 0 });
    const rows = calculateStandings(
      three,
      [
        result("a", "b", 80, 70),
        result("a", "c", 20, 0, { status: "forfeit", forfeitLoserEntryId: "c" }),
        result("b", "c", 60, 50),
      ],
      basketball(),
    );
    expect(rows.map((row) => [row.entryId, row.tablePoints])).toEqual([
      ["a", 4],
      ["b", 3],
      ["c", 1],
    ]);
  });

  it("leaves draft-pack standings configurations untouched", () => {
    for (const sport of Object.keys(STANDINGS_SPORT_PACKS) as (keyof typeof STANDINGS_SPORT_PACKS)[]) {
      const base = STANDINGS_SPORT_PACKS[sport];
      expect(applyFederationStandingsRules(base, sport, DRAFT_SPORT_PACK_VERSION, { winPoints: 9 })).toBe(base);
    }
  });

  it("keeps a forfeit loss at the loss points when no forfeit scheme is set", () => {
    const rows = calculateStandings(
      three.slice(0, 2),
      [result("a", "b", 20, 0, { status: "forfeit", forfeitLoserEntryId: "b" })],
      { ...STANDINGS_SPORT_PACKS.basketball, winPoints: 2, lossPoints: 1 },
    );
    expect(rows.find((row) => row.entryId === "b")?.tablePoints).toBe(1);
  });

  it("uses the federation 3/1/0 for canoe polo with a 7-0 forfeit result elsewhere", () => {
    const config = applyFederationStandingsRules(
      STANDINGS_SPORT_PACKS.canoe_polo,
      "canoe_polo",
      "1.0.0",
      CANOE_POLO_FEDERATION_SPORT_PACK.recommendedSettings,
    );
    expect(config).toMatchObject({ winPoints: 3, drawPoints: 1, lossPoints: 0 });
    expect(config.disciplineWeights).toEqual(ICF_HONOURABLE_PLAY_WEIGHTS);
  });
});

describe("head-to-head first (FIBA, ITTF)", () => {
  it("falls back to point difference when head-to-head cannot split a three-way tie", () => {
    const tied = calculateStandings(
      three.slice(0, 2).concat({ id: "d", name: "Delta", seed: 4 }),
      [result("a", "d", 100, 40), result("b", "a", 61, 60), result("d", "b", 30, 20)],
      basketball(),
    );
    // Every team has 3 points; among all three the results are one win each, so point difference decides.
    expect(tied.map((row) => row.entryId)).toEqual(["a", "b", "d"]);
    expect(tied[0]?.resolvedBy).toBe("score_difference");
  });

  it("puts the head-to-head winner first even with the worse point difference", () => {
    const four: StandingsParticipant[] = [...three, { id: "d", name: "Delta", seed: 4 }];
    const rows = calculateStandings(
      four,
      [
        result("a", "b", 59, 60), // b beats a
        result("a", "c", 100, 10),
        result("a", "d", 100, 10),
        result("b", "c", 50, 49),
        result("b", "d", 40, 60), // b loses to d
        result("c", "d", 60, 50),
      ],
      basketball(),
    );
    // a and b both have 2 wins and 1 loss (5 points); a has the far better point difference but b won between them.
    const order = rows.map((row) => row.entryId);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
    expect(rows.find((row) => row.entryId === "b")?.resolvedBy).toBe("head_to_head");
  });
});

const badmintonCriteria: StandingsEngineConfig["criteria"] = [
  "match_wins",
  "head_to_head_two_way",
  "segment_difference",
  "score_difference",
];

describe("badminton two-way head-to-head (BWF)", () => {
  const config = { ...STANDINGS_SPORT_PACKS.badminton, criteria: badmintonCriteria };

  it("decides a two-way tie by the match between the two", () => {
    const four: StandingsParticipant[] = [...three, { id: "d", name: "Delta", seed: 4 }];
    const rows = calculateStandings(
      four,
      [
        result("a", "b", 0, 0, games([19, 21, 19], [21, 19, 21])), // b beats a in three games
        result("a", "c", 0, 0, games([21, 21], [5, 5])),
        result("a", "d", 0, 0, games([21, 21], [5, 5])),
        result("b", "c", 0, 0, games([21, 19, 21], [19, 21, 19])),
        result("d", "b", 0, 0, games([21, 21], [5, 5])),
        result("c", "d", 0, 0, games([21, 21], [19, 19])),
      ],
      config,
    );
    const order = rows.map((row) => row.entryId);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
    expect(rows.find((row) => row.entryId === "b")?.resolvedBy).toBe("head_to_head_two_way");
  });

  it("skips head-to-head for a three-way tie and uses game difference", () => {
    const rows = calculateStandings(
      three,
      [
        result("a", "b", 0, 0, games([21, 21], [5, 5])),
        result("b", "c", 0, 0, games([21, 21], [19, 19])),
        result("c", "a", 0, 0, games([21, 19, 21], [19, 21, 19])),
      ],
      config,
    );
    expect(rows.map((row) => row.entryId)).toEqual(["a", "b", "c"]);
    expect(rows[0]?.resolvedBy).toBe("segment_difference");
    expect(rows[0]?.explanations.find((trace) => trace.criterion === "head_to_head_two_way")?.summary).toMatch(
      /skipped/u,
    );
  });

  it("explains the two-way rule in plain words", () => {
    expect(
      describeTieBreaks(BADMINTON_FEDERATION_SPORT_PACK, BADMINTON_FEDERATION_SPORT_PACK.recommendedSettings),
    ).toMatch(/most matches won, then result between the two when exactly two are level, then best game difference/u);
  });

  it("uses the two-way rule in both badminton federation packs", () => {
    for (const pack of [BADMINTON_FEDERATION_SPORT_PACK, BADMINTON_3X15_SPORT_PACK])
      expect(pack.recommendedSettings.standingsOrder).toEqual([
        "match_wins",
        "head_to_head_two_way",
        "game_difference",
        "point_difference",
      ]);
  });
});

describe("badminton withdrawal in groups (BWF GCR 16.2.5)", () => {
  const four: StandingsParticipant[] = [...three, { id: "d", name: "Delta", seed: 4 }];
  const federation = (version: string) =>
    applyFederationStandingsRules(
      STANDINGS_SPORT_PACKS.badminton,
      "badminton",
      version,
      BADMINTON_FEDERATION_SPORT_PACK.recommendedSettings,
    );
  // d beats a and b, then retires against c: every d result is deleted.
  const withRetirement = () => [
    result("a", "b", 0, 0, games([21, 21], [10, 10])),
    result("a", "c", 0, 0, games([21, 21], [15, 15])),
    result("b", "c", 0, 0, games([21, 21], [18, 18])),
    result("d", "a", 0, 0, games([21, 21], [5, 5])),
    result("d", "b", 0, 0, games([21, 21], [5, 5])),
    result("c", "d", 0, 0, { ...games([11], [8]), retiredEntryId: "d" }),
  ];

  it("turns the rule on for both badminton federation packs only", () => {
    for (const version of [BADMINTON_FEDERATION_SPORT_PACK.version, BADMINTON_3X15_SPORT_PACK.version])
      expect(federation(version)).toMatchObject({ incompleteEntryResults: "delete_all" });
    expect(federation(DRAFT_SPORT_PACK_VERSION).incompleteEntryResults).toBeUndefined();
    expect(STANDINGS_SPORT_PACKS.badminton.incompleteEntryResults).toBeUndefined();
    const basketballConfig = applyFederationStandingsRules(
      STANDINGS_SPORT_PACKS.basketball,
      "basketball",
      "1.0.0",
      BASKETBALL_FEDERATION_SPORT_PACK.recommendedSettings,
    );
    expect(basketballConfig.incompleteEntryResults).toBeUndefined();
  });

  it("deletes every result of a player who retired, for every other player too", () => {
    const rows = calculateStandings(four, withRetirement(), federation("1.0.0"));
    expect(rows.map((row) => row.entryId)).toEqual(["a", "b", "c", "d"]);
    const byId = new Map(rows.map((row) => [row.entryId, row]));
    expect(byId.get("a")).toMatchObject({ played: 2, won: 2, lost: 0, segmentsWon: 4, segmentsLost: 0 });
    expect(byId.get("b")).toMatchObject({ played: 2, won: 1, lost: 1 });
    expect(byId.get("c")).toMatchObject({ played: 2, won: 0, lost: 2 });
    expect(byId.get("d")).toMatchObject({
      rank: 4,
      status: "withdrawn",
      resultsDeleted: true,
      eligibleForAdvancement: false,
      played: 0,
      won: 0,
      tablePoints: 0,
    });
    expect(byId.get("a")?.resultsDeleted).toBeUndefined();
  });

  it("deletes a walkover instead of scoring it as a 21-0 win", () => {
    const rows = calculateStandings(
      three,
      [
        result("a", "b", 0, 0, games([21, 21], [19, 19])),
        result("a", "c", 0, 0, { ...games([21, 21], [0, 0]), status: "forfeit", forfeitLoserEntryId: "c" }),
        result("b", "c", 0, 0, { ...games([21, 21], [0, 0]), status: "forfeit", forfeitLoserEntryId: "c" }),
      ],
      federation("1.1.0"),
    );
    expect(rows.map((row) => [row.entryId, row.played, row.won, row.scoreFor, row.resultsDeleted ?? false])).toEqual([
      ["a", 1, 1, 42, false],
      ["b", 1, 0, 38, false],
      ["c", 0, 0, 0, true],
    ]);
  });

  it("keeps the results of a player who completed every match", () => {
    const rows = calculateStandings(
      three,
      [
        result("a", "b", 0, 0, games([21, 21], [5, 5])),
        result("a", "c", 0, 0, games([21, 21], [5, 5])),
        result("b", "c", 0, 0, games([21, 21], [5, 5])),
      ],
      federation("1.0.0"),
    );
    expect(rows.every((row) => row.resultsDeleted === undefined && row.played === 2)).toBe(true);
  });

  it("counts the retired player's results on a draft pack, as before", () => {
    const rows = calculateStandings(four, withRetirement(), {
      ...STANDINGS_SPORT_PACKS.badminton,
      criteria: badmintonCriteria,
    });
    expect(rows.find((row) => row.entryId === "d")).toMatchObject({ played: 3, won: 2, status: "active" });
    expect(rows.some((row) => row.resultsDeleted)).toBe(false);
  });

  it("rejects a retirement that names an entry outside the match", () => {
    expect(() =>
      calculateStandings(
        four,
        [result("a", "b", 0, 0, { ...games([11], [3]), retiredEntryId: "c" })],
        federation("1.0.0"),
      ),
    ).toThrow(/must identify a participating entry/u);
  });
});

describe("canoe polo honourable play (ICF)", () => {
  it("counts 25 for a red card and 5 for every other card, ignoring reversed cards", () => {
    expect(
      disciplinePointsFromActions(
        [
          { eventType: "red_card", side: "home" },
          { eventType: "yellow_card", side: "away" },
          { eventType: "green_card", side: "away" },
          { eventType: "green_card", side: "home", reversed: true },
          { eventType: "goal", side: "home" },
        ],
        ICF_HONOURABLE_PLAY_WEIGHTS,
      ),
    ).toEqual({ home: 25, away: 10 });
  });

  it("ranks the team with fewer honourable-play points first when everything else is level", () => {
    const config = applyFederationStandingsRules(
      STANDINGS_SPORT_PACKS.canoe_polo,
      "canoe_polo",
      "1.0.0",
      CANOE_POLO_FEDERATION_SPORT_PACK.recommendedSettings,
    );
    const rows = calculateStandings(
      three.slice(0, 2),
      [result("a", "b", 2, 2, { homeDisciplinePoints: 25, awayDisciplinePoints: 15 })],
      config,
    );
    expect(rows.map((row) => row.entryId)).toEqual(["b", "a"]);
    expect(rows[0]?.resolvedBy).toBe("discipline");
  });

  it("leaves a tie that survives every rule for the organiser to resolve", () => {
    const config = applyFederationStandingsRules(
      STANDINGS_SPORT_PACKS.canoe_polo,
      "canoe_polo",
      "1.0.0",
      CANOE_POLO_FEDERATION_SPORT_PACK.recommendedSettings,
    );
    const rows = calculateStandings(three.slice(0, 2), [result("a", "b", 1, 1)], config);
    expect(rows.every((row) => row.resolvedBy === "unresolved" && !row.eligibleForAdvancement)).toBe(true);
  });
});

describe("tie-break text for the federation packs", () => {
  it("names head-to-head first for basketball and table tennis", () => {
    expect(
      describeTieBreaks(BASKETBALL_FEDERATION_SPORT_PACK, BASKETBALL_FEDERATION_SPORT_PACK.recommendedSettings),
    ).toBe(
      "Teams are ranked by most points, then result between the tied teams, then best point difference, then most points scored. If they are still level, the organiser decides and the decision is logged.",
    );
    expect(
      describeTieBreaks(TABLE_TENNIS_FEDERATION_SPORT_PACK, TABLE_TENNIS_FEDERATION_SPORT_PACK.recommendedSettings),
    ).toMatch(/ranked by most points, then result between the tied/u);
  });
});
