import { describe, expect, it } from "vitest";
import {
  createDoubleEliminationFormat,
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

  it.each(DEFAULT_COUNTS)("eliminates lower-bracket losers and advances each lower winner for %i entries", (entryCount) => {
    const definition = createDoubleEliminationFormat(entryCount);
    const lower = definition.graph.matches.filter((match) => match.stageId === "lower-bracket");

    for (const match of lower) {
      expect(sourceUses(definition.graph.matches, `loser:${match.id}`)).toBe(0);
      expect(sourceUses(definition.graph.matches, `winner:${match.id}`)).toBe(1);
    }
  });

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
});
