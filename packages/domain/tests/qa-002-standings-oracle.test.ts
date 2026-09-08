import { describe, expect, it } from "vitest";

import {
  STANDINGS_SPORT_PACKS,
  calculateStandings,
  computeManualStandingsOracle,
  type StandingsMatchResult,
  type StandingsParticipant,
  type StandingsSport,
} from "../src/index.js";

describe("QA-002 / QA-021 — Standings Verification & Independent Manual Calculation Oracle", () => {
  const participants: StandingsParticipant[] = [
    { id: "team-a", name: "Team Alpha", seed: 1 },
    { id: "team-b", name: "Team Beta", seed: 2 },
    { id: "team-c", name: "Team Gamma", seed: 3 },
    { id: "team-d", name: "Team Delta", seed: 4 },
  ];

  describe("Oracle Equivalence Across Unsegmented Sports (Canoe Polo, Basketball)", () => {
    it.each(["canoe_polo", "basketball"] as StandingsSport[])(
      "computes identical point totals, goal differences, and basic ranking order for %s",
      (sport) => {
        const pack = STANDINGS_SPORT_PACKS[sport];
        const results: StandingsMatchResult[] = [
          {
            matchId: "m1",
            homeEntryId: "team-a",
            awayEntryId: "team-b",
            homeScore: 3,
            awayScore: 1,
            status: "final",
            version: 1,
          },
          {
            matchId: "m2",
            homeEntryId: "team-c",
            awayEntryId: "team-d",
            homeScore: 2,
            awayScore: 2,
            status: "final",
            version: 1,
          },
          {
            matchId: "m3",
            homeEntryId: "team-a",
            awayEntryId: "team-c",
            homeScore: 1,
            awayScore: 0,
            status: "final",
            version: 1,
          },
          {
            matchId: "m4",
            homeEntryId: "team-b",
            awayEntryId: "team-d",
            homeScore: 4,
            awayScore: 1,
            status: "final",
            version: 1,
          },
        ];

        const engineOutput = calculateStandings(participants, results, pack);
        const oracleOutput = computeManualStandingsOracle(participants, results, pack);

        expect(engineOutput.length).toBe(participants.length);
        expect(oracleOutput.length).toBe(participants.length);

        for (const oracleRow of oracleOutput) {
          const engineRow = engineOutput.find((r) => r.entryId === oracleRow.entryId);
          expect(engineRow).toBeDefined();
          expect(engineRow!.played).toBe(oracleRow.played);
          expect(engineRow!.won).toBe(oracleRow.won);
          expect(engineRow!.drawn).toBe(oracleRow.drawn);
          expect(engineRow!.lost).toBe(oracleRow.lost);
          expect(engineRow!.tablePoints).toBe(oracleRow.points);
          expect(engineRow!.scoreFor).toBe(oracleRow.pointsFor);
          expect(engineRow!.scoreAgainst).toBe(oracleRow.pointsAgainst);
          expect(engineRow!.scoreDifference).toBe(oracleRow.pointDifference);
          expect(engineRow!.rank).toBe(oracleRow.rank);
        }
      },
    );
  });

  describe("Oracle Equivalence Across Segmented Sports (Badminton, Table Tennis, Volleyball)", () => {
    it.each(["badminton", "table_tennis", "volleyball"] as StandingsSport[])(
      "computes identical point totals and ranking order for %s with segment scores",
      (sport) => {
        const pack = STANDINGS_SPORT_PACKS[sport];
        const results: StandingsMatchResult[] = [
          {
            matchId: "m1",
            homeEntryId: "team-a",
            awayEntryId: "team-b",
            homeScore: 42,
            awayScore: 35,
            homeSegments: [21, 21],
            awaySegments: [18, 17],
            status: "final",
            version: 1,
          },
          {
            matchId: "m2",
            homeEntryId: "team-c",
            awayEntryId: "team-d",
            homeScore: 42,
            awayScore: 30,
            homeSegments: [21, 21],
            awaySegments: [15, 15],
            status: "final",
            version: 1,
          },
          {
            matchId: "m3",
            homeEntryId: "team-a",
            awayEntryId: "team-c",
            homeScore: 42,
            awayScore: 38,
            homeSegments: [21, 21],
            awaySegments: [19, 19],
            status: "final",
            version: 1,
          },
          {
            matchId: "m4",
            homeEntryId: "team-b",
            awayEntryId: "team-d",
            homeScore: 42,
            awayScore: 28,
            homeSegments: [21, 21],
            awaySegments: [14, 14],
            status: "final",
            version: 1,
          },
        ];

        const engineOutput = calculateStandings(participants, results, pack);
        const oracleOutput = computeManualStandingsOracle(participants, results, pack);

        expect(engineOutput.length).toBe(participants.length);
        expect(oracleOutput.length).toBe(participants.length);

        for (const oracleRow of oracleOutput) {
          const engineRow = engineOutput.find((r) => r.entryId === oracleRow.entryId);
          expect(engineRow).toBeDefined();
          expect(engineRow!.played).toBe(oracleRow.played);
          expect(engineRow!.won).toBe(oracleRow.won);
          expect(engineRow!.drawn).toBe(oracleRow.drawn);
          expect(engineRow!.lost).toBe(oracleRow.lost);
          expect(engineRow!.tablePoints).toBe(oracleRow.points);
          expect(engineRow!.rank).toBe(oracleRow.rank);
        }
      },
    );
  });

  describe("Tied Teams & Sporting Tie Identification", () => {
    it("flags sporting ties identically in both engine and manual oracle when records are exactly equal", () => {
      const pack = STANDINGS_SPORT_PACKS.canoe_polo;
      const results: StandingsMatchResult[] = [
        {
          matchId: "m1",
          homeEntryId: "team-a",
          awayEntryId: "team-b",
          homeScore: 2,
          awayScore: 2,
          status: "final",
          version: 1,
        },
        {
          matchId: "m2",
          homeEntryId: "team-c",
          awayEntryId: "team-d",
          homeScore: 2,
          awayScore: 2,
          status: "final",
          version: 1,
        },
      ];

      const engineOutput = calculateStandings(participants, results, pack);
      const oracleOutput = computeManualStandingsOracle(participants, results, pack);

      // All 4 teams have 1 draw, 2 goals for, 2 goals against -> tied for 1st
      for (const row of oracleOutput) {
        expect(row.rank).toBe(1);
        expect(row.sportingTie).toBe(true);
      }
      for (const row of engineOutput) {
        expect(row.rank).toBe(1);
        expect(row.sportingTie).toBe(true);
      }
    });

    it("correctly calculates standings for unplayed / round 0 competitions", () => {
      const pack = STANDINGS_SPORT_PACKS.basketball;
      const engineOutput = calculateStandings(participants, [], pack);
      const oracleOutput = computeManualStandingsOracle(participants, [], pack);

      expect(engineOutput.length).toBe(4);
      expect(oracleOutput.length).toBe(4);
      for (const row of oracleOutput) {
        expect(row.played).toBe(0);
        expect(row.points).toBe(0);
        expect(row.rank).toBe(1);
      }
    });
  });
});
