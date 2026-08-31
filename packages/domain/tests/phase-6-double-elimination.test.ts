import { describe, expect, it } from "vitest";
import {
  buildDoubleEliminationFormatTemplate,
  createDoubleEliminationFormat,
  evaluateDoubleEliminationScheduleCapacity,
  recommendCompetitionFormats,
  resolveDoubleEliminationProgression,
  resolveDoubleEliminationResetFinal,
  validateFormatGraph,
  type FormatGraphMatch,
  type FormatParticipantSource,
} from "../src/index.js";

const DEFAULT_COUNTS = [8, 12, 16, 24, 48] as const;

function sourceKey(source: FormatParticipantSource): string {
  if (source.type === "entry_seed") return `seed:${source.seed}`;
  if (source.type === "stage_rank") return `rank:${source.stageId}:${source.groupId ?? "*"}:${source.rank}`;
  if (source.type === "manual_qualifier") return `manual:${source.stageId}:${source.qualifierId}`;
  return `${source.type}:${source.matchId}`;
}

function sourceUses(matches: readonly FormatGraphMatch[], key: string): number {
  return matches.flatMap((match) => [match.home, match.away]).filter((source) => sourceKey(source) === key).length;
}

describe("Phase 6 double elimination", () => {
  it.each(DEFAULT_COUNTS)("builds a deterministic valid %i-entry bracket", (entryCount) => {
    const first = createDoubleEliminationFormat(entryCount);
    const second = createDoubleEliminationFormat(entryCount);

    expect(first).toEqual(second);
    expect(validateFormatGraph(first.graph)).toEqual({ valid: true, issues: [] });
    expect(first.metrics.minimumMatchCount).toBe(entryCount * 2 - 2);
    expect(first.metrics.maximumMatchCount).toBe(entryCount * 2 - 1);
    expect(first.graph.matches).toHaveLength(entryCount * 2 - 2);
    expect(first.metrics.guaranteedMatches).toBeGreaterThanOrEqual(2);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.graph)).toBe(true);
    expect(Object.isFrozen(first.graph.matches)).toBe(true);
  });

  it.each(DEFAULT_COUNTS)("routes every upper-bracket outcome exactly once for %i entries", (entryCount) => {
    const definition = createDoubleEliminationFormat(entryCount);
    const upper = definition.graph.matches.filter((match) => match.stageId === "upper-bracket");

    for (const match of upper) {
      expect(sourceUses(definition.graph.matches, `winner:${match.id}`)).toBe(1);
      expect(sourceUses(definition.graph.matches, `loser:${match.id}`)).toBe(1);
    }
  });

  it.each(DEFAULT_COUNTS)(
    "eliminates lower-bracket losers and advances each lower winner for %i entries",
    (entryCount) => {
      const definition = createDoubleEliminationFormat(entryCount);
      const lower = definition.graph.matches.filter((match) => match.stageId === "lower-bracket");

      for (const match of lower) {
        expect(sourceUses(definition.graph.matches, `loser:${match.id}`)).toBe(0);
        expect(sourceUses(definition.graph.matches, `winner:${match.id}`)).toBe(1);
      }
    },
  );

  it("uses an if-required reset only when the lower-bracket champion wins grand final one", () => {
    const definition = createDoubleEliminationFormat(8);

    expect(resolveDoubleEliminationResetFinal(definition, "home")).toBeNull();
    expect(resolveDoubleEliminationResetFinal(definition, "away")).toEqual(definition.resetFinal.match);
    expect(definition.resetFinal.match.home).toEqual({ type: "winner", matchId: definition.firstFinalMatchId });
    expect(definition.resetFinal.match.away).toEqual({ type: "loser", matchId: definition.firstFinalMatchId });
    expect(definition.resetFinal.requiredWhen.reason).toBe(
      "lower_bracket_champion_hands_upper_bracket_champion_first_loss",
    );
  });

  it("supports the two-entry boundary without inventing a lower-bracket match", () => {
    const definition = createDoubleEliminationFormat(2);

    expect(validateFormatGraph(definition.graph)).toEqual({ valid: true, issues: [] });
    expect(definition.graph.stages.map((stage) => stage.id)).toEqual(["upper-bracket", "grand-final"]);
    expect(definition.metrics.minimumMatchCount).toBe(2);
    expect(definition.metrics.maximumMatchCount).toBe(3);
    expect(definition.metrics.guaranteedMatches).toBe(2);
  });

  it.each([0, 1, 1.5, Number.NaN])("rejects invalid entry count %s", (entryCount) => {
    expect(() => createDoubleEliminationFormat(entryCount)).toThrow(/at least two/);
  });

  it("builds a valid double-elimination format template", () => {
    const template = buildDoubleEliminationFormatTemplate(8);
    expect(template.id).toBe("8-double_elimination");
    expect(template.strategy).toBe("double_elimination");
    expect(template.metrics.matchCount).toBe(14);
    expect(template.metrics.guaranteedMatches).toBeGreaterThanOrEqual(2);
    expect(validateFormatGraph(template.graph)).toEqual({ valid: true, issues: [] });
  });

  it.each([8, 12, 16, 24, 48] as const)(
    "recommends double elimination via recommendCompetitionFormats for %i entries",
    (entryCount) => {
      const result = recommendCompetitionFormats({
        sportCode: "basketball",
        divisions: [{ id: `div-${entryCount}`, entryCount }],
        availableMatchSlots: 1000,
        priority: "participation",
      });
      const de = result.recommendations.find((item) => item.strategy === "double_elimination");
      expect(de).toBeDefined();
      expect(de?.capacityStatus).toBe("fits");
      expect(de?.guaranteedMatches).toBeGreaterThanOrEqual(2);
      expect(de?.matchCount).toBe(entryCount * 2 - 2);
    },
  );

  it("evaluates double elimination scheduling capacity with and without reset final", () => {
    const capacity8 = evaluateDoubleEliminationScheduleCapacity(8, 14);
    expect(capacity8.minimumSlotsRequired).toBe(14);
    expect(capacity8.maximumSlotsWithReset).toBe(15);
    expect(capacity8.fitsMinimum).toBe(true);
    expect(capacity8.fitsWithReset).toBe(false);

    const capacity8WithBuffer = evaluateDoubleEliminationScheduleCapacity(8, 15);
    expect(capacity8WithBuffer.fitsWithReset).toBe(true);
  });

  it("resolves progression when upper-bracket champion wins GF1 (no reset match required)", () => {
    const format = createDoubleEliminationFormat(4);
    const entryMap = new Map([
      [1, "team-1"],
      [2, "team-2"],
      [3, "team-3"],
      [4, "team-4"],
    ]);

    // upper-bracket-r1-m1: team-1 vs team-2 -> team-1 wins
    // upper-bracket-r1-m2: team-3 vs team-4 -> team-3 wins
    // upper-bracket-r2-m1 (upper final): team-1 vs team-3 -> team-1 wins (upper champion)
    // lower-r1-m1: team-2 vs team-4 -> team-2 wins
    // lower-r2-m1 (lower final): team-3 vs team-2 -> team-2 wins (lower champion)
    // grand-final-1: team-1 (home) vs team-2 (away) -> team-1 (upper champion) wins!
    const results = new Map([
      ["upper-bracket-r1-m1", { winnerEntryId: "team-1", loserEntryId: "team-2" }],
      ["upper-bracket-r1-m2", { winnerEntryId: "team-3", loserEntryId: "team-4" }],
      ["upper-bracket-r2-m1", { winnerEntryId: "team-1", loserEntryId: "team-3" }],
      ["lower-r1-m1", { winnerEntryId: "team-2", loserEntryId: "team-4" }],
      ["lower-r2-m1", { winnerEntryId: "team-2", loserEntryId: "team-3" }],
      [format.firstFinalMatchId, { winnerEntryId: "team-1", loserEntryId: "team-2" }],
    ]);

    const progression = resolveDoubleEliminationProgression(format, entryMap, results);
    expect(progression.isResetFinalRequired).toBe(false);
    expect(progression.championEntryId).toBe("team-1");
    expect(progression.runnerUpEntryId).toBe("team-2");
    expect(progression.resetFinalMatch).toBeNull();
  });

  it("resolves progression when lower-bracket champion wins GF1, activating GF2 reset match", () => {
    const format = createDoubleEliminationFormat(4);
    const entryMap = new Map([
      [1, "team-1"],
      [2, "team-2"],
      [3, "team-3"],
      [4, "team-4"],
    ]);

    // GF1: lower champion (team-2, away) defeats undefeated upper champion (team-1, home)
    const resultsWithGF1Loss = new Map([
      ["upper-bracket-r1-m1", { winnerEntryId: "team-1", loserEntryId: "team-2" }],
      ["upper-bracket-r1-m2", { winnerEntryId: "team-3", loserEntryId: "team-4" }],
      ["upper-bracket-r2-m1", { winnerEntryId: "team-1", loserEntryId: "team-3" }],
      ["lower-r1-m1", { winnerEntryId: "team-2", loserEntryId: "team-4" }],
      ["lower-r2-m1", { winnerEntryId: "team-2", loserEntryId: "team-3" }],
      [format.firstFinalMatchId, { winnerEntryId: "team-2", loserEntryId: "team-1" }],
    ]);

    const progressionBeforeGF2 = resolveDoubleEliminationProgression(format, entryMap, resultsWithGF1Loss);
    expect(progressionBeforeGF2.isResetFinalRequired).toBe(true);
    expect(progressionBeforeGF2.resetFinalMatch).not.toBeNull();
    expect(progressionBeforeGF2.resetFinalMatch?.state).toBe("scheduled");
    expect(progressionBeforeGF2.championEntryId).toBeNull(); // not decided yet!

    // Now GF2 is played: team-2 wins GF2 and becomes champion
    const resultsWithGF2 = new Map([
      ...resultsWithGF1Loss,
      [format.resetFinal.match.id, { winnerEntryId: "team-2", loserEntryId: "team-1" }],
    ]);

    const progressionAfterGF2 = resolveDoubleEliminationProgression(format, entryMap, resultsWithGF2);
    expect(progressionAfterGF2.isResetFinalRequired).toBe(true);
    expect(progressionAfterGF2.resetFinalMatch?.state).toBe("completed");
    expect(progressionAfterGF2.championEntryId).toBe("team-2");
    expect(progressionAfterGF2.runnerUpEntryId).toBe("team-1");
  });
});
