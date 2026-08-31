import {
  assertValidFormatGraph,
  calculateFormatMetrics,
  type FormatGraph,
  type FormatGraphMatch,
  type FormatParticipantSource,
  type FormatTemplate,
} from "./format.js";

export type DoubleEliminationResetFinal = Readonly<{
  match: FormatGraphMatch;
  requiredWhen: Readonly<{
    matchId: string;
    winnerSlot: "away";
    reason: "lower_bracket_champion_hands_upper_bracket_champion_first_loss";
  }>;
}>;

export type DoubleEliminationFormatMetrics = Readonly<{
  minimumMatchCount: number;
  maximumMatchCount: number;
  guaranteedMatches: number;
  maximumParticipantMatches: number;
}>;

export type DoubleEliminationFormat = Readonly<{
  graph: FormatGraph;
  upperFinalMatchId: string;
  firstFinalMatchId: string;
  resetFinal: DoubleEliminationResetFinal;
  metrics: DoubleEliminationFormatMetrics;
}>;

type EliminationRounds = Readonly<{
  matches: readonly FormatGraphMatch[];
  rounds: readonly (readonly string[])[];
  winner: FormatParticipantSource;
  finalMatchId: string;
  nextOrder: number;
}>;

function freezeDeep<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function createEliminationRounds(
  input: Readonly<{
    sources: readonly FormatParticipantSource[];
    stageId: string;
    orderStart: number;
    purpose: FormatGraphMatch["purpose"];
  }>,
): EliminationRounds {
  if (input.sources.length < 2) throw new Error(`${input.stageId} requires at least two participants`);
  let current = [...input.sources];
  const matches: FormatGraphMatch[] = [];
  const rounds: string[][] = [];
  let round = 1;

  while (current.length > 1) {
    const next: FormatParticipantSource[] = [];
    const roundIds: string[] = [];
    let matchInRound = 1;
    for (let index = 0; index < current.length; index += 2) {
      const home = current[index];
      const away = current[index + 1];
      if (!home) throw new Error(`Unable to seed ${input.stageId}`);
      if (!away) {
        next.push(home);
        continue;
      }
      const id = `${input.stageId}-r${round}-m${matchInRound++}`;
      matches.push({
        id,
        stageId: input.stageId,
        round,
        order: input.orderStart + matches.length,
        purpose: input.purpose,
        home,
        away,
      });
      roundIds.push(id);
      next.push({ type: "winner", matchId: id });
    }
    if (roundIds.length > 0) rounds.push(roundIds);
    current = next;
    round += 1;
  }

  const winner = current[0];
  const finalMatchId = matches.at(-1)?.id;
  if (!winner || !finalMatchId) throw new Error(`${input.stageId} did not produce a final`);
  return {
    matches,
    rounds,
    winner,
    finalMatchId,
    nextOrder: input.orderStart + matches.length,
  };
}

function lowerBracket(
  input: Readonly<{
    upperRounds: readonly (readonly string[])[];
    orderStart: number;
  }>,
): Readonly<{
  matches: readonly FormatGraphMatch[];
  winner: FormatParticipantSource;
  nextOrder: number;
}> {
  const matches: FormatGraphMatch[] = [];
  let survivor: FormatParticipantSource | null = null;
  let lowerRound = 1;

  for (const upperRound of input.upperRounds) {
    let current: FormatParticipantSource[] = [
      ...(survivor ? [survivor] : []),
      ...upperRound.map((matchId): FormatParticipantSource => ({ type: "loser", matchId })),
    ];

    while (current.length > 1) {
      const next: FormatParticipantSource[] = [];
      let matchInRound = 1;
      for (let index = 0; index < current.length; index += 2) {
        const home = current[index];
        const away = current[index + 1];
        if (!home) throw new Error("Unable to seed lower bracket");
        if (!away) {
          next.push(home);
          continue;
        }
        const id = `lower-r${lowerRound}-m${matchInRound++}`;
        matches.push({
          id,
          stageId: "lower-bracket",
          round: lowerRound,
          order: input.orderStart + matches.length,
          purpose: "progression",
          home,
          away,
        });
        next.push({ type: "winner", matchId: id });
      }
      current = next;
      lowerRound += 1;
    }
    survivor = current[0] ?? survivor;
  }

  if (!survivor) throw new Error("Double elimination lower bracket did not produce a finalist");
  return {
    matches,
    winner: survivor,
    nextOrder: input.orderStart + matches.length,
  };
}

/**
 * Build a deterministic double-elimination definition for any entry count >= 2.
 *
 * The persisted FormatGraph contains the guaranteed bracket through the first
 * grand final. The possible reset final is deliberately kept as an explicit
 * conditional match outside the graph because the existing scheduler
 * materialises every graph match. This prevents an if-required reset from being
 * silently scheduled when the undefeated upper-bracket champion wins the first
 * final. The reset becomes required only when the lower-bracket champion (the
 * away slot in grand-final-1) wins that match.
 */
