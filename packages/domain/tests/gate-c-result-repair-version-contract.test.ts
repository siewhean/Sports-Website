import { describe, expect, it } from "vitest";
import { calculateAffectedMatchClosure, type AffectedMatchClosureInput } from "../src/index.js";

function input(sourceScheduleVersion: number): AffectedMatchClosureInput {
  return {
    competitionId: "competition-1",
    correctedMatchId: "semi-1",
    sourceResultVersion: 1,
    sourceScheduleVersion,
    matches: [
      {
        matchId: "semi-1",
        divisionId: "division-open",
        state: "final",
        homeEntryId: "entry-a",
        awayEntryId: "entry-b",
        homeControl: "automatic",
        awayControl: "automatic",
      },
      {
        matchId: "final",
        divisionId: "division-open",
        state: "pending",
        homeEntryId: "entry-a",
        awayEntryId: null,
        homeControl: "automatic",
        awayControl: "automatic",
      },
    ],
    dependencies: [
      {
        sourceMatchId: "semi-1",
        downstreamMatchId: "final",
        slot: "home",
        outcome: "winner",
      },
    ],
    proposedOutcomes: [
      {
        matchId: "semi-1",
        winnerEntryId: "entry-b",
        loserEntryId: "entry-a",
      },
    ],
  };
}

describe("Gate C C4 repair schedule version contract", () => {
  it("accepts schedule version zero before the first publication", () => {
    const closure = calculateAffectedMatchClosure(input(0));

    expect(closure.sourceScheduleVersion).toBe(0);
    expect(JSON.parse(closure.analysisFingerprintInput)).toMatchObject({
      source_schedule_version: 0,
    });
    expect(closure.actions).toHaveLength(1);
    expect(closure.actions[0]?.action).toBe("automatic_update");
  });

  it("rejects negative and non-integer schedule versions", () => {
    expect(() => calculateAffectedMatchClosure(input(-1))).toThrow(/non-negative integer/);
    expect(() => calculateAffectedMatchClosure(input(0.5))).toThrow(/non-negative integer/);
  });
});
