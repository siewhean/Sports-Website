import { createHash } from "node:crypto";
import {
  SPORT_PACKS,
  STANDINGS_SPORT_PACKS,
  applyAutomaticAdvancement,
  applyWithdrawalPolicy,
  calculateCalendarCapacity,
  calculateStandings,
  compareAcrossGroups,
  competitionDomain,
  createStandingsSnapshot,
  resolveCalendarCapacityWindows,
  validateSportPack,
  validateFormatGraph,
  validateSportSettings,
  type CalendarCapacityInput,
  type FormatGraph,
  type SportPack,
  type SportId,
  type ConfigurableStandingsRow,
  type AdvancementRule,
  type AdvancementSlot,
  type CrossGroupCandidate,
  type StandingsEngineConfig,
  type StandingsMatchResult,
  type StandingsParticipant,
  type StandingsSnapshot,
  type ScheduledStandingsMatch,
} from "@matchday/domain";

type CommandContext = competitionDomain.CommandContext;
type Competition = competitionDomain.Competition;
type CompetitionInput = competitionDomain.CompetitionInput;
type CompetitionPatch = competitionDomain.CompetitionPatch;
type EntryInput = competitionDomain.EntryInput;
type PlanTier = competitionDomain.PlanTier;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const phase3DomainAdapter = {
  hash(value: unknown): string {
    return createHash("sha256").update(canonical(value)).digest("hex");
  },
  sportPack(sport: SportId) {
    return SPORT_PACKS[sport];
  },
  validateSportPack(value: unknown) {
    return validateSportPack(value);
  },
  validateSettings(pack: SportPack, settings: unknown, partial = false) {
    return validateSportSettings(pack, settings, { partial });
  },
  resolveSettings(
    pack: SportPack,
    recommended: Readonly<Record<string, unknown>>,
    competitionOverride: Readonly<Record<string, unknown>>,
    divisionOverride: Readonly<Record<string, unknown>> = {},
  ) {
    const effective = { ...recommended, ...competitionOverride, ...divisionOverride };
    return {
      effective,
      issues: [
        ...validateSportSettings(pack, competitionOverride, { partial: true }),
        ...validateSportSettings(pack, divisionOverride, { partial: true }),
        ...validateSportSettings(pack, effective),
      ],
    };
  },
  settingsDifference(
    settings: Readonly<Record<string, unknown>>,
    recommended: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(settings).filter(([key, value]) => canonical(value) !== canonical(recommended[key])),
    );
  },
  createCompetition(input: CompetitionInput, context: CommandContext) {
    return competitionDomain.createCompetition(input, context);
  },
  updateCompetition(competition: Competition, patch: CompetitionPatch, context: CommandContext) {
    return competitionDomain.updateCompetition(competition, patch, context);
  },
  addEntry(competition: Competition, divisionId: string, input: EntryInput, tier: PlanTier, context: CommandContext) {
    return competitionDomain.addEntry(competition, divisionId, input, tier, context);
  },
  updateEntry(
    competition: Competition,
    divisionId: string,
    entryId: string,
    patch: Partial<Pick<EntryInput, "name" | "type" | "seed" | "metadata" | "availability">>,
    context: CommandContext,
  ) {
    return competitionDomain.updateEntry(competition, divisionId, entryId, patch, context);
  },
  withdrawEntry(
    competition: Competition,
    divisionId: string,
    entryId: string,
    reason: string,
    context: CommandContext,
  ) {
    return competitionDomain.withdrawEntry(competition, divisionId, entryId, reason, context);
  },
  replaceEntry(
    competition: Competition,
    divisionId: string,
    entryId: string,
    replacement: EntryInput,
    tier: PlanTier,
    context: CommandContext,
  ) {
    return competitionDomain.replaceEntry(competition, divisionId, entryId, replacement, tier, context);
  },
  validateFormat(graph: FormatGraph) {
    return validateFormatGraph(graph);
  },
  capacity(input: CalendarCapacityInput) {
    return calculateCalendarCapacity(input);
  },
  resolveCapacityWindows(input: CalendarCapacityInput) {
    return resolveCalendarCapacityWindows(input);
  },
  standings(input: {
    competitionId: string;
    divisionId: string;
    groupId: string;
    resultVersion: number;
    configVersion: string;
    calculatedAt: string;
    rows: readonly ConfigurableStandingsRow[];
  }) {
    return createStandingsSnapshot(input);
  },
  standingsConfig(pack: SportPack, effective: Readonly<Record<string, unknown>>): StandingsEngineConfig {
    const metric = (value: string) =>
      ({
        points: "table_points",
        wins: "match_wins",
        match_wins: "match_wins",
        goal_difference: "score_difference",
        point_difference: "score_difference",
        goals_for: "score_for",
        points_for: "score_for",
        game_difference: "segment_difference",
        set_difference: "segment_difference",
        set_ratio: "segment_ratio",
        point_ratio: "score_ratio",
        head_to_head: "head_to_head",
        discipline: "discipline",
        seed: "seed",
      })[value] as StandingsEngineConfig["criteria"][number] | undefined;
    const base = STANDINGS_SPORT_PACKS[pack.sportId];
    const forfeitWinnerScore = Number(effective.forfeitWinnerScore ?? pack.forfeit.winnerScore);
    const forfeitLoserScore = Number(effective.forfeitLoserScore ?? pack.forfeit.loserScore);
    const segmentForfeit = base.forfeitScore.homeSegments !== undefined;
    const configuredOrder = Array.isArray(effective.standingsOrder)
      ? effective.standingsOrder
          .filter((value): value is string => typeof value === "string")
          .map(metric)
          .filter((value): value is StandingsEngineConfig["criteria"][number] => value !== undefined)
      : [];
    return {
      ...base,
      version: `${pack.version}:${this.hash(effective)}`,
      winPoints: Number(effective.winPoints ?? base.winPoints),
      drawPoints: Number(effective.drawPoints ?? base.drawPoints),
      lossPoints: Number(effective.lossPoints ?? base.lossPoints),
      criteria: configuredOrder.length > 0 ? configuredOrder : base.criteria,
      withdrawalPolicy: pack.forfeit.preserveCompletedPlay ? "completed_results_stand" : "void_all_results",
      forfeitScore: {
        ...base.forfeitScore,
        homeScore: segmentForfeit ? forfeitWinnerScore * pack.forfeit.awardedSegments : forfeitWinnerScore,
        awayScore: segmentForfeit ? forfeitLoserScore * pack.forfeit.awardedSegments : forfeitLoserScore,
        ...(segmentForfeit
          ? {
              homeSegments: Array.from({ length: pack.forfeit.awardedSegments }, () => forfeitWinnerScore),
              awaySegments: Array.from({ length: pack.forfeit.awardedSegments }, () => forfeitLoserScore),
            }
          : {}),
      },
    };
  },
  calculateStandings(
    entries: readonly StandingsParticipant[],
    results: readonly StandingsMatchResult[],
    config: StandingsEngineConfig,
  ) {
    return calculateStandings(entries, results, config);
  },
  applyWithdrawal(
    entries: readonly StandingsParticipant[],
    results: readonly StandingsMatchResult[],
    scheduledMatches: readonly ScheduledStandingsMatch[],
    entryId: string,
    config: StandingsEngineConfig,
  ) {
    return applyWithdrawalPolicy(entries, results, scheduledMatches, { entryId }, config);
  },
  compareAcrossGroups(candidates: readonly CrossGroupCandidate[]) {
    return compareAcrossGroups(candidates, {
      criteria: ["table_points_per_match", "wins_per_match", "score_difference_per_match", "seed"],
      incompleteGroupPolicy: "provisional",
    });
  },
  advance(input: {
    rules: readonly AdvancementRule[];
    groupSnapshots: Readonly<Record<string, StandingsSnapshot>>;
    currentSlots: readonly AdvancementSlot[];
    crossGroupStandings?: ReturnType<typeof compareAcrossGroups>;
  }) {
    return applyAutomaticAdvancement(input);
  },
};

export type Phase3DomainAdapter = typeof phase3DomainAdapter;
