import { describe, expect, it } from "vitest";
import {
  BASKETBALL_FEDERATION_SPORT_PACK,
  STANDINGS_SPORT_PACKS,
  SPORT_PACKS,
  applyFederationStandingsRules,
  assertFiveSportScoreCommandAllowed,
  calculateStandings,
  defaultResultScore,
  federationRulesFor,
  reduceFiveSportScoreEvents,
  type FiveSportScoreEvent,
  type StandingsMatchResult,
} from "../src/index.js";

// FIBA OBR 2026 Art. 21: a default is not a forfeit (Art. 20).
function event(
  sequence: number,
  input: Partial<FiveSportScoreEvent> & Pick<FiveSportScoreEvent, "type">,
): FiveSportScoreEvent {
  return {
    eventId: `event-${sequence}`,
    clientEventId: `client-${sequence}`,
    matchId: "match-1",
    sequence,
    actorId: "official-1",
    scoringSessionId: "session-1",
    occurredAt: new Date(Date.UTC(2026, 10, 1, 10, 0, sequence)).toISOString(),
    manualTimeSeconds: sequence,
    ...input,
  };
}

const settings = BASKETBALL_FEDERATION_SPORT_PACK.recommendedSettings;

function defaultedMatch(homeBaskets: number, awayBaskets: number, awarded: "home" | "away") {
  const scoring = [
    ...Array.from({ length: homeBaskets }, () => ({ type: "two_point_score", side: "home" as const })),
    ...Array.from({ length: awayBaskets }, () => ({ type: "two_point_score", side: "away" as const })),
  ];
  const events = [
    event(1, { type: "match_started" }),
    ...scoring.map((input, index) => event(index + 2, input)),
    event(scoring.length + 2, { type: "default", side: awarded }),
    event(scoring.length + 3, { type: "finalisation" }),
  ];
  return reduceFiveSportScoreEvents("basketball", events, undefined, { packVersion: "1.0.0" });
}

describe("basketball default (FIBA OBR Art. 21)", () => {
  it("records a default as its own exceptional outcome on the federation pack", () => {
    const state = defaultedMatch(3, 5, "home");
    expect(state).toMatchObject({ lifecycle: "finalised", exceptionalOutcome: "default", winner: "home" });
    expect(state.totalPoints).toEqual({ home: 6, away: 10 });
  });

  it("is not available on the draft basketball pack", () => {
    expect(SPORT_PACKS.basketball.eventTypes.some((definition) => definition.id === "default")).toBe(false);
    expect(() =>
      assertFiveSportScoreCommandAllowed("basketball", {
        clientEventId: "00000000-0000-4000-8000-000000000001",
        type: "default",
        side: "home",
        occurredAt: "2026-11-01T10:00:00.000Z",
        manualTimeSeconds: 10,
      }),
    ).toThrow(/not supported/u);
  });

  it("keeps the score when the team awarded the game leads, otherwise records 2-0", () => {
    expect(defaultResultScore({ home: 40, away: 31 }, "home", settings)).toEqual({ home: 40, away: 31 });
    expect(defaultResultScore({ home: 31, away: 40 }, "home", settings)).toEqual({ home: 2, away: 0 });
    expect(defaultResultScore({ home: 12, away: 12 }, "away", settings)).toEqual({ home: 0, away: 2 });
  });

  it("cites Art. 21 in the federation table, separately from the 20-0 forfeit", () => {
    const rules = new Map(federationRulesFor("basketball", "1.0.0").map((rule) => [rule.setting, rule]));
    expect(rules.get("defaultWinnerScore")?.value).toBe(2);
    expect(rules.get("defaultLoserScore")?.value).toBe(0);
    expect(rules.get("defaultLossPoints")).toMatchObject({
      value: 1,
      group: "standings",
      source: {
        doc: "FIBA Official Basketball Rules",
        clause: "Art. 21.1, 21.2.1 Default",
        url: "https://assets.fiba.basketball/image/upload/documents-corporate-fiba-official-rules-2026-v1-1.pdf",
        verified: "primary",
      },
    });
    expect(rules.get("forfeitWinnerScore")?.value).toBe(20);
  });

  it("gives the defaulting team 1 classification point and a forfeiting team 0", () => {
    const config = applyFederationStandingsRules(STANDINGS_SPORT_PACKS.basketball, "basketball", "1.0.0", settings);
    expect(config.defaultLossPoints).toBe(1);
    const results: StandingsMatchResult[] = [
      {
        matchId: "m1",
        homeEntryId: "a",
        awayEntryId: "b",
        homeScore: 2,
        awayScore: 0,
        status: "final",
        version: 1,
        defaultLoserEntryId: "b",
      },
      {
        matchId: "m2",
        homeEntryId: "a",
        awayEntryId: "c",
        homeScore: 20,
        awayScore: 0,
        status: "forfeit",
        version: 1,
        forfeitLoserEntryId: "c",
      },
    ];
    const rows = calculateStandings(
      [
        { id: "a", name: "Alpha", seed: 1 },
        { id: "b", name: "Bravo", seed: 2 },
        { id: "c", name: "Charlie", seed: 3 },
      ],
      results,
      config,
    );
    expect(rows.map((row) => [row.entryId, row.won, row.lost, row.tablePoints])).toEqual([
      ["a", 2, 0, 4],
      ["b", 0, 1, 1],
      ["c", 0, 1, 0],
    ]);
  });

  it("rejects a default result that leaves the defaulting team ahead", () => {
    const config = applyFederationStandingsRules(STANDINGS_SPORT_PACKS.basketball, "basketball", "1.0.0", settings);
    expect(() =>
      calculateStandings(
        [
          { id: "a", name: "Alpha", seed: 1 },
          { id: "b", name: "Bravo", seed: 2 },
        ],
        [
          {
            matchId: "m1",
            homeEntryId: "a",
            awayEntryId: "b",
            homeScore: 10,
            awayScore: 30,
            status: "final",
            version: 1,
            defaultLoserEntryId: "b",
          },
        ],
        config,
      ),
    ).toThrow(/ahead/u);
  });

  it("leaves draft basketball standings without a default scheme", () => {
    const draft = applyFederationStandingsRules(
      STANDINGS_SPORT_PACKS.basketball,
      "basketball",
      SPORT_PACKS.basketball.version,
      SPORT_PACKS.basketball.recommendedSettings,
    );
    expect(draft).toBe(STANDINGS_SPORT_PACKS.basketball);
    expect(draft.defaultLossPoints).toBeUndefined();
  });
});
