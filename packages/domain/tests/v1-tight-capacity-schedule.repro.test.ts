import { describe, expect, it } from "vitest";
import {
  createDefaultFormatTemplates,
  deriveSchedulingMatches,
  generateScheduleCandidates,
  validateSchedule,
  type ConstraintSetting,
  type ScheduleProblem,
  type SchedulingConstraints,
  type SchedulingMatch,
  type SchedulingSlot,
} from "../src/index.js";

const MINUTE_MS = 60_000;
const START = Date.parse("2026-09-12T01:00:00.000Z"); // 09:00 Asia/Singapore

function setting<T>(value: T): ConstraintSetting<T> {
  return { mode: "ignored", value };
}

function constraints(): SchedulingConstraints {
  return {
    minimumRest: setting({ minutes: 30 }),
    maximumMatchesPerDay: setting({ matches: 12 }),
    preferredFinalTime: setting({ targetStartEpochMs: START + 8 * 60 * MINUTE_MS, toleranceMinutes: 120 }),
    entryUnavailable: setting({ byEntryId: {} }),
    officialAvailability: setting({ byOfficialId: {} }),
    featuredPlayingArea: setting({ areaId: "area-1", matchIds: [] }),
    avoidConsecutiveMatches: setting({ minutes: 30 }),
    balanceEarlyMatches: setting({ beforeLocalTime: "10:00" }),
    balanceLateMatches: setting({ atOrAfterLocalTime: "17:00" }),
    keepDivisionTogether: setting({ maximumAreaCount: 2 }),
    preserveExistingSchedule: setting({ maximumShiftMinutes: 0, byMatchId: {} }),
  };
}

function exactSlots(count: number, areas: number): SchedulingSlot[] {
  return Array.from({ length: count }, (_, index) => {
    const timeIndex = Math.floor(index / areas);
    const areaIndex = index % areas;
    const startEpochMs = START + timeIndex * 30 * MINUTE_MS;
    return {
      id: `slot-${index + 1}`,
      intervalId: `interval-${timeIndex + 1}`,
      areaId: `area-${areaIndex + 1}`,
      startEpochMs,
      endEpochMs: startEpochMs + 30 * MINUTE_MS,
    };
  });
}

function materialisedFullPlacementDivision(divisionId: string, prefix: string): SchedulingMatch[] {
  const template = createDefaultFormatTemplates(8).find((candidate) => candidate.strategy === "full_placement");
  if (!template) throw new Error("8-entry full-placement template is missing");
  const derived = deriveSchedulingMatches(
    template.graph,
    divisionId,
    Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, `${prefix}-entry-${index + 1}`])),
    30,
  );
  const materialisedIds = new Map(derived.map((match, index) => [match.id, `${prefix}-match-${index + 1}`]));
  return derived.map((match) => ({
    ...match,
    id: materialisedIds.get(match.id)!,
    dependencyMatchIds: match.dependencyMatchIds.map((dependencyId) => materialisedIds.get(dependencyId)!),
  }));
}

describe("V1 exact-capacity full-placement scheduling", () => {
  it("finds a valid schedule for two 8-entry full-placement divisions with exactly one slot per fixture", () => {
    const matches = [
      ...materialisedFullPlacementDivision("open", "open"),
      ...materialisedFullPlacementDivision("women", "women"),
    ];
    expect(matches).toHaveLength(36);
    const problem: ScheduleProblem = {
      timeZone: "Asia/Singapore",
      objective: "balanced",
      matches,
      slots: exactSlots(matches.length, 2),
      constraints: constraints(),
    };

    const candidates = generateScheduleCandidates(problem, { maxIterations: 64 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((candidate) => validateSchedule(problem, candidate.assignments).valid)).toBe(true);
  });
});
