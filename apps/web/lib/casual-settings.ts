import { SPORT_PACKS, type SportId } from "@matchday/domain";
import type { CasualSettings } from "./casual-client";

export const casualSports = (["badminton", "basketball", "canoe_polo", "table_tennis", "volleyball"] as SportId[]).map(
  (id) => ({ id, name: SPORT_PACKS[id].displayName, timed: SPORT_PACKS[id].matchStructure.kind === "timed_periods" }),
);

export function defaultCasualSettings(sport: SportId): CasualSettings {
  const pack = SPORT_PACKS[sport];
  const timed = pack.matchStructure.kind === "timed_periods";
  return {
    sport_id: sport,
    home_name: "Team A",
    away_name: "Team B",
    ...(timed
      ? { period_minutes: pack.matchStructure.segmentDurationMinutes ?? 10 }
      : {
          target_points: pack.matchStructure.targetPoints?.[0] ?? 21,
          best_of_sets: pack.matchStructure.regulationSegments,
        }),
  };
}

export function validateCasualSettings(settings: CasualSettings): string | null {
  if (!settings.home_name.trim() || !settings.away_name.trim()) return "Name both sides before starting.";
  if (settings.home_name.trim() === settings.away_name.trim()) return "Give each side a different name.";
  if (settings.home_name.length > 60 || settings.away_name.length > 60)
    return "Keep each side name under 60 characters.";
  const timed = SPORT_PACKS[settings.sport_id].matchStructure.kind === "timed_periods";
  if (timed) {
    if (!Number.isInteger(settings.period_minutes) || settings.period_minutes! < 1 || settings.period_minutes! > 120)
      return "Choose a period from 1 to 120 minutes.";
  } else {
    if (!Number.isInteger(settings.target_points) || settings.target_points! < 1 || settings.target_points! > 99)
      return "Choose a target from 1 to 99 points.";
    if (![1, 3, 5, 7].includes(settings.best_of_sets ?? 0)) return "Choose 1, 3, 5 or 7 sets.";
  }
  return null;
}

export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
