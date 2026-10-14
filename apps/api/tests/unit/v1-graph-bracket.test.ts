import { createDefaultFormatTemplates, type FormatGraph, type FormatParticipantSource } from "@matchday/domain";
import { describe, expect, it } from "vitest";
import { phase2DomainAdapter } from "../../src/phase-2-domain-adapter.js";

// The V1 graph templates have no legacy `groups` array, so the adapter resolves
// them through the canonical graph. Once the championship final is finalised,
// the bracket must name the champion (and the final's loser as runner-up).

type Result = {
  matchId: string;
  homeEntryId: string | null;
  awayEntryId: string | null;
  homeScore: number;
  awayScore: number;
  state: "final" | "corrected";
};

type Bracket = {
  matches: readonly {
    matchId: string;
    homeEntryId: string | null;
    awayEntryId: string | null;
    winnerEntryId?: string | null;
    loserEntryId?: string | null;
  }[];
  qualifiedEntryIds: readonly string[];
  championEntryId: string | null;
  runnerUpEntryId?: string | null;
};

const entries = Array.from({ length: 8 }, (_, index) => ({
  id: `entry-${index + 1}`,
  name: `Team ${index + 1}`,
  seed: index + 1,
}));

const templateGraph = (strategy: string): FormatGraph => {
  const template = createDefaultFormatTemplates(8).find((candidate) => candidate.graph.id.includes(strategy));
  if (!template) throw new Error(`Expected the ${strategy} default template`);
  return template.graph;
};

/**
 * Plays a whole graph: pools are ranked by seed (lower seed ranks higher) and
 * every knockout match is won by the home side. Returns the finalised results,
 * the graph-to-database id map and the completed pool rankings, exactly as the
 * runtime hands them to the adapter.
 */
function playGraph(graph: FormatGraph, options: { finalWinner?: "home" | "away"; finalDraw?: boolean } = {}) {
  const graphMatchIds = Object.fromEntries(graph.matches.map((match) => [match.id, `db-${match.id}`]));
  const groupRankings: Record<string, string[]> = {};
  for (const stage of graph.stages) {
    for (const [groupIndex, groupId] of stage.groupIds.entries()) {
      const size = stage.groupSize ?? 0;
      groupRankings[groupId] = entries.slice(groupIndex * size, groupIndex * size + size).map((entry) => entry.id);
    }
  }
  const results: Result[] = [];
  const resultByGraphId = new Map<string, Result>();
  const resolve = (source: FormatParticipantSource): string => {
    if (source.type === "entry_seed") return entries[source.seed - 1]!.id;
    if (source.type === "stage_rank") return groupRankings[source.groupId ?? source.stageId]![source.rank - 1]!;
    if (source.type === "winner" || source.type === "loser") {
      const result = resultByGraphId.get(source.matchId)!;
      const homeWon = result.homeScore > result.awayScore;
      return homeWon === (source.type === "winner") ? result.homeEntryId! : result.awayEntryId!;
    }
    throw new Error(`Unsupported source ${source.type}`);
  };
  const finalId = graph.matches.find((match) => match.purpose === "championship")!.id;
  // Template orders are dependency-ordered (bronze is round 1 but follows the semis).
  for (const match of [...graph.matches].sort((left, right) => left.order - right.order)) {
    if (match.purpose === "pool") {
      // Pool results only feed standings; rankings are supplied directly.
      continue;
    }
    const home = resolve(match.home);
    const away = resolve(match.away);
    const isFinal = match.id === finalId;
    const awayWins = isFinal && options.finalWinner === "away";
    const draw = isFinal && options.finalDraw === true;
    const result: Result = {
      matchId: graphMatchIds[match.id]!,
      homeEntryId: home,
      awayEntryId: away,
      homeScore: draw ? 1 : awayWins ? 0 : 3,
      awayScore: draw ? 1 : awayWins ? 3 : 0,
      state: "final",
    };
    results.push(result);
    resultByGraphId.set(match.id, result);
  }
  return { graphMatchIds, groupRankings, results, finalId, resultByGraphId };
}

const resolveBracket = (graph: FormatGraph, played: ReturnType<typeof playGraph>): Bracket =>
  phase2DomainAdapter.resolveBracket({
    format: graph as unknown as Record<string, unknown>,
    results: played.results,
    entries,
    graphMatchIds: played.graphMatchIds,
    groupRankings: played.groupRankings,
  }).bracket as Bracket;

describe("V1 graph bracket resolution", () => {
  for (const strategy of ["championship-focus", "full-placement", "compact-knockout"] as const) {
    it(`${strategy}: names the champion and runner-up once the final is finalised`, () => {
      const graph = templateGraph(strategy);
      const played = playGraph(graph);
      const bracket = resolveBracket(graph, played);
      const final = played.resultByGraphId.get(played.finalId)!;
      expect(bracket.championEntryId).toBe(final.homeEntryId);
      expect(bracket.runnerUpEntryId).toBe(final.awayEntryId);
      const resolvedFinal = bracket.matches.find((match) => match.matchId === final.matchId)!;
      expect(resolvedFinal).toMatchObject({
        homeEntryId: final.homeEntryId,
        awayEntryId: final.awayEntryId,
        winnerEntryId: final.homeEntryId,
        loserEntryId: final.awayEntryId,
      });
      // Every entry that reached a knockout match is a qualifier.
      expect(new Set(bracket.qualifiedEntryIds)).toEqual(
        new Set(played.results.flatMap((result) => [result.homeEntryId, result.awayEntryId])),
      );
    });

    it(`${strategy}: follows a corrected final and a walkover`, () => {
      const graph = templateGraph(strategy);
      const played = playGraph(graph, { finalWinner: "away" });
      const final = played.resultByGraphId.get(played.finalId)!;
      // A correction re-records the final with the away side winning.
      final.state = "corrected";
      const bracket = resolveBracket(graph, played);
      expect(bracket.championEntryId).toBe(final.awayEntryId);
      expect(bracket.runnerUpEntryId).toBe(final.homeEntryId);
      // A walkover is a forfeit score; the declared winner is champion.
      final.homeScore = 20;
      final.awayScore = 0;
      expect(resolveBracket(graph, played).championEntryId).toBe(final.homeEntryId);
    });
  }

  it("leaves the champion undecided before the final has a result or when it is drawn", () => {
    const graph = templateGraph("championship-focus");
    const played = playGraph(graph);
    const final = played.resultByGraphId.get(played.finalId)!;
    const withoutFinal = { ...played, results: played.results.filter((result) => result !== final) };
    expect(resolveBracket(graph, withoutFinal).championEntryId).toBeNull();
    expect(resolveBracket(graph, playGraph(graph, { finalDraw: true })).championEntryId).toBeNull();
  });
});
