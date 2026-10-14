import { describe, expect, it } from "vitest";
import {
  constructRestAwareSchedule,
  diagnoseScheduleInfeasibility,
  measureScheduleShape,
  validateSchedule,
  type ConstraintMode,
  type ScheduleProblem,
  type SchedulingConstraints,
  type SchedulingMatch,
  type SchedulingSlot,
} from "../src/index.js";

const MINUTE_MS = 60_000;
const DAY_START = Date.parse("2026-11-14T01:00:00.000Z"); // 09:00 Asia/Singapore

function setting<T>(mode: ConstraintMode, value: T, weight?: number) {
  return { mode, value, ...(weight === undefined ? {} : { weight }) };
}

function defaults(overrides: Partial<SchedulingConstraints> = {}): SchedulingConstraints {
  return {
    minimumRest: setting("preferred", { minutes: 60 }, 4),
    maximumMatchesPerDay: setting("required", { matches: 7 }),
    preferredFinalTime: setting("ignored", { targetStartEpochMs: DAY_START, toleranceMinutes: 30 }),
    entryUnavailable: setting("ignored", { byEntryId: {} }),
    officialAvailability: setting("ignored", { byOfficialId: {} }),
    featuredPlayingArea: setting("ignored", { areaId: "court-1", matchIds: [] }),
    avoidConsecutiveMatches: setting("preferred", { minutes: 30 }, 4),
    balanceEarlyMatches: setting("preferred", { beforeLocalTime: "09:00" }, 2),
    balanceLateMatches: setting("preferred", { atOrAfterLocalTime: "16:00" }, 2),
    keepDivisionTogether: setting("preferred", { maximumAreaCount: 2 }, 2),
    preserveExistingSchedule: setting("ignored", { maximumShiftMinutes: 0, byMatchId: {} }),
    ...overrides,
  };
}

function courtSlots(courts: number, slotsPerCourt: number): SchedulingSlot[] {
  return Array.from({ length: courts }, (_, court) =>
    Array.from({ length: slotsPerCourt }, (_, index) => ({
      id: `court-${court + 1}:${index + 1}`,
      intervalId: `court-${court + 1}`,
      areaId: `court-${court + 1}`,
      startEpochMs: DAY_START + index * 30 * MINUTE_MS,
      endEpochMs: DAY_START + (index + 1) * 30 * MINUTE_MS,
    })),
  ).flat();
}

function roundRobin(teams: number, prefix = "rr"): SchedulingMatch[] {
  const matches: SchedulingMatch[] = [];
  for (let home = 1; home <= teams; home += 1)
    for (let away = home + 1; away <= teams; away += 1)
      matches.push({
        id: `${prefix}-${home}-${away}`,
        divisionId: prefix,
        durationMinutes: 30,
        dependencyMatchIds: [],
        possibleEntryIds: [`${prefix}-team-${home}`, `${prefix}-team-${away}`],
        officialIds: [],
        isChampionshipFinal: false,
      });
  return matches;
}

function problem(slotsPerCourt: number, overrides: Partial<SchedulingConstraints> = {}): ScheduleProblem {
  return {
    timeZone: "Asia/Singapore",
    objective: "balanced",
    matches: roundRobin(8),
    slots: courtSlots(2, slotsPerCourt),
    constraints: defaults(overrides),
  };
}

function locked(match: SchedulingMatch, slot: SchedulingSlot): SchedulingMatch {
  return {
    ...match,
    fixedAssignment: {
      reason: "locked",
      areaId: slot.areaId,
      slotId: slot.id,
      startEpochMs: slot.startEpochMs,
      endEpochMs: slot.endEpochMs,
    },
  };
}

