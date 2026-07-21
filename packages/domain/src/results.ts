import type { CompetitionEntry, StandingsCriterion } from "./canoe-polo.js";
import type { BalancedCanoePoloFormat, MatchNode, MatchParticipantSource } from "./format.js";

export type CanoePoloResult = {
  matchId: string;
  homeEntryId: string;
  awayEntryId: string;
  homeGoals: number;
  awayGoals: number;
  homeDisciplinePoints?: number;
  awayDisciplinePoints?: number;
  status: "final" | "corrected";
  version: number;
};

export type StandingsConfig = {
  version: string;
  winPoints: number;
  drawPoints: number;
  lossPoints: number;
  criteria: readonly StandingsCriterion[];
};

export const DEFAULT_CANOE_POLO_STANDINGS_CONFIG: StandingsConfig = {
  version: "canoe-polo-standings-v1",
  winPoints: 3,
  drawPoints: 1,
  lossPoints: 0,
  criteria: ["points", "goal_difference", "goals_for", "head_to_head", "discipline", "seed"],
};

export type StandingsExplanation = {
  criterion: StandingsCriterion;
  value: number | string;
  summary: string;
};

export type StandingsRow = {
  rank: number;
  entryId: string;
  entryName: string;
  seed: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  disciplinePoints: number;
  explanations: readonly StandingsExplanation[];
};

type MutableRow = Omit<StandingsRow, "rank" | "goalDifference" | "explanations">;

function validateResult(result: CanoePoloResult, entries: ReadonlySet<string>): void {
  if (!result.matchId || !result.homeEntryId || !result.awayEntryId)
    throw new Error("Final result requires stable IDs");
  if (result.homeEntryId === result.awayEntryId) throw new Error(`Result ${result.matchId} uses the same entry twice`);
  if (!entries.has(result.homeEntryId) || !entries.has(result.awayEntryId)) {
    throw new Error(`Result ${result.matchId} references an unknown entry`);
  }
  if (
    !Number.isInteger(result.homeGoals) ||
    result.homeGoals < 0 ||
    !Number.isInteger(result.awayGoals) ||
    result.awayGoals < 0
  ) {
    throw new Error(`Result ${result.matchId} has an invalid score`);
  }
  if (!Number.isInteger(result.version) || result.version < 1)
    throw new Error(`Result ${result.matchId} has an invalid version`);
}

function pointsFor(
  row: MutableRow,
  opponent: MutableRow,
  ownGoals: number,
  opponentGoals: number,
  config: StandingsConfig,
): void {
  row.played += 1;
  row.goalsFor += ownGoals;
  row.goalsAgainst += opponentGoals;
  if (ownGoals > opponentGoals) {
    row.won += 1;
    row.points += config.winPoints;
  } else if (ownGoals === opponentGoals) {
    row.drawn += 1;
    row.points += config.drawPoints;
  } else {
    row.lost += 1;
    row.points += config.lossPoints;
  }
  void opponent;
}

function headToHeadPoints(
  leftId: string,
  opponentIds: ReadonlySet<string>,
  results: readonly CanoePoloResult[],
  config: StandingsConfig,
): number {
  let points = 0;
  for (const result of results) {
    const opponentId =
      result.homeEntryId === leftId ? result.awayEntryId : result.awayEntryId === leftId ? result.homeEntryId : null;
    if (!opponentId || !opponentIds.has(opponentId)) continue;
    const leftGoals = result.homeEntryId === leftId ? result.homeGoals : result.awayGoals;
    const rightGoals = result.homeEntryId === opponentId ? result.homeGoals : result.awayGoals;
    points +=
      leftGoals > rightGoals ? config.winPoints : leftGoals === rightGoals ? config.drawPoints : config.lossPoints;
  }
  return points;
}

function criterionComparison(
  criterion: StandingsCriterion,
  left: MutableRow,
  right: MutableRow,
  results: readonly CanoePoloResult[],
  config: StandingsConfig,
  allRows: readonly MutableRow[],
  precedingCriteria: readonly StandingsCriterion[],
): number {
  switch (criterion) {
    case "points":
      return right.points - left.points;
    case "goal_difference":
      return right.goalsFor - right.goalsAgainst - (left.goalsFor - left.goalsAgainst);
    case "goals_for":
      return right.goalsFor - left.goalsFor;
    case "head_to_head": {
      const tiedIds = new Set(
        allRows
          .filter((row) =>
            precedingCriteria.every((preceding) => criterionValue(preceding, row) === criterionValue(preceding, left)),
          )
          .map((row) => row.entryId),
      );
      return (
        headToHeadPoints(right.entryId, tiedIds, results, config) -
        headToHeadPoints(left.entryId, tiedIds, results, config)
      );
    }
    case "discipline":
      return left.disciplinePoints - right.disciplinePoints;
    case "seed":
      return left.seed - right.seed;
  }
}

function criterionValue(criterion: StandingsCriterion, row: MutableRow): number {
  switch (criterion) {
    case "points":
      return row.points;
    case "goal_difference":
      return row.goalsFor - row.goalsAgainst;
    case "goals_for":
      return row.goalsFor;
    case "discipline":
      return row.disciplinePoints;
    case "seed":
      return row.seed;
    case "head_to_head":
      return 0;
  }
}

