import { describe, expect, it } from "vitest";
import {
  calculateAffectedMatchClosure,
  type AffectedMatchClosureInput,
  type RepairMatchSnapshot,
} from "../src/index.js";

function match(matchId: string, overrides: Partial<RepairMatchSnapshot> = {}): RepairMatchSnapshot {
  return {
    matchId,
    divisionId: "division-open",
    state: "pending",
    homeEntryId: null,
    awayEntryId: null,
    homeControl: "automatic",
    awayControl: "automatic",
    ...overrides,
  };
}

function baseInput(overrides: Partial<AffectedMatchClosureInput> = {}): AffectedMatchClosureInput {
  return {
    competitionId: "competition-1",
    correctedMatchId: "semi-1",
    sourceResultVersion: 7,
    sourceScheduleVersion: 4,
    matches: [match("semi-1")],
    dependencies: [],
    proposedOutcomes: [{ matchId: "semi-1", winnerEntryId: "team-b", loserEntryId: "team-a" }],
    ...overrides,
  };
}

describe("Gate C C4 affected-match repair closure", () => {
  it("classifies safe, protected, manual, locked, unresolved, and unchanged participant slots", () => {
    const result = calculateAffectedMatchClosure(
      baseInput({
        matches: [
          match("semi-1"),
          match("safe-final", { homeEntryId: "team-a" }),
          match("started-third", { state: "in_progress", homeEntryId: "team-a" }),
          match("finalised-medal", { state: "final", homeEntryId: "team-a" }),
          match("manual-placement", { homeEntryId: "team-a", homeControl: "manual" }),
          match("locked-ready", { state: "ready", homeEntryId: "team-a", operationallyLocked: true }),
          match("unchanged", { homeEntryId: "team-b" }),
          match("unresolved-next", { homeEntryId: "team-a" }),
        ],
        dependencies: [
          { sourceMatchId: "semi-1", downstreamMatchId: "safe-final", slot: "home", outcome: "winner" },
          { sourceMatchId: "semi-1", downstreamMatchId: "started-third", slot: "home", outcome: "loser" },
          { sourceMatchId: "semi-1", downstreamMatchId: "finalised-medal", slot: "home", outcome: "winner" },
          { sourceMatchId: "semi-1", downstreamMatchId: "manual-placement", slot: "home", outcome: "winner" },
          { sourceMatchId: "semi-1", downstreamMatchId: "locked-ready", slot: "home", outcome: "winner" },
          { sourceMatchId: "semi-1", downstreamMatchId: "unchanged", slot: "home", outcome: "winner" },
          { sourceMatchId: "safe-final", downstreamMatchId: "unresolved-next", slot: "home", outcome: "winner" },
        ],
      }),
    );

    expect(Object.fromEntries(result.actions.map((action) => [action.matchId, action.action]))).toEqual({
      "finalised-medal": "protected_finalised_match",
      "locked-ready": "requires_organiser_decision",
      "manual-placement": "protected_manual_slot",
      "safe-final": "automatic_update",
      "started-third": "protected_started_match",
      unchanged: "no_change",
      "unresolved-next": "requires_organiser_decision",
    });
    expect(result.actions.find(({ matchId }) => matchId === "safe-final")?.proposedEntryId).toBe("team-b");
    expect(result.actions.find(({ matchId }) => matchId === "started-third")?.proposedEntryId).toBe("team-a");
    expect(result.actions.find(({ matchId }) => matchId === "unresolved-next")?.dependencyPath).toHaveLength(2);
    expect(result.affectedDivisionIds).toEqual(["division-open"]);
  });

  it("uses supplied downstream outcomes to resolve transitive descendants", () => {
    const result = calculateAffectedMatchClosure(
      baseInput({
        matches: [
          match("semi-1"),
          match("final", { homeEntryId: "team-a" }),
          match("championship", { homeEntryId: "team-a", divisionId: "division-elite" }),
        ],
        dependencies: [
          { sourceMatchId: "semi-1", downstreamMatchId: "final", slot: "home", outcome: "winner" },
          { sourceMatchId: "final", downstreamMatchId: "championship", slot: "home", outcome: "winner" },
        ],
        proposedOutcomes: [
          { matchId: "semi-1", winnerEntryId: "team-b", loserEntryId: "team-a" },
          { matchId: "final", winnerEntryId: "team-c", loserEntryId: "team-b" },
        ],
      }),
    );

    expect(result.actions.map(({ matchId, proposedEntryId, action }) => [matchId, proposedEntryId, action])).toEqual([
      ["final", "team-b", "automatic_update"],
      ["championship", "team-c", "automatic_update"],
    ]);
    expect(result.affectedDivisionIds).toEqual(["division-elite", "division-open"]);
  });

  it("produces the same action order and fingerprint input regardless of input ordering", () => {
    const matches = [
      match("semi-1"),
      match("final", { homeEntryId: "team-a" }),
      match("third", { awayEntryId: "team-b" }),
    ];
    const dependencies = [
      { sourceMatchId: "semi-1", downstreamMatchId: "final", slot: "home" as const, outcome: "winner" as const },
      { sourceMatchId: "semi-1", downstreamMatchId: "third", slot: "away" as const, outcome: "loser" as const },
    ];
    const outcomes = [{ matchId: "semi-1", winnerEntryId: "team-b", loserEntryId: "team-a" }];

    const forward = calculateAffectedMatchClosure(baseInput({ matches, dependencies, proposedOutcomes: outcomes }));
    const reversed = calculateAffectedMatchClosure(
      baseInput({
        matches: [...matches].reverse(),
        dependencies: [...dependencies].reverse(),
        proposedOutcomes: [...outcomes].reverse(),
      }),
    );

    expect(reversed.actions).toEqual(forward.actions);
    expect(reversed.analysisFingerprintInput).toBe(forward.analysisFingerprintInput);
  });

  it("rejects reachable dependency cycles", () => {
    expect(() =>
      calculateAffectedMatchClosure(
        baseInput({
          matches: [match("semi-1"), match("final")],
          dependencies: [
            { sourceMatchId: "semi-1", downstreamMatchId: "final", slot: "home", outcome: "winner" },
            { sourceMatchId: "final", downstreamMatchId: "semi-1", slot: "away", outcome: "winner" },
          ],
          proposedOutcomes: [
            { matchId: "semi-1", winnerEntryId: "team-b", loserEntryId: "team-a" },
            { matchId: "final", winnerEntryId: "team-c", loserEntryId: "team-b" },
          ],
        }),
      ),
    ).toThrow(/cycle detected/);
  });

  it("rejects ambiguous duplicate dependency ownership for the same downstream slot", () => {
    expect(() =>
      calculateAffectedMatchClosure(
        baseInput({
          matches: [match("semi-1"), match("semi-2"), match("final")],
          dependencies: [
            { sourceMatchId: "semi-1", downstreamMatchId: "final", slot: "home", outcome: "winner" },
            { sourceMatchId: "semi-2", downstreamMatchId: "final", slot: "home", outcome: "winner" },
          ],
        }),
      ),
    ).toThrow(/duplicates final\/home/);
  });

  it("requires a corrected outcome before traversing dependent matches", () => {
    expect(() =>
      calculateAffectedMatchClosure(
        baseInput({
          matches: [match("semi-1"), match("final")],
          dependencies: [{ sourceMatchId: "semi-1", downstreamMatchId: "final", slot: "home", outcome: "winner" }],
          proposedOutcomes: [],
        }),
      ),
    ).toThrow(/requires a proposed winner and loser outcome/);
  });

  it("does not infer automatic descendants through a protected match", () => {
    const result = calculateAffectedMatchClosure(
      baseInput({
        matches: [
          match("semi-1"),
          match("started-final", { state: "in_progress", homeEntryId: "team-a" }),
          match("future-placement", { homeEntryId: "team-a" }),
        ],
        dependencies: [
          { sourceMatchId: "semi-1", downstreamMatchId: "started-final", slot: "home", outcome: "winner" },
          { sourceMatchId: "started-final", downstreamMatchId: "future-placement", slot: "home", outcome: "winner" },
        ],
        proposedOutcomes: [
          { matchId: "semi-1", winnerEntryId: "team-b", loserEntryId: "team-a" },
          { matchId: "started-final", winnerEntryId: "team-c", loserEntryId: "team-b" },
        ],
      }),
    );

    expect(result.actions.map(({ matchId, action }) => [matchId, action])).toEqual([
      ["started-final", "protected_started_match"],
    ]);
  });

  it("rejects invalid runtime enum values instead of classifying them as safe automatic updates", () => {
    expect(() =>
      calculateAffectedMatchClosure(
        baseInput({
          matches: [match("semi-1"), match("final", { state: "abandoned" as never })],
        }),
      ),
    ).toThrow(/final state is invalid/);

    expect(() =>
      calculateAffectedMatchClosure(
        baseInput({
          matches: [match("semi-1"), match("final")],
          dependencies: [
            { sourceMatchId: "semi-1", downstreamMatchId: "final", slot: "home", outcome: "draw" as never },
          ],
        }),
      ),
    ).toThrow(/semi-1 outcome is invalid/);
  });
});