export function createDoubleEliminationFormat(entryCount: number): DoubleEliminationFormat {
  if (!Number.isSafeInteger(entryCount) || entryCount < 2) {
    throw new Error("Double elimination requires an entry count of at least two");
  }

  const seeds = Array.from({ length: entryCount }, (_, index): FormatParticipantSource => ({
    type: "entry_seed",
    seed: index + 1,
  }));
  const upper = createEliminationRounds({
    sources: seeds,
    stageId: "upper-bracket",
    orderStart: 1,
    purpose: "progression",
  });
  const lower = lowerBracket({ upperRounds: upper.rounds, orderStart: upper.nextOrder });
  const firstFinalMatchId = "grand-final-1";
  const firstFinal: FormatGraphMatch = {
    id: firstFinalMatchId,
    stageId: "grand-final",
    round: 1,
    order: lower.nextOrder,
    purpose: "championship",
    home: upper.winner,
    away: lower.winner,
  };

  const lowerStage =
    lower.matches.length > 0
      ? [
          {
            id: "lower-bracket",
            label: "Lower bracket",
            kind: "consolation" as const,
            order: 2,
            groupIds: [],
            groupSize: null,
            outputRanks: Math.max(1, entryCount - 1),
            matchIds: lower.matches.map((match) => match.id),
          },
        ]
      : [];
  const finalStageOrder = lowerStage.length > 0 ? 3 : 2;
  const graph: FormatGraph = {
    id: `double-elimination-${entryCount}`,
    schemaVersion: 1,
    entryCount,
    stages: [
      {
        id: "upper-bracket",
        label: "Upper bracket",
        kind: "single_elimination",
        order: 1,
        groupIds: [],
        groupSize: null,
        outputRanks: entryCount,
        matchIds: upper.matches.map((match) => match.id),
      },
      ...lowerStage,
      {
        id: "grand-final",
        label: "Grand final",
        kind: "single_elimination",
        order: finalStageOrder,
        groupIds: [],
        groupSize: null,
        outputRanks: 2,
        matchIds: [firstFinalMatchId],
      },
    ],
    matches: [...upper.matches, ...lower.matches, firstFinal],
    terminalMatchIds: [firstFinalMatchId],
  };
  assertValidFormatGraph(graph);

  const baseMetrics = calculateFormatMetrics(graph);
  if (graph.matches.length !== entryCount * 2 - 2) {
    throw new Error("Double elimination bracket produced an invalid match count");
  }
  if (baseMetrics.guaranteedMatches < 2) {
    throw new Error("Double elimination must guarantee two matches per entrant");
  }

  const resetMatch: FormatGraphMatch = {
    id: "grand-final-reset",
    stageId: "grand-final",
    round: 2,
    order: firstFinal.order + 1,
    purpose: "championship",
    home: { type: "winner", matchId: firstFinalMatchId },
    away: { type: "loser", matchId: firstFinalMatchId },
  };
  const result: DoubleEliminationFormat = {
    graph,
    upperFinalMatchId: upper.finalMatchId,
    firstFinalMatchId,
    resetFinal: {
      match: resetMatch,
      requiredWhen: {
        matchId: firstFinalMatchId,
        winnerSlot: "away",
        reason: "lower_bracket_champion_hands_upper_bracket_champion_first_loss",
      },
    },
    metrics: {
      minimumMatchCount: graph.matches.length,
      maximumMatchCount: graph.matches.length + 1,
      guaranteedMatches: baseMetrics.guaranteedMatches,
      maximumParticipantMatches: baseMetrics.maximumMatches + 1,
    },
  };
  return freezeDeep(result) as DoubleEliminationFormat;
}

/** Return the reset final only when the lower-bracket champion wins final one. */
export function resolveDoubleEliminationResetFinal(
  definition: DoubleEliminationFormat,
  firstFinalWinnerSlot: "home" | "away",
): FormatGraphMatch | null {
  if (definition.resetFinal.requiredWhen.matchId !== definition.firstFinalMatchId) {
    throw new Error("Double elimination reset contract is not bound to the first final");
  }
  return firstFinalWinnerSlot === definition.resetFinal.requiredWhen.winnerSlot ? definition.resetFinal.match : null;
}

/** Build a format template adapter for double elimination. */
export function buildDoubleEliminationFormatTemplate(entryCount: number): FormatTemplate {
  const format = createDoubleEliminationFormat(entryCount);
  return freezeDeep({
    id: `${entryCount}-double_elimination`,
    label: "Double elimination",
    strategy: "double_elimination" as const,
    advantage: "Every entrant is guaranteed at least two matches with upper and lower brackets.",
    graph: format.graph,
    metrics: calculateFormatMetrics(format.graph),
  });
}

