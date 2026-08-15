import { describe, expect, it } from "vitest";
import {
  createDefaultFormatTemplates,
  deriveSchedulingMatches,
  generateScheduleCandidates,
  validateSchedule,
  type ConstraintSetting,
  type ScheduleAssignment,
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

function constraints(): SchedulingConstraints {
  return {
    minimumRest: { mode: "preferred", value: { minutes: 60 }, weight: 4 },
    maximumMatchesPerDay: { mode: "preferred", value: { matches: 4 }, weight: 4 },
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
    keepDivisionTogether: { mode: "preferred", value: { maximumAreaCount: 1 }, weight: 2 },
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

function manualDivisionAssignments(matches: readonly SchedulingMatch[], areaId: string, slots: readonly SchedulingSlot[]): ScheduleAssignment[] {
  const areaSlots = slots.filter((slot) => slot.areaId === areaId).sort((a, b) => a.startEpochMs - b.startEpochMs);
  if (areaSlots.length < matches.length) throw new Error("Not enough area slots for manual assignment");
  return matches.map((match, index) => {
    const slot = areaSlots[index]!;
    return {
      matchId: match.id,
      divisionId: match.divisionId,
      areaId: slot.areaId,
      intervalId: slot.intervalId,
      slotId: slot.id,
      startEpochMs: slot.startEpochMs,
      endEpochMs: slot.endEpochMs,
      fixed: false,
    };
  });
}

describe("division-cohesive exact-capacity scheduling", () => {
  it("proves the obvious one-division-per-area 36-slot assignment is domain-valid", () => {
    const open = materialisedFullPlacementDivision("open", "open");
    const women = materialisedFullPlacementDivision("women", "women");
    const slots = exactSlots(open.length + women.length, 2);
    const problem: ScheduleProblem = {
      timeZone: "Asia/Singapore",
      objective: "balanced",
      matches: [...open, ...women],
      slots,
      constraints: constraints(),
    };
    const assignments = [
      ...manualDivisionAssignments(open, "area-1", slots),
      ...manualDivisionAssignments(women, "area-2", slots),
    ];
    const validation = validateSchedule(problem, assignments);
    expect(validation.valid, JSON.stringify(validation.violations, null, 2)).toBe(true);
  });

  it("shows the current generator still cannot find that valid exact-capacity schedule", () => {
    const open = materialisedFullPlacementDivision("open", "open");
    const women = materialisedFullPlacementDivision("women", "women");
    const problem: ScheduleProblem = {
      timeZone: "Asia/Singapore",
      objective: "balanced",
      matches: [...open, ...women],
      slots: exactSlots(open.length + women.length, 2),
      constraints: constraints(),
    };
    const candidates = generateScheduleCandidates(problem, { maxIterations: 64 });
    expect(candidates.find((candidate) => validateSchedule(problem, candidate.assignments).valid)).toBeUndefined();
  });
});
