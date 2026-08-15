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
const START = Date.parse("2026-09-12T01:00:00.000Z");

function ignored<T>(value: T): ConstraintSetting<T> {
  return { mode: "ignored", value };
}

function dailyCap(mode: "preferred" | "required"): ConstraintSetting<{ matches: number }> {
  return mode === "preferred"
    ? { mode: "preferred", value: { matches: 4 }, weight: 4 }
    : { mode: "required", value: { matches: 4 } };
}

function constraints(maximumMatchesMode: "preferred" | "required" = "preferred"): SchedulingConstraints {
  return {
    minimumRest: { mode: "preferred", value: { minutes: 60 }, weight: 4 },
    maximumMatchesPerDay: dailyCap(maximumMatchesMode),
    preferredFinalTime: {
      mode: "preferred",
      value: { targetStartEpochMs: START + 8 * 60 * MINUTE_MS, toleranceMinutes: 120 },
      weight: 3,
    },
    entryUnavailable: ignored({ byEntryId: {} }),
    officialAvailability: ignored({ byOfficialId: {} }),
    featuredPlayingArea: ignored({ areaId: "area-1", matchIds: [] }),
    avoidConsecutiveMatches: { mode: "preferred", value: { minutes: 30 }, weight: 4 },
    balanceEarlyMatches: { mode: "preferred", value: { beforeLocalTime: "10:00" }, weight: 2 },
    balanceLateMatches: { mode: "preferred", value: { atOrAfterLocalTime: "17:00" }, weight: 2 },
    keepDivisionTogether: { mode: "preferred", value: { maximumAreaCount: 2 }, weight: 2 },
    preserveExistingSchedule: ignored({ maximumShiftMinutes: 0, byMatchId: {} }),
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

function exactCapacityProblem(
  maximumMatchesMode: "preferred" | "required" = "preferred",
  slotCount = 36,
): ScheduleProblem {
  const matches = [
    ...materialisedFullPlacementDivision("open", "open"),
    ...materialisedFullPlacementDivision("women", "women"),
  ];
  return {
    timeZone: "Asia/Singapore",
    objective: "balanced",
    matches,
    slots: exactSlots(slotCount, 2),
    constraints: constraints(maximumMatchesMode),
  };
}

describe("V1 exact-capacity full-placement scheduling", () => {
  it("constructs a valid 36-fixture schedule in one worker iteration with exactly 36 slots", () => {
    const problem = exactCapacityProblem();
    expect(problem.matches).toHaveLength(36);
    expect(problem.slots).toHaveLength(36);

    const first = generateScheduleCandidates(problem, { maxIterations: 1 });
    const replay = generateScheduleCandidates(problem, { maxIterations: 1 });
    expect(first).toEqual(replay);
    expect(first).toHaveLength(1);
    expect(first[0]!.assignments).toHaveLength(36);
    expect(new Set(first[0]!.assignments.map((assignment) => assignment.slotId)).size).toBe(36);
    expect(validateSchedule(problem, first[0]!.assignments).valid).toBe(true);
  });

  it("keeps an explicitly required four-match daily cap fail-closed as no solution instead of a worker failure", () => {
    const requiredProblem = exactCapacityProblem("required");
    expect(() => generateScheduleCandidates(requiredProblem, { maxIterations: 1 })).not.toThrow();
    expect(generateScheduleCandidates(requiredProblem, { maxIterations: 1 })).toEqual([]);
  });

  it("returns no solution instead of failing when 36 fixtures have only 35 slots", () => {
    const insufficient = exactCapacityProblem("preferred", 35);
    expect(() => generateScheduleCandidates(insufficient, { maxIterations: 1 })).not.toThrow();
    expect(generateScheduleCandidates(insufficient, { maxIterations: 1 })).toEqual([]);
  });
});