describe("rest-aware construction (back-to-back witness search)", () => {
  it("finds a 0 back-to-back schedule for QA scenario 1 (8-team round robin, 2 courts, 36 slots)", () => {
    const s1 = problem(18);
    const result = constructRestAwareSchedule(s1);
    expect(result).not.toBeNull();
    expect(result!.backToBackAllowance).toBe(0);
    expect(result!.assignments).toHaveLength(28);
    expect(validateSchedule(s1, result!.assignments).valid).toBe(true);
    expect(measureScheduleShape(s1, result!.assignments).backToBackCount).toBe(0);
    expect(measureScheduleShape(s1, result!.assignments).courtLoadSpreadMinutes).toBe(0);
  });

  it("is deterministic", () => {
    expect(constructRestAwareSchedule(problem(18))).toEqual(constructRestAwareSchedule(problem(18)));
  });

  it("needs a positive allowance when every slot is full (28 matches on 28 slots)", () => {
    // Full half-hours alternate between one 4-entry set and its complement without back-to-backs,
    // so the cross matches could never be played: 0 is impossible here.
    const exact = problem(14);
    const result = constructRestAwareSchedule(exact);
    expect(result).not.toBeNull();
    expect(result!.backToBackAllowance).toBeGreaterThan(0);
    expect(result!.backToBackCount).toBeGreaterThan(0);
    expect(validateSchedule(exact, result!.assignments).valid).toBe(true);
  });

  it("keeps locks, required rest and the daily limit", () => {
    const slots = courtSlots(2, 18);
    const base = problem(18, {
      minimumRest: setting("required", { minutes: 30 }),
      maximumMatchesPerDay: setting("required", { matches: 7 }),
    });
    const withLock: ScheduleProblem = {
      ...base,
      matches: base.matches.map((match) => (match.id === "rr-1-2" ? locked(match, slots[5]!) : match)),
    };
    const result = constructRestAwareSchedule(withLock);
    expect(result).not.toBeNull();
    expect(validateSchedule(withLock, result!.assignments).valid).toBe(true);
    expect(result!.assignments.find((assignment) => assignment.matchId === "rr-1-2")?.slotId).toBe(slots[5]!.id);
  });

  it("leaves minimal-change re-planning to the greedy constructor", () => {
    const repair = problem(18, {
      preserveExistingSchedule: setting("preferred", { maximumShiftMinutes: 30, byMatchId: {} }, 50),
    });
    expect(constructRestAwareSchedule(repair)).toBeNull();
  });

  it("returns null when the matches cannot fit", () => {
    expect(constructRestAwareSchedule(problem(13))).toBeNull();
  });
});

describe("infeasibility diagnostics name the cause and the fix", () => {
  it("reports locked matches that break required rest between themselves", () => {
    const slots = courtSlots(2, 18);
    const base = problem(18, { minimumRest: setting("required", { minutes: 30 }) });
    const conflicting: ScheduleProblem = {
      ...base,
      matches: base.matches.map((match) =>
        match.id === "rr-5-6" ? locked(match, slots[0]!) : match.id === "rr-2-6" ? locked(match, slots[1]!) : match,
      ),
    };
    const finding = diagnoseScheduleInfeasibility(conflicting).find((violation) => violation.code === "minimum_rest");
    expect(finding?.matchIds).toEqual(["rr-5-6", "rr-2-6"]);
    expect(finding?.message).toMatch(/only 0 minutes of rest, but 30 minutes are required/);
    expect(finding?.message).toMatch(/Unlock or move one of them/);
  });

  it("bounds a knockout by its entries' sequential prerequisite matches", () => {
    // One group of four (each entry plays 3 matches) then a final, on 8 courts with 3 half-hours:
    // the group needs all 3 half-hours, so no slot is left for the final.
    const group = roundRobin(4, "g");
    const final: SchedulingMatch = {
      id: "final",
      divisionId: "g",
      durationMinutes: 30,
      dependencyMatchIds: group.map((match) => match.id),
      possibleEntryIds: group.flatMap((match) => match.possibleEntryIds),
      officialIds: [],
      isChampionshipFinal: true,
    };
    const knockout: ScheduleProblem = {
      timeZone: "Asia/Singapore",
      objective: "balanced",
      matches: [...group, final],
      slots: courtSlots(8, 3),
      constraints: defaults(),
    };
    const finding = diagnoseScheduleInfeasibility(knockout).find((violation) => violation.code === "dependency_order");
    expect(finding?.message).toMatch(/Add playing time after the prerequisite rounds/);
  });
});