export type DoubleEliminationMatchRecord = {
  matchId: string;
  homeEntryId: string | null;
  awayEntryId: string | null;
  winnerEntryId: string | null;
  loserEntryId: string | null;
  state: "scheduled" | "in_progress" | "completed";
};

export type DoubleEliminationProgressionResult = {
  matches: DoubleEliminationMatchRecord[];
  isResetFinalRequired: boolean;
  resetFinalMatch: DoubleEliminationMatchRecord | null;
  championEntryId: string | null;
  runnerUpEntryId: string | null;
};

/**
 * Resolves match progression across upper bracket, lower bracket, and grand finals,
 * dynamically determining whether the conditional reset match (GF2) is activated and resolved.
 */
export function resolveDoubleEliminationProgression(
  format: DoubleEliminationFormat,
  entryMap: ReadonlyMap<number, string>,
  results: ReadonlyMap<string, { winnerEntryId: string; loserEntryId: string }>,
): DoubleEliminationProgressionResult {
  const resolvedMatches = new Map<string, DoubleEliminationMatchRecord>();

  for (const match of format.graph.matches) {
    let homeEntryId: string | null = null;
    let awayEntryId: string | null = null;

    if (match.home.type === "entry_seed") {
      homeEntryId = entryMap.get(match.home.seed) ?? null;
    } else if (match.home.type === "winner") {
      homeEntryId = results.get(match.home.matchId)?.winnerEntryId ?? null;
    } else if (match.home.type === "loser") {
      homeEntryId = results.get(match.home.matchId)?.loserEntryId ?? null;
    }

    if (match.away.type === "entry_seed") {
      awayEntryId = entryMap.get(match.away.seed) ?? null;
    } else if (match.away.type === "winner") {
      awayEntryId = results.get(match.away.matchId)?.winnerEntryId ?? null;
    } else if (match.away.type === "loser") {
      awayEntryId = results.get(match.away.matchId)?.loserEntryId ?? null;
    }

    const result = results.get(match.id);
    const state: DoubleEliminationMatchRecord["state"] = result
      ? "completed"
      : homeEntryId && awayEntryId
        ? "scheduled"
        : "scheduled";

    resolvedMatches.set(match.id, {
      matchId: match.id,
      homeEntryId,
      awayEntryId,
      winnerEntryId: result?.winnerEntryId ?? null,
      loserEntryId: result?.loserEntryId ?? null,
      state,
    });
  }

  const firstFinal = resolvedMatches.get(format.firstFinalMatchId);
  let isResetFinalRequired = false;
  let resetFinalMatch: DoubleEliminationMatchRecord | null = null;
  let championEntryId: string | null = null;
  let runnerUpEntryId: string | null = null;

  if (firstFinal && firstFinal.winnerEntryId && firstFinal.loserEntryId) {
    // If lower bracket champion (away team) won GF1, upper bracket champion suffers their 1st loss -> Reset Final (GF2) is required!
    if (firstFinal.winnerEntryId === firstFinal.awayEntryId) {
      isResetFinalRequired = true;
      const resetResult = results.get(format.resetFinal.match.id);
      resetFinalMatch = {
        matchId: format.resetFinal.match.id,
        homeEntryId: firstFinal.homeEntryId,
        awayEntryId: firstFinal.awayEntryId,
        winnerEntryId: resetResult?.winnerEntryId ?? null,
        loserEntryId: resetResult?.loserEntryId ?? null,
        state: resetResult ? "completed" : "scheduled",
      };

      if (resetResult) {
        championEntryId = resetResult.winnerEntryId;
        runnerUpEntryId = resetResult.loserEntryId;
      }
    } else {
      // Undefeated upper bracket champion won GF1 -> No reset needed, champion confirmed!
      championEntryId = firstFinal.winnerEntryId;
      runnerUpEntryId = firstFinal.loserEntryId;
    }
  }

  return {
    matches: Array.from(resolvedMatches.values()),
    isResetFinalRequired,
    resetFinalMatch,
    championEntryId,
    runnerUpEntryId,
  };
}

/**
 * Validates scheduling capacity for double elimination, ensuring available slots account
 * for both guaranteed 2N-2 matches and conditional 2N-1 reset matches.
 */
export function evaluateDoubleEliminationScheduleCapacity(
  entryCount: number,
  availableSlots: number,
): {
  minimumSlotsRequired: number;
  maximumSlotsWithReset: number;
  fitsMinimum: boolean;
  fitsWithReset: boolean;
} {
  const minimumSlotsRequired = entryCount * 2 - 2;
  const maximumSlotsWithReset = entryCount * 2 - 1;
  return {
    minimumSlotsRequired,
    maximumSlotsWithReset,
    fitsMinimum: availableSlots >= minimumSlotsRequired,
    fitsWithReset: availableSlots >= maximumSlotsWithReset,
  };
}