export function calculateCanoePoloStandings(
  entries: readonly CompetitionEntry[],
  results: readonly CanoePoloResult[],
  config: StandingsConfig = DEFAULT_CANOE_POLO_STANDINGS_CONFIG,
): StandingsRow[] {
  if (
    !config.version ||
    new Set(config.criteria).size !== config.criteria.length ||
    config.criteria.at(-1) !== "seed"
  ) {
    throw new Error("Standings configuration must be versioned, unique, and end with a deterministic seed criterion");
  }
  const rows = new Map<string, MutableRow>();
  for (const entry of entries) {
    if (rows.has(entry.id)) throw new Error(`Duplicate standings entry ${entry.id}`);
    rows.set(entry.id, {
      entryId: entry.id,
      entryName: entry.name,
      seed: entry.seed,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
      disciplinePoints: 0,
    });
  }
  const matchIds = new Set<string>();
  for (const result of results) {
    validateResult(result, new Set(rows.keys()));
    if (matchIds.has(result.matchId)) throw new Error(`Multiple active results supplied for ${result.matchId}`);
    matchIds.add(result.matchId);
    const home = rows.get(result.homeEntryId);
    const away = rows.get(result.awayEntryId);
    if (!home || !away) throw new Error(`Result ${result.matchId} references an unknown entry`);
    pointsFor(home, away, result.homeGoals, result.awayGoals, config);
    pointsFor(away, home, result.awayGoals, result.homeGoals, config);
    home.disciplinePoints += result.homeDisciplinePoints ?? 0;
    away.disciplinePoints += result.awayDisciplinePoints ?? 0;
  }

  const allRows = [...rows.values()];
  const sorted = [...allRows].sort((left, right) => {
    for (let index = 0; index < config.criteria.length; index += 1) {
      const criterion = config.criteria[index];
      if (!criterion) continue;
      const comparison = criterionComparison(
        criterion,
        left,
        right,
        results,
        config,
        allRows,
        config.criteria.slice(0, index),
      );
      if (comparison !== 0) return comparison;
    }
    return left.entryId.localeCompare(right.entryId);
  });

  return sorted.map((row, index) => ({
    ...row,
    rank: index + 1,
    goalDifference: row.goalsFor - row.goalsAgainst,
    explanations: config.criteria.map((criterion) => {
      const value =
        criterion === "points"
          ? row.points
          : criterion === "goal_difference"
            ? row.goalsFor - row.goalsAgainst
            : criterion === "goals_for"
              ? row.goalsFor
              : criterion === "discipline"
                ? row.disciplinePoints
                : criterion === "seed"
                  ? row.seed
                  : "pairwise when tied";
      return { criterion, value, summary: `${criterion.replaceAll("_", " ")}: ${String(value)}` };
    }),
  }));
}

export type ResolvedBracketMatch = {
  matchId: string;
  stage: MatchNode["stage"];
  homeEntryId: string | null;
  awayEntryId: string | null;
  winnerEntryId: string | null;
  loserEntryId: string | null;
};

export type BracketResolution = {
  matches: readonly ResolvedBracketMatch[];
  qualifiedEntryIds: readonly string[];
  championEntryId: string | null;
};

export type CorrectionConflict = {
  correctedMatchId: string;
  downstreamMatchId: string;
  reason: "downstream_result_finalised" | "downstream_match_started";
};

export type DownstreamMatchState = "unstarted" | "started" | "finalised";

function resultWinner(result: CanoePoloResult): string | null {
  if (result.homeGoals === result.awayGoals) return null;
  return result.homeGoals > result.awayGoals ? result.homeEntryId : result.awayEntryId;
}

function resolveSource(
  source: MatchParticipantSource,
  results: ReadonlyMap<string, CanoePoloResult>,
  groupRankings: Readonly<Record<string, readonly string[]>>,
): string | null {
  switch (source.type) {
    case "entry":
      return source.entryId;
    case "group_rank":
      return groupRankings[source.groupId]?.[source.rank - 1] ?? null;
    case "winner": {
      const result = results.get(source.matchId);
      return result ? resultWinner(result) : null;
    }
    case "loser": {
      const result = results.get(source.matchId);
      if (!result) return null;
      const winner = resultWinner(result);
      if (!winner) return null;
      return winner === result.homeEntryId ? result.awayEntryId : result.homeEntryId;
    }
  }
}

export function resolveBracket(
  format: BalancedCanoePoloFormat,
  results: readonly CanoePoloResult[],
  groupRankings: Readonly<Record<string, readonly string[]>> = {},
): BracketResolution {
  const resultMap = new Map(results.map((result) => [result.matchId, result]));
  const resolved = format.matches
    .filter((match) => match.stage !== "group")
    .sort((left, right) => left.round - right.round || left.order - right.order)
    .map((match): ResolvedBracketMatch => {
      const homeEntryId = resolveSource(match.home, resultMap, groupRankings);
      const awayEntryId = resolveSource(match.away, resultMap, groupRankings);
      const result = resultMap.get(match.id);
      if (result && (result.homeEntryId !== homeEntryId || result.awayEntryId !== awayEntryId)) {
        throw new Error(`Result participants do not match resolved bracket for ${match.id}`);
      }
      const winnerEntryId = result ? resultWinner(result) : null;
      const loserEntryId =
        result && winnerEntryId
          ? winnerEntryId === result.homeEntryId
            ? result.awayEntryId
            : result.homeEntryId
          : null;
      return { matchId: match.id, stage: match.stage, homeEntryId, awayEntryId, winnerEntryId, loserEntryId };
    });
  const qualifiedEntryIds = [
    ...new Set(
      resolved.flatMap((match) => [match.homeEntryId, match.awayEntryId]).filter((id): id is string => id !== null),
    ),
  ];
  return {
    matches: resolved,
    qualifiedEntryIds,
    championEntryId: resolved.find((match) => match.stage === "final")?.winnerEntryId ?? null,
  };
}

export function detectCorrectionConflicts(
  format: BalancedCanoePoloFormat,
  results: readonly CanoePoloResult[],
  correctedMatchId: string,
  downstreamStates: Readonly<Record<string, DownstreamMatchState>> = {},
): CorrectionConflict[] {
  if (!format.matches.some((match) => match.id === correctedMatchId))
    throw new Error(`Unknown corrected match ${correctedMatchId}`);
  const descendants = new Set([correctedMatchId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of format.matches) {
      if (!descendants.has(match.id) && match.dependencyMatchIds.some((dependency) => descendants.has(dependency))) {
        descendants.add(match.id);
        changed = true;
      }
    }
  }
  const finalisedIds = new Set(
    results.filter((result) => result.matchId !== correctedMatchId).map((result) => result.matchId),
  );
  return [...descendants]
    .filter(
      (matchId) =>
        matchId !== correctedMatchId &&
        (finalisedIds.has(matchId) ||
          downstreamStates[matchId] === "started" ||
          downstreamStates[matchId] === "finalised"),
    )
    .map((downstreamMatchId) => ({
      correctedMatchId,
      downstreamMatchId,
      reason:
        finalisedIds.has(downstreamMatchId) || downstreamStates[downstreamMatchId] === "finalised"
          ? ("downstream_result_finalised" as const)
          : ("downstream_match_started" as const),
    }))
    .sort((left, right) => left.downstreamMatchId.localeCompare(right.downstreamMatchId));
}

