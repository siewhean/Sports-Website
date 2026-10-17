import type { StandingsEngineConfig } from "./results.js";
import { FEDERATION_SPORT_PACKS, type SportId, type SportPackSettings } from "./sport-packs.js";

/**
 * Redesign Phase 4: standings rules that only federation packs use. Draft-pack competitions never reach these
 * rules, so their standings stay exactly as they were.
 */

/** Points per card for a team's honourable-play (discipline) total; lower ranks higher. */
export type DisciplineWeights = Readonly<Record<string, number>>;

/**
 * ICF canoe polo honourable play: 25 for an ejection (red card), 5 for each other card. Every red card in canoe
 * polo sends the player off, so MATCHDAY counts each red card as an ejection.
 */
export const ICF_HONOURABLE_PLAY_WEIGHTS: DisciplineWeights = Object.freeze({
  green_card: 5,
  yellow_card: 5,
  red_card: 25,
});

export function isFederationSportPack(sportId: SportId, packVersion: string): boolean {
  return FEDERATION_SPORT_PACKS.some((pack) => pack.sportId === sportId && pack.version === packVersion);
}

/** Honourable-play weights for a pack, or null when cards do not count towards standings. */
export function disciplineWeightsFor(sportId: SportId, packVersion: string): DisciplineWeights | null {
  return sportId === "canoe_polo" && isFederationSportPack(sportId, packVersion) ? ICF_HONOURABLE_PLAY_WEIGHTS : null;
}

type CardAction = Readonly<{ eventType?: unknown; side?: unknown; reversed?: unknown }>;

/** Each side's honourable-play total from a match's scoring actions; reversed actions do not count. */
export function disciplinePointsFromActions(
  actions: readonly CardAction[],
  weights: DisciplineWeights,
): Readonly<{ home: number; away: number }> {
  const totals = { home: 0, away: 0 };
  for (const action of actions) {
    if (action.reversed === true || typeof action.eventType !== "string") continue;
    const weight = weights[action.eventType];
    if (weight === undefined) continue;
    if (action.side === "home") totals.home += weight;
    else if (action.side === "away") totals.away += weight;
  }
  return totals;
}

function integerSetting(settings: SportPackSettings, key: string): number | undefined {
  const value = settings[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Applies a federation pack's classification-points scheme (3/1/0 or 2/1/0 with 0 for a forfeit) to a standings
 * configuration, and for badminton the BWF rule that deletes the results of an entry that did not complete its
 * group matches. Draft packs come back unchanged. The version gains a suffix so a snapshot records the scheme.
 */
export function applyFederationStandingsRules(
  config: StandingsEngineConfig,
  sportId: SportId,
  packVersion: string,
  effective: SportPackSettings,
): StandingsEngineConfig {
  if (!isFederationSportPack(sportId, packVersion)) return config;
  const winPoints = integerSetting(effective, "winPoints") ?? config.winPoints;
  const drawPoints = integerSetting(effective, "drawPoints") ?? config.drawPoints;
  const lossPoints = integerSetting(effective, "lossPoints") ?? config.lossPoints;
  const forfeitLossPoints = integerSetting(effective, "forfeitLossPoints");
  const defaultLossPoints = integerSetting(effective, "defaultLossPoints");
  const disciplineWeights = disciplineWeightsFor(sportId, packVersion);
  const deleteIncomplete = sportId === "badminton";
  return {
    ...config,
    version: `${config.version}+federation:${packVersion}:${winPoints}/${drawPoints}/${lossPoints}/${forfeitLossPoints ?? "loss"}${defaultLossPoints === undefined ? "" : `:default-${defaultLossPoints}`}${disciplineWeights ? ":honourable-play" : ""}${deleteIncomplete ? ":incomplete-deleted" : ""}`,
    winPoints,
    drawPoints,
    lossPoints,
    ...(forfeitLossPoints === undefined ? {} : { forfeitLossPoints }),
    // FIBA OBR Art. 21.2.1: a team that loses by default still gets a classification point.
    ...(defaultLossPoints === undefined ? {} : { defaultLossPoints }),
    ...(disciplineWeights ? { disciplineWeights } : {}),
    // BWF GCR 16.2.5: a player or pair who cannot complete all their group matches has all their results deleted.
    ...(deleteIncomplete ? { incompleteEntryResults: "delete_all" as const } : {}),
  };
}
