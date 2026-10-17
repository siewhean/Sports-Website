import { describe, expect, it } from "vitest";
import {
  BASKETBALL_FEDERATION_SPORT_PACK,
  CANOE_POLO_FEDERATION_SPORT_PACK,
  FEDERATION_SPORT_PACKS,
  ICF_HONOURABLE_PLAY_WEIGHTS,
  SPORT_PACKS,
  TABLE_TENNIS_FEDERATION_SPORT_PACK,
  VOLLEYBALL_FEDERATION_SPORT_PACK,
  BADMINTON_3X15_SPORT_PACK,
  BADMINTON_FEDERATION_SPORT_PACK,
  calculateStandings,
} from "@matchday/domain";
import { phase3DomainAdapter } from "../../src/phase-3-domain-adapter.js";
import { standingsResultFromSnapshot } from "../../src/standings-results.js";

const config = (pack: (typeof FEDERATION_SPORT_PACKS)[number]) =>
  phase3DomainAdapter.standingsConfig(pack, pack.recommendedSettings);

describe("standings configuration for federation packs (redesign Phase 4)", () => {
  it("records the federation forfeit results: canoe polo 7-0, volleyball 0-3 with 0-25 sets", () => {
    expect(config(CANOE_POLO_FEDERATION_SPORT_PACK).forfeitScore).toEqual({ homeScore: 7, awayScore: 0 });
    expect(config(VOLLEYBALL_FEDERATION_SPORT_PACK).forfeitScore).toEqual({
      homeScore: 75,
      awayScore: 0,
      homeSegments: [25, 25, 25],
      awaySegments: [0, 0, 0],
    });
    expect(config(BADMINTON_3X15_SPORT_PACK).forfeitScore).toMatchObject({ homeSegments: [15, 15] });
  });

  it("uses 2/1/0 with head-to-head first for basketball and table tennis", () => {
    expect(config(BASKETBALL_FEDERATION_SPORT_PACK)).toMatchObject({
      winPoints: 2,
      lossPoints: 1,
      forfeitLossPoints: 0,
      criteria: ["table_points", "head_to_head", "score_difference", "score_for"],
    });
    expect(config(TABLE_TENNIS_FEDERATION_SPORT_PACK)).toMatchObject({
      winPoints: 2,
      lossPoints: 1,
      forfeitLossPoints: 0,
      criteria: ["table_points", "head_to_head", "segment_ratio", "score_ratio"],
    });
    expect(config(CANOE_POLO_FEDERATION_SPORT_PACK)).toMatchObject({
      winPoints: 3,
      drawPoints: 1,
      lossPoints: 0,
      disciplineWeights: ICF_HONOURABLE_PLAY_WEIGHTS,
    });
  });

  it("leaves draft-pack configurations without the federation rules", () => {
    for (const pack of Object.values(SPORT_PACKS)) {
      const draft = phase3DomainAdapter.standingsConfig(pack, pack.recommendedSettings);
      expect(draft.forfeitLossPoints).toBeUndefined();
      expect(draft.disciplineWeights).toBeUndefined();
      expect(draft.version).not.toContain("federation");
    }
  });

  it("counts honourable play from a finalised canoe polo match's cards", () => {
    const engine = config(CANOE_POLO_FEDERATION_SPORT_PACK);
    const row = (matchId: string, actions: unknown[]) => ({
      match_id: matchId,
      home_entry_id: "a",
      away_entry_id: "b",
      home_score: 1,
      away_score: 1,
      state: "final" as const,
      result_version: 1,
      snapshot: {
        segments: [{ home: 1, away: 1 }],
        totalPoints: { home: 1, away: 1 },
        exceptionalOutcome: null,
        winner: null,
        actions,
      },
    });
    const converted = standingsResultFromSnapshot(
      row("m1", [
        { eventType: "red_card", side: "home", reversed: false },
        { eventType: "yellow_card", side: "away", reversed: false },
        { eventType: "green_card", side: "away", reversed: true },
      ]),
      engine,
    );
    expect(converted).toMatchObject({ homeDisciplinePoints: 25, awayDisciplinePoints: 5 });
    const standings = calculateStandings(
      [
        { id: "a", name: "Alpha", seed: 1 },
        { id: "b", name: "Bravo", seed: 2 },
      ],
      [converted],
      engine,
    );
    expect(standings.map((entry) => entry.entryId)).toEqual(["b", "a"]);

    const draft = phase3DomainAdapter.standingsConfig(
      SPORT_PACKS.canoe_polo,
      SPORT_PACKS.canoe_polo.recommendedSettings,
    );
    expect(standingsResultFromSnapshot(row("m2", [{ eventType: "red_card", side: "home" }]), draft)).not.toHaveProperty(
      "homeDisciplinePoints",
    );
  });

  it("gives a forfeiting basketball team 0 classification points from a walkover snapshot", () => {
    const engine = config(BASKETBALL_FEDERATION_SPORT_PACK);
    const walkover = standingsResultFromSnapshot(
      {
        match_id: "m3",
        home_entry_id: "a",
        away_entry_id: "b",
        home_score: 0,
        away_score: 0,
        state: "final",
        result_version: 1,
        snapshot: { segments: [], exceptionalOutcome: "walkover", winner: "home", actions: [] },
      },
      engine,
    );
    const standings = calculateStandings(
      [
        { id: "a", name: "Alpha", seed: 1 },
        { id: "b", name: "Bravo", seed: 2 },
      ],
      [walkover],
      engine,
    );
    expect(standings.map((entry) => [entry.entryId, entry.tablePoints])).toEqual([
      ["a", 2],
      ["b", 0],
    ]);
  });
  it("deletes a retired badminton player's group results on a federation pack only", () => {
    const snapshotRow = (matchId: string, home: string, away: string, extra: Record<string, unknown>) => ({
      match_id: matchId,
      home_entry_id: home,
      away_entry_id: away,
      home_score: 0,
      away_score: 0,
      state: "final" as const,
      result_version: 1,
      snapshot: { exceptionalOutcome: null, actions: [], ...extra },
    });
    const rows = [
      snapshotRow("m1", "a", "b", {
        segments: [
          { home: 21, away: 10 },
          { home: 21, away: 10 },
        ],
        totalPoints: { home: 42, away: 20 },
        winner: "home",
      }),
      snapshotRow("m2", "c", "a", {
        segments: [
          { home: 21, away: 5 },
          { home: 4, away: 2 },
        ],
        totalPoints: { home: 25, away: 7 },
        exceptionalOutcome: "retirement",
        winner: "home",
      }),
    ];
    const entries = [
      { id: "a", name: "Alpha", seed: 1 },
      { id: "b", name: "Bravo", seed: 2 },
      { id: "c", name: "Charlie", seed: 3 },
    ];
    const federation = config(BADMINTON_FEDERATION_SPORT_PACK);
    const converted = rows.map((row) => standingsResultFromSnapshot(row, federation));
    expect(converted[1]).toMatchObject({ retiredEntryId: "a" });
    const standings = calculateStandings(entries, converted, federation);
    expect(standings.find((row) => row.entryId === "a")).toMatchObject({ resultsDeleted: true, played: 0 });
    expect(standings.find((row) => row.entryId === "b")).toMatchObject({ played: 0, lost: 0 });

    const draft = phase3DomainAdapter.standingsConfig(SPORT_PACKS.badminton, SPORT_PACKS.badminton.recommendedSettings);
    const draftResults = rows.map((row) => standingsResultFromSnapshot(row, draft));
    expect(draftResults[1]).not.toHaveProperty("retiredEntryId");
    expect(calculateStandings(entries, draftResults, draft).some((row) => row.resultsDeleted)).toBe(false);
  });
  it("gives a basketball team that lost by default 1 classification point, keeping the stored default score", () => {
    const engine = config(BASKETBALL_FEDERATION_SPORT_PACK);
    expect(engine.defaultLossPoints).toBe(1);
    const defaulted = standingsResultFromSnapshot(
      {
        match_id: "m4",
        home_entry_id: "a",
        away_entry_id: "b",
        home_score: 2,
        away_score: 0,
        state: "final",
        result_version: 1,
        snapshot: {
          segments: [{ home: 10, away: 31 }],
          totalPoints: { home: 10, away: 31 },
          exceptionalOutcome: "default",
          winner: "home",
          actions: [],
        },
      },
      engine,
    );
    expect(defaulted).toMatchObject({ homeScore: 2, awayScore: 0, status: "final", defaultLoserEntryId: "b" });
    const standings = calculateStandings(
      [
        { id: "a", name: "Alpha", seed: 1 },
        { id: "b", name: "Bravo", seed: 2 },
      ],
      [defaulted],
      engine,
    );
    expect(standings.map((entry) => [entry.entryId, entry.tablePoints])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    expect(
      phase3DomainAdapter.standingsConfig(SPORT_PACKS.basketball, SPORT_PACKS.basketball.recommendedSettings),
    ).not.toHaveProperty("defaultLossPoints");
  });
});