// Phase 3 sport-neutral standings kernel. The Phase 2 Canoe Polo API above is
// intentionally retained: persisted Phase 2 projections depend on its shape.
export type StandingsSport = "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";

export type StandingsMetric =
  | "table_points"
  | "match_wins"
  | "score_difference"
  | "score_for"
  | "segment_difference"
  | "segment_ratio"
  | "score_ratio"
  | "head_to_head"
  | "discipline"
  | "seed";

export type StandingsParticipant = {
  id: string;
  name: string;
  seed: number;
  status?: "active" | "withdrawn";
};

export type StandingsMatchResult = {
  matchId: string;
  homeEntryId: string;
  awayEntryId: string;
  homeScore: number;
  awayScore: number;
  homeSegments?: readonly number[];
  awaySegments?: readonly number[];
  homeDisciplinePoints?: number;
  awayDisciplinePoints?: number;
  status: "final" | "corrected" | "forfeit";
  version: number;
  forfeitLoserEntryId?: string;
};

export type ForfeitScore = {
  homeScore: number;
  awayScore: number;
  homeSegments?: readonly number[];
  awaySegments?: readonly number[];
};

export type StandingsEngineConfig = {
  version: string;
  sport: StandingsSport;
  winPoints: number;
  drawPoints: number;
  lossPoints: number;
  criteria: readonly StandingsMetric[];
  headToHeadMetric: "table_points" | "match_wins";
  terminalFallback: "seed_then_entry_id" | "entry_id" | "unresolved";
  forfeitScore: ForfeitScore;
  withdrawalPolicy: "completed_results_stand" | "void_all_results";
};

function freezeStandingsConfig(config: StandingsEngineConfig): StandingsEngineConfig {
  const forfeitScore = Object.freeze({
    ...config.forfeitScore,
    ...(config.forfeitScore.homeSegments ? { homeSegments: Object.freeze([...config.forfeitScore.homeSegments]) } : {}),
    ...(config.forfeitScore.awaySegments ? { awaySegments: Object.freeze([...config.forfeitScore.awaySegments]) } : {}),
  });
  return Object.freeze({
    ...config,
    criteria: Object.freeze([...config.criteria]),
    forfeitScore,
  });
}

export const STANDINGS_SPORT_PACKS: Readonly<Record<StandingsSport, StandingsEngineConfig>> = Object.freeze({
  canoe_polo: freezeStandingsConfig({
    version: "canoe-polo-standings-v1",
    sport: "canoe_polo",
    winPoints: 3,
    drawPoints: 1,
    lossPoints: 0,
    criteria: ["table_points", "score_difference", "score_for", "head_to_head", "discipline"],
    headToHeadMetric: "table_points",
    terminalFallback: "unresolved",
    forfeitScore: { homeScore: 3, awayScore: 0 },
    withdrawalPolicy: "completed_results_stand",
  }),
  badminton: freezeStandingsConfig({
    version: "badminton-standings-v1",
    sport: "badminton",
    winPoints: 1,
    drawPoints: 0,
    lossPoints: 0,
    criteria: ["match_wins", "segment_difference", "score_difference", "head_to_head"],
    headToHeadMetric: "match_wins",
    terminalFallback: "unresolved",
    forfeitScore: { homeScore: 42, awayScore: 0, homeSegments: [21, 21], awaySegments: [0, 0] },
    withdrawalPolicy: "completed_results_stand",
  }),
  table_tennis: freezeStandingsConfig({
    version: "table-tennis-standings-v1",
    sport: "table_tennis",
    winPoints: 1,
    drawPoints: 0,
    lossPoints: 0,
    criteria: ["match_wins", "segment_difference", "score_difference", "head_to_head"],
    headToHeadMetric: "match_wins",
    terminalFallback: "unresolved",
    forfeitScore: { homeScore: 33, awayScore: 0, homeSegments: [11, 11, 11], awaySegments: [0, 0, 0] },
    withdrawalPolicy: "completed_results_stand",
  }),
  volleyball: freezeStandingsConfig({
    version: "volleyball-standings-v1",
    sport: "volleyball",
    winPoints: 1,
    drawPoints: 0,
    lossPoints: 0,
    criteria: ["match_wins", "segment_ratio", "score_ratio", "head_to_head"],
    headToHeadMetric: "match_wins",
    terminalFallback: "unresolved",
    forfeitScore: { homeScore: 50, awayScore: 0, homeSegments: [25, 25], awaySegments: [0, 0] },
    withdrawalPolicy: "completed_results_stand",
  }),
  basketball: freezeStandingsConfig({
    version: "basketball-standings-v1",
    sport: "basketball",
    winPoints: 1,
    drawPoints: 0,
    lossPoints: 0,
    criteria: ["match_wins", "head_to_head", "score_difference", "score_for"],
    headToHeadMetric: "match_wins",
    terminalFallback: "unresolved",
    forfeitScore: { homeScore: 20, awayScore: 0 },
    withdrawalPolicy: "completed_results_stand",
  }),
});

type Rational = {
  numerator: number;
  denominator: number;
  zeroDenominator: "finite" | "zero_over_zero" | "positive_infinity";
};

type RankedValue = { kind: "integer"; value: number } | { kind: "rational"; value: Rational };

export type StandingsCriterionTrace = {
  criterion: StandingsMetric | "terminal_fallback";
  value: number | string;
  comparedWithinEntryIds: readonly string[];
  summary: string;
};

export type ConfigurableStandingsRow = {
  rank: number;
  displayOrder: number;
  entryId: string;
  entryName: string;
  seed: number;
  status: "active" | "withdrawn";
  eligibleForAdvancement: boolean;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  tablePoints: number;
  scoreFor: number;
  scoreAgainst: number;
  scoreDifference: number;
  segmentsWon: number;
  segmentsLost: number;
  disciplinePoints: number;
  sportingTie: boolean;
  resolvedBy: StandingsMetric | "seed" | "entry_id" | "unresolved";
  explanations: readonly StandingsCriterionTrace[];
};

type EngineRow = Omit<
  ConfigurableStandingsRow,
  "rank" | "displayOrder" | "scoreDifference" | "sportingTie" | "resolvedBy" | "explanations"
> & {
  trace: StandingsCriterionTrace[];
};

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function validateEngineConfig(config: StandingsEngineConfig): void {
  if (!config.version) throw new Error("Standings engine configuration must be versioned");
  if (config.criteria.length === 0 || new Set(config.criteria).size !== config.criteria.length) {
    throw new Error("Standings criteria must be non-empty and unique");
  }
  for (const [label, value] of [
    ["winPoints", config.winPoints],
    ["drawPoints", config.drawPoints],
    ["lossPoints", config.lossPoints],
  ] as const) {
    assertNonNegativeInteger(value, label);
  }
  validateForfeitScore(config.forfeitScore);
}

function validateForfeitScore(score: ForfeitScore): void {
  assertNonNegativeInteger(score.homeScore, "Forfeit home score");
  assertNonNegativeInteger(score.awayScore, "Forfeit away score");
  if ((score.homeSegments === undefined) !== (score.awaySegments === undefined)) {
    throw new Error("Forfeit segment scores must be supplied for both entries");
  }
  if (score.homeSegments && score.awaySegments) {
    if (score.homeSegments.length !== score.awaySegments.length) {
      throw new Error("Forfeit segment score arrays must have equal length");
    }
    score.homeSegments.forEach((value, index) => assertNonNegativeInteger(value, `Forfeit home segment ${index}`));
    score.awaySegments.forEach((value, index) => assertNonNegativeInteger(value, `Forfeit away segment ${index}`));
  }
}

function validateStandingsResult(
  result: StandingsMatchResult,
  entryIds: ReadonlySet<string>,
  config: StandingsEngineConfig,
): void {
  if (!result.matchId || !result.homeEntryId || !result.awayEntryId) throw new Error("Result requires stable IDs");
  if (result.homeEntryId === result.awayEntryId) throw new Error(`Result ${result.matchId} uses the same entry twice`);
  if (!entryIds.has(result.homeEntryId) || !entryIds.has(result.awayEntryId)) {
    throw new Error(`Result ${result.matchId} references an unknown entry`);
  }
  assertNonNegativeInteger(result.homeScore, `Result ${result.matchId} home score`);
  assertNonNegativeInteger(result.awayScore, `Result ${result.matchId} away score`);
  assertNonNegativeInteger(result.homeDisciplinePoints ?? 0, `Result ${result.matchId} home discipline`);
  assertNonNegativeInteger(result.awayDisciplinePoints ?? 0, `Result ${result.matchId} away discipline`);
  if (!Number.isSafeInteger(result.version) || result.version < 1) {
    throw new Error(`Result ${result.matchId} has an invalid version`);
  }
  if ((result.homeSegments === undefined) !== (result.awaySegments === undefined)) {
    throw new Error(`Result ${result.matchId} must supply both segment score arrays`);
  }
  if (result.homeSegments && result.awaySegments) {
    if (result.homeSegments.length !== result.awaySegments.length) {
      throw new Error(`Result ${result.matchId} segment score arrays must have equal length`);
    }
    result.homeSegments.forEach((value, index) =>
      assertNonNegativeInteger(value, `Result ${result.matchId} home segment ${index}`),
    );
    result.awaySegments.forEach((value, index) =>
      assertNonNegativeInteger(value, `Result ${result.matchId} away segment ${index}`),
    );
    const homeTotal = result.homeSegments.reduce(
      (total, value) => safeAdd(total, value, `Result ${result.matchId} home segment total`),
      0,
    );
    const awayTotal = result.awaySegments.reduce(
      (total, value) => safeAdd(total, value, `Result ${result.matchId} away segment total`),
      0,
    );
    if (homeTotal !== result.homeScore || awayTotal !== result.awayScore) {
      throw new Error(`Result ${result.matchId} aggregate score must equal its segment totals`);
    }
  }
  if (
    (config.sport === "badminton" || config.sport === "table_tennis" || config.sport === "volleyball") &&
    (!result.homeSegments || result.homeSegments.length === 0)
  ) {
    throw new Error(`Result ${result.matchId} requires segment scores for ${config.sport}`);
  }
  if (result.status === "forfeit") {
    if (result.forfeitLoserEntryId !== result.homeEntryId && result.forfeitLoserEntryId !== result.awayEntryId) {
      throw new Error(`Forfeit result ${result.matchId} must identify a participating loser`);
    }
  } else if (result.forfeitLoserEntryId !== undefined) {
    throw new Error(`Non-forfeit result ${result.matchId} cannot identify a forfeit loser`);
  }
}

function segmentRecord(result: StandingsMatchResult): { homeWins: number; awayWins: number } {
  let homeWins = 0;
  let awayWins = 0;
  for (let index = 0; index < (result.homeSegments?.length ?? 0); index += 1) {
    const home = result.homeSegments?.[index];
    const away = result.awaySegments?.[index];
    if (home === undefined || away === undefined || home === away) continue;
    if (home > away) homeWins += 1;
    else awayWins += 1;
  }
  return { homeWins, awayWins };
}

function matchOutcome(result: StandingsMatchResult, config: StandingsEngineConfig): "home" | "away" | "draw" {
  if (config.sport === "badminton" || config.sport === "table_tennis" || config.sport === "volleyball") {
    const segments = segmentRecord(result);
    if (segments.homeWins > segments.awayWins) return "home";
    if (segments.homeWins < segments.awayWins) return "away";
  }
  if (result.homeScore > result.awayScore) return "home";
  if (result.homeScore < result.awayScore) return "away";
  return "draw";
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe integer range`);
  return result;
}

function addResultToRows(
  home: EngineRow,
  away: EngineRow,
  result: StandingsMatchResult,
  config: StandingsEngineConfig,
): void {
  const segments = segmentRecord(result);
  home.played += 1;
  away.played += 1;
  home.scoreFor = safeAdd(home.scoreFor, result.homeScore, `${home.entryId} score for`);
  home.scoreAgainst = safeAdd(home.scoreAgainst, result.awayScore, `${home.entryId} score against`);
  away.scoreFor = safeAdd(away.scoreFor, result.awayScore, `${away.entryId} score for`);
  away.scoreAgainst = safeAdd(away.scoreAgainst, result.homeScore, `${away.entryId} score against`);
  home.segmentsWon += segments.homeWins;
  home.segmentsLost += segments.awayWins;
  away.segmentsWon += segments.awayWins;
  away.segmentsLost += segments.homeWins;
  home.disciplinePoints += result.homeDisciplinePoints ?? 0;
  away.disciplinePoints += result.awayDisciplinePoints ?? 0;
  const outcome = matchOutcome(result, config);
  if (outcome === "home") {
    home.won += 1;
    away.lost += 1;
    home.tablePoints += config.winPoints;
    away.tablePoints += config.lossPoints;
  } else if (outcome === "away") {
    away.won += 1;
    home.lost += 1;
    away.tablePoints += config.winPoints;
    home.tablePoints += config.lossPoints;
  } else {
    home.drawn += 1;
    away.drawn += 1;
    home.tablePoints += config.drawPoints;
    away.tablePoints += config.drawPoints;
  }
}

function rational(numerator: number, denominator: number): Rational {
  if (denominator === 0) {
    return numerator === 0
      ? { numerator: 0, denominator: 1, zeroDenominator: "zero_over_zero" }
      : { numerator, denominator: 0, zeroDenominator: "positive_infinity" };
  }
  return { numerator, denominator, zeroDenominator: "finite" };
}

function compareRational(left: Rational, right: Rational): number {
  if (left.zeroDenominator === "positive_infinity") {
    return right.zeroDenominator === "positive_infinity" ? 0 : 1;
  }
  if (right.zeroDenominator === "positive_infinity") return -1;
  const crossLeft = BigInt(left.numerator) * BigInt(right.denominator);
  const crossRight = BigInt(right.numerator) * BigInt(left.denominator);
  return crossLeft === crossRight ? 0 : crossLeft > crossRight ? 1 : -1;
}

function compareRankedValue(left: RankedValue, right: RankedValue, lowerIsBetter: boolean): number {
  const comparison =
    left.kind === "integer" && right.kind === "integer"
      ? left.value === right.value
        ? 0
        : left.value > right.value
          ? 1
          : -1
      : compareRational(
          left.kind === "rational" ? left.value : rational(left.value, 1),
          right.kind === "rational" ? right.value : rational(right.value, 1),
        );
  return lowerIsBetter ? -comparison : comparison;
}

function valueKey(value: RankedValue): string {
  if (value.kind === "integer") return `i:${value.value}`;
  if (value.value.zeroDenominator === "positive_infinity") return "r:+infinity";
  const numerator = BigInt(value.value.numerator);
  const denominator = BigInt(value.value.denominator);
  const divisor = greatestCommonDivisor(numerator < 0n ? -numerator : numerator, denominator);
  return `r:${numerator / divisor}/${denominator / divisor}`;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function displayRankedValue(value: RankedValue): number | string {
  if (value.kind === "integer") return value.value;
  if (value.value.zeroDenominator === "positive_infinity") return "+infinity";
  const suffix = value.value.zeroDenominator === "zero_over_zero" ? " (0/0 defined as 0)" : "";
  return `${value.value.numerator}/${value.value.denominator}${suffix}`;
}

function headToHeadValue(
  row: EngineRow,
  scope: readonly EngineRow[],
  results: readonly StandingsMatchResult[],
  config: StandingsEngineConfig,
): RankedValue {
  const ids = new Set(scope.map((candidate) => candidate.entryId));
  let value = 0;
  for (const result of results) {
    if (!ids.has(result.homeEntryId) || !ids.has(result.awayEntryId)) continue;
    const isHome = result.homeEntryId === row.entryId;
    const isAway = result.awayEntryId === row.entryId;
    if (!isHome && !isAway) continue;
    const outcome = matchOutcome(result, config);
    const won = (isHome && outcome === "home") || (isAway && outcome === "away");
    const drawn = outcome === "draw";
    if (config.headToHeadMetric === "match_wins") value += won ? 1 : 0;
    else value += won ? config.winPoints : drawn ? config.drawPoints : config.lossPoints;
  }
  return { kind: "integer", value };
}

function metricValue(
  metric: StandingsMetric,
  row: EngineRow,
  scope: readonly EngineRow[],
  results: readonly StandingsMatchResult[],
  config: StandingsEngineConfig,
): RankedValue {
  switch (metric) {
    case "table_points":
      return { kind: "integer", value: row.tablePoints };
    case "match_wins":
      return { kind: "integer", value: row.won };
    case "score_difference":
      return { kind: "integer", value: row.scoreFor - row.scoreAgainst };
    case "score_for":
      return { kind: "integer", value: row.scoreFor };
    case "segment_difference":
      return { kind: "integer", value: row.segmentsWon - row.segmentsLost };
    case "segment_ratio":
      return { kind: "rational", value: rational(row.segmentsWon, row.segmentsLost) };
    case "score_ratio":
      return { kind: "rational", value: rational(row.scoreFor, row.scoreAgainst) };
    case "head_to_head":
      return headToHeadValue(row, scope, results, config);
    case "discipline":
      return { kind: "integer", value: row.disciplinePoints };
    case "seed":
      return { kind: "integer", value: row.seed };
  }
}

function refineTiedGroups(
  groups: readonly (readonly EngineRow[])[],
  criterion: StandingsMetric,
  results: readonly StandingsMatchResult[],
  config: StandingsEngineConfig,
  resolvedBy: Map<string, ConfigurableStandingsRow["resolvedBy"]>,
): EngineRow[][] {
  const refined: EngineRow[][] = [];
  for (const group of groups) {
    const scopeIds = [...group.map((row) => row.entryId)].sort();
    const buckets = new Map<string, { value: RankedValue; rows: EngineRow[] }>();
    for (const row of group) {
      const value = metricValue(criterion, row, group, results, config);
      row.trace.push({
        criterion,
        value: displayRankedValue(value),
        comparedWithinEntryIds: scopeIds,
        summary:
          criterion === "head_to_head"
            ? `${config.headToHeadMetric.replaceAll("_", " ")} from matches only among the tied entries`
            : `${criterion.replaceAll("_", " ")}: ${String(displayRankedValue(value))}`,
      });
      const bucket = buckets.get(valueKey(value));
      if (bucket) bucket.rows.push(row);
      else buckets.set(valueKey(value), { value, rows: [row] });
    }
    const lowerIsBetter = criterion === "discipline" || criterion === "seed";
    const orderedBuckets = [...buckets.values()].sort(
      (left, right) => -compareRankedValue(left.value, right.value, lowerIsBetter),
    );
    if (group.length > 1 && orderedBuckets.length > 1) {
      for (const bucket of orderedBuckets) {
        if (bucket.rows.length === 1 && !resolvedBy.has(bucket.rows[0]!.entryId)) {
          resolvedBy.set(bucket.rows[0]!.entryId, criterion);
        }
      }
    }
    refined.push(...orderedBuckets.map((bucket) => bucket.rows));
  }
  return refined;
}

export function calculateStandings(
  entries: readonly StandingsParticipant[],
  results: readonly StandingsMatchResult[],
  config: StandingsEngineConfig,
): ConfigurableStandingsRow[] {
  validateEngineConfig(config);
  const rows = new Map<string, EngineRow>();
  for (const entry of entries) {
    if (!entry.id || !entry.name) throw new Error("Standings entries require stable IDs and names");
    assertNonNegativeInteger(entry.seed, `Seed for ${entry.id}`);
    if (rows.has(entry.id)) throw new Error(`Duplicate standings entry ${entry.id}`);
    rows.set(entry.id, {
      entryId: entry.id,
      entryName: entry.name,
      seed: entry.seed,
      status: entry.status ?? "active",
      eligibleForAdvancement: (entry.status ?? "active") === "active",
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      tablePoints: 0,
      scoreFor: 0,
      scoreAgainst: 0,
      segmentsWon: 0,
      segmentsLost: 0,
      disciplinePoints: 0,
      trace: [],
    });
  }
  const ids = new Set(rows.keys());
  const resultIds = new Set<string>();
  for (const result of results) {
    validateStandingsResult(result, ids, config);
    if (resultIds.has(result.matchId)) throw new Error(`Multiple active results supplied for ${result.matchId}`);
    resultIds.add(result.matchId);
    const home = rows.get(result.homeEntryId);
    const away = rows.get(result.awayEntryId);
    if (!home || !away) throw new Error(`Result ${result.matchId} references an unknown entry`);
    addResultToRows(home, away, result, config);
  }

  let groups: EngineRow[][] = [[...rows.values()]];
  const resolvedBy = new Map<string, ConfigurableStandingsRow["resolvedBy"]>();
  for (const criterion of config.criteria) {
    groups = refineTiedGroups(groups, criterion, results, config, resolvedBy);
  }
  const sportingTies = new Set(
    groups.filter((group) => group.length > 1).flatMap((group) => group.map((row) => row.entryId)),
  );
  for (const group of groups) {
    if (group.length === 1) {
      if (!resolvedBy.has(group[0]!.entryId)) {
        resolvedBy.set(group[0]!.entryId, config.criteria.at(-1) ?? "unresolved");
      }
      continue;
    }
    if (config.terminalFallback === "unresolved") {
      group.sort((left, right) => left.entryId.localeCompare(right.entryId));
      for (const row of group) resolvedBy.set(row.entryId, "unresolved");
    } else {
      group.sort((left, right) =>
        config.terminalFallback === "seed_then_entry_id"
          ? left.seed - right.seed || left.entryId.localeCompare(right.entryId)
          : left.entryId.localeCompare(right.entryId),
      );
      for (const row of group)
        resolvedBy.set(row.entryId, config.terminalFallback === "entry_id" ? "entry_id" : "seed");
    }
    const scopeIds = group.map((row) => row.entryId).sort();
    for (const row of group) {
      row.trace.push({
        criterion: "terminal_fallback",
        value: resolvedBy.get(row.entryId) ?? "unresolved",
        comparedWithinEntryIds: scopeIds,
        summary: `Deterministic terminal policy: ${config.terminalFallback.replaceAll("_", " ")}`,
      });
    }
  }

  const output: ConfigurableStandingsRow[] = [];
  let displayOrder = 1;
  let nextRank = 1;
  for (const group of groups) {
    const unresolvedGroup = group.length > 1 && group.every((row) => resolvedBy.get(row.entryId) === "unresolved");
    group.forEach((row, groupIndex) => {
      const resolution = resolvedBy.get(row.entryId) ?? config.criteria.at(-1) ?? "unresolved";
      output.push({
        rank: unresolvedGroup ? nextRank : nextRank + groupIndex,
        displayOrder,
        entryId: row.entryId,
        entryName: row.entryName,
        seed: row.seed,
        status: row.status,
        eligibleForAdvancement: row.eligibleForAdvancement && resolution !== "unresolved",
        played: row.played,
        won: row.won,
        drawn: row.drawn,
        lost: row.lost,
        tablePoints: row.tablePoints,
        scoreFor: row.scoreFor,
        scoreAgainst: row.scoreAgainst,
        scoreDifference: row.scoreFor - row.scoreAgainst,
        segmentsWon: row.segmentsWon,
        segmentsLost: row.segmentsLost,
        disciplinePoints: row.disciplinePoints,
        sportingTie: sportingTies.has(row.entryId),
        resolvedBy: resolution,
        explanations: row.trace,
      });
      displayOrder += 1;
    });
    nextRank += group.length;
  }
  return output;
}

export type ScheduledStandingsMatch = {
  matchId: string;
  homeEntryId: string;
  awayEntryId: string;
};

export type WithdrawalDirective = {
  entryId: string;
  replacement?: StandingsParticipant;
};

export type WithdrawalApplication = {
  entries: readonly StandingsParticipant[];
  results: readonly StandingsMatchResult[];
  futureMatches: readonly ScheduledStandingsMatch[];
  generatedForfeitMatchIds: readonly string[];
  explanation: string;
};

function forfeitResult(
  match: ScheduledStandingsMatch,
  loserEntryId: string,
  config: StandingsEngineConfig,
): StandingsMatchResult {
  const loserIsHome = match.homeEntryId === loserEntryId;
  const score = config.forfeitScore;
  const winnerScore = score.homeScore;
  const loserScore = score.awayScore;
  const winnerSegments = score.homeSegments;
  const loserSegments = score.awaySegments;
  return {
    matchId: match.matchId,
    homeEntryId: match.homeEntryId,
    awayEntryId: match.awayEntryId,
    homeScore: loserIsHome ? loserScore : winnerScore,
    awayScore: loserIsHome ? winnerScore : loserScore,
    ...(winnerSegments && loserSegments
      ? {
          homeSegments: loserIsHome ? loserSegments : winnerSegments,
          awaySegments: loserIsHome ? winnerSegments : loserSegments,
        }
      : {}),
    status: "forfeit",
    version: 1,
    forfeitLoserEntryId: loserEntryId,
  };
}

export function applyWithdrawalPolicy(
  entries: readonly StandingsParticipant[],
  results: readonly StandingsMatchResult[],
  scheduledMatches: readonly ScheduledStandingsMatch[],
  directive: WithdrawalDirective,
  config: StandingsEngineConfig,
): WithdrawalApplication {
  validateEngineConfig(config);
  if (!entries.some((entry) => entry.id === directive.entryId))
    throw new Error(`Unknown withdrawn entry ${directive.entryId}`);
  if (directive.replacement && entries.some((entry) => entry.id === directive.replacement?.id)) {
    throw new Error(`Replacement entry ${directive.replacement.id} already exists`);
  }
  const completedMatchIds = new Set(results.map((result) => result.matchId));
  const retainedResults =
    config.withdrawalPolicy === "void_all_results"
      ? results.filter((result) => result.homeEntryId !== directive.entryId && result.awayEntryId !== directive.entryId)
      : [...results];
  const markedEntries = entries.map((entry) =>
    entry.id === directive.entryId ? { ...entry, status: "withdrawn" as const } : entry,
  );
  const pendingAffected = scheduledMatches.filter(
    (match) =>
      !completedMatchIds.has(match.matchId) &&
      (match.homeEntryId === directive.entryId || match.awayEntryId === directive.entryId),
  );
  if (directive.replacement) {
    const futureMatches = scheduledMatches.map((match) =>
      completedMatchIds.has(match.matchId)
        ? match
        : {
            ...match,
            homeEntryId: match.homeEntryId === directive.entryId ? directive.replacement!.id : match.homeEntryId,
            awayEntryId: match.awayEntryId === directive.entryId ? directive.replacement!.id : match.awayEntryId,
          },
    );
    return {
      entries: [...markedEntries, { ...directive.replacement, status: "active" }],
      results: retainedResults,
      futureMatches,
      generatedForfeitMatchIds: [],
      explanation: `Completed results ${config.withdrawalPolicy === "completed_results_stand" ? "stand" : "were voided"}; replacement ${directive.replacement.id} assumes future fixtures only`,
    };
  }
  const generated = pendingAffected.map((match) => forfeitResult(match, directive.entryId, config));
  return {
    entries: markedEntries,
    results: [...retainedResults, ...generated],
    futureMatches: scheduledMatches,
    generatedForfeitMatchIds: generated.map((result) => result.matchId),
    explanation: `Completed results ${config.withdrawalPolicy === "completed_results_stand" ? "stand" : "were voided"}; ${generated.length} remaining fixture(s) became versioned sport-pack forfeits`,
  };
}

export type CrossGroupCriterion =
  "table_points_per_match" | "wins_per_match" | "score_difference_per_match" | "score_for_per_match" | "seed";

export type CrossGroupCandidate = {
  groupId: string;
  row: ConfigurableStandingsRow;
  groupComplete: boolean;
};

export type CrossGroupComparisonConfig = {
  criteria: readonly CrossGroupCriterion[];
  incompleteGroupPolicy: "provisional" | "exclude" | "reject";
};

export type CrossGroupStanding = {
  rank: number;
  displayOrder: number;
  groupId: string;
  entryId: string;
  provisional: boolean;
  resolved: boolean;
  explanations: readonly { criterion: CrossGroupCriterion; value: number | string }[];
};

function crossGroupValue(criterion: CrossGroupCriterion, row: ConfigurableStandingsRow): RankedValue {
  switch (criterion) {
    case "table_points_per_match":
      return { kind: "rational", value: rational(row.tablePoints, row.played) };
    case "wins_per_match":
      return { kind: "rational", value: rational(row.won, row.played) };
    case "score_difference_per_match":
      return { kind: "rational", value: rational(row.scoreDifference, row.played) };
    case "score_for_per_match":
      return { kind: "rational", value: rational(row.scoreFor, row.played) };
    case "seed":
      return { kind: "integer", value: row.seed };
  }
}

export function compareAcrossGroups(
  candidates: readonly CrossGroupCandidate[],
  config: CrossGroupComparisonConfig,
): CrossGroupStanding[] {
  if (config.criteria.length === 0 || new Set(config.criteria).size !== config.criteria.length) {
    throw new Error("Cross-group criteria must be non-empty and unique");
  }
  const eligibleCandidates = candidates.filter(
    (candidate) =>
      candidate.row.status === "active" &&
      candidate.row.eligibleForAdvancement &&
      candidate.row.resolvedBy !== "unresolved",
  );
  if (config.incompleteGroupPolicy === "reject" && eligibleCandidates.some((candidate) => !candidate.groupComplete)) {
    throw new Error("Cross-group comparison requires complete groups");
  }
  const included =
    config.incompleteGroupPolicy === "exclude"
      ? eligibleCandidates.filter((candidate) => candidate.groupComplete)
      : eligibleCandidates;
  const sportingComparison = (left: CrossGroupCandidate, right: CrossGroupCandidate): number => {
    for (const criterion of config.criteria) {
      const comparison = compareRankedValue(
        crossGroupValue(criterion, left.row),
        crossGroupValue(criterion, right.row),
        criterion === "seed",
      );
      if (comparison !== 0) return -comparison;
    }
    return 0;
  };
  const sorted = [...included].sort((left, right) => {
    const comparison = sportingComparison(left, right);
    if (comparison !== 0) return comparison;
    return left.row.entryId.localeCompare(right.row.entryId) || left.groupId.localeCompare(right.groupId);
  });
  return sorted.map((candidate, index) => {
    const tiedWithPrevious = index > 0 && sportingComparison(sorted[index - 1]!, candidate) === 0;
    const tiedWithNext = index + 1 < sorted.length && sportingComparison(candidate, sorted[index + 1]!) === 0;
    const previousRank =
      index > 0 ? sorted.slice(0, index).findLastIndex((value) => sportingComparison(value, candidate) !== 0) + 2 : 1;
    return {
      rank: tiedWithPrevious ? previousRank : index + 1,
      displayOrder: index + 1,
      groupId: candidate.groupId,
      entryId: candidate.row.entryId,
      provisional: !candidate.groupComplete,
      resolved: !tiedWithPrevious && !tiedWithNext,
      explanations: config.criteria.map((criterion) => ({
        criterion,
        value: displayRankedValue(crossGroupValue(criterion, candidate.row)),
      })),
    };
  });
}

export type StandingsSnapshot = {
  snapshotId: string;
  competitionId: string;
  divisionId: string;
  groupId: string;
  resultVersion: number;
  configVersion: string;
  calculatedAt: string;
  fingerprint: string;
  rows: readonly ConfigurableStandingsRow[];
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function fingerprint(value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of canonical(value)) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function createStandingsSnapshot(input: {
  competitionId: string;
  divisionId: string;
  groupId: string;
  resultVersion: number;
  configVersion: string;
  calculatedAt: string;
  rows: readonly ConfigurableStandingsRow[];
}): StandingsSnapshot {
  if (!input.competitionId || !input.divisionId || !input.groupId || !input.configVersion) {
    throw new Error("Standings snapshot requires stable scope and configuration IDs");
  }
  if (!Number.isSafeInteger(input.resultVersion) || input.resultVersion < 1) {
    throw new Error("Standings snapshot result version must be positive");
  }
  if (Number.isNaN(Date.parse(input.calculatedAt))) throw new Error("Standings snapshot requires an ISO timestamp");
  const rows = input.rows.map((row) => ({
    ...row,
    explanations: row.explanations.map((explanation) => ({
      ...explanation,
      comparedWithinEntryIds: [...explanation.comparedWithinEntryIds],
    })),
  }));
  const digest = fingerprint({
    competitionId: input.competitionId,
    divisionId: input.divisionId,
    groupId: input.groupId,
    resultVersion: input.resultVersion,
    configVersion: input.configVersion,
    rows,
  });
  return deepFreeze({
    snapshotId: `standings-${input.resultVersion}-${digest}`,
    ...input,
    fingerprint: digest,
    rows,
  }) as StandingsSnapshot;
}

export type AdvancementSource =
  { type: "group_rank"; groupId: string; rank: number } | { type: "cross_group_rank"; rank: number };

export type AdvancementRule = {
  ruleId: string;
  source: AdvancementSource;
  targetSlotId: string;
};

export type AdvancementSlot = {
  slotId: string;
  entryId: string | null;
  control: "manual" | "automatic";
  controlledByRuleId?: string;
  sourceFingerprint?: string;
};

export type AdvancementResolution = {
  slots: readonly AdvancementSlot[];
  changes: readonly { slotId: string; previousEntryId: string | null; entryId: string | null }[];
  conflicts: readonly { ruleId: string; targetSlotId: string; reason: string }[];
};

export function applyAutomaticAdvancement(input: {
  rules: readonly AdvancementRule[];
  groupSnapshots: Readonly<Record<string, StandingsSnapshot>>;
  crossGroupStandings?: readonly CrossGroupStanding[];
  currentSlots: readonly AdvancementSlot[];
}): AdvancementResolution {
  const slots = input.currentSlots.map((slot) => ({ ...slot }));
  const slotMap = new Map(slots.map((slot) => [slot.slotId, slot]));
  const changes: AdvancementResolution["changes"][number][] = [];
  const conflicts: AdvancementResolution["conflicts"][number][] = [];
  const ruleIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const rule of input.rules) {
    if (!rule.ruleId || ruleIds.has(rule.ruleId)) throw new Error(`Duplicate or empty advancement rule ${rule.ruleId}`);
    if (targetIds.has(rule.targetSlotId)) throw new Error(`Multiple advancement rules control ${rule.targetSlotId}`);
    ruleIds.add(rule.ruleId);
    targetIds.add(rule.targetSlotId);
    if (!Number.isSafeInteger(rule.source.rank) || rule.source.rank < 1) {
      throw new Error(`Advancement rule ${rule.ruleId} requires a positive source rank`);
    }
    const slot = slotMap.get(rule.targetSlotId);
    if (!slot) {
      conflicts.push({ ruleId: rule.ruleId, targetSlotId: rule.targetSlotId, reason: "target_slot_missing" });
      continue;
    }
    if (slot.control === "manual" || (slot.controlledByRuleId && slot.controlledByRuleId !== rule.ruleId)) {
      conflicts.push({
        ruleId: rule.ruleId,
        targetSlotId: rule.targetSlotId,
        reason: "target_slot_not_controlled_by_rule",
      });
      continue;
    }
    const invalidateSource = (reason: string): void => {
      if (slot.entryId !== null) {
        changes.push({ slotId: slot.slotId, previousEntryId: slot.entryId, entryId: null });
      }
      slot.entryId = null;
      slot.control = "automatic";
      slot.controlledByRuleId = rule.ruleId;
      delete slot.sourceFingerprint;
      conflicts.push({ ruleId: rule.ruleId, targetSlotId: rule.targetSlotId, reason });
    };
    let entryId: string | undefined;
    let sourceFingerprint: string | undefined;
    if (rule.source.type === "group_rank") {
      const snapshot = input.groupSnapshots[rule.source.groupId];
      const activeRows = snapshot?.rows.filter((row) => row.status === "active") ?? [];
      const row = activeRows[rule.source.rank - 1];
      if (row?.resolvedBy === "unresolved") {
        invalidateSource("source_tie_unresolved");
        continue;
      }
      entryId = row?.eligibleForAdvancement ? row.entryId : undefined;
      sourceFingerprint = snapshot?.fingerprint;
    } else {
      const candidate = input.crossGroupStandings?.[rule.source.rank - 1];
      if (candidate?.provisional) {
        invalidateSource("source_group_incomplete");
        continue;
      }
      if (candidate && !candidate.resolved) {
        invalidateSource("source_tie_unresolved");
        continue;
      }
      entryId = candidate?.entryId;
      sourceFingerprint = fingerprint(input.crossGroupStandings ?? []);
    }
    if (!entryId) {
      invalidateSource("source_rank_unavailable");
      continue;
    }
    if (slot.entryId !== entryId) changes.push({ slotId: slot.slotId, previousEntryId: slot.entryId, entryId });
    slot.entryId = entryId;
    slot.control = "automatic";
    slot.controlledByRuleId = rule.ruleId;
    if (sourceFingerprint !== undefined) slot.sourceFingerprint = sourceFingerprint;
  }
  return { slots: deepFreeze(slots), changes: deepFreeze(changes), conflicts: deepFreeze(conflicts) };
}
