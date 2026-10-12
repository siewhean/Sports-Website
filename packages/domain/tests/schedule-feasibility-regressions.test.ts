import { describe, expect, it } from "vitest";
import {
  diagnoseScheduleInfeasibility,
  generateConstraintAwareSchedule,
  generateScheduleCandidates,
  minimumFeasibleDailyMatchLimit,
  validateSchedule,
  type ConstraintMode,
  type ScheduleProblem,
  type SchedulingConstraints,
  type SchedulingMatch,
  type SchedulingSlot,
} from "../src/index.js";

// Regressions from the 2026-10-11 mock tournament QA report (scenarios 1, 4 and the
// "default daily cap" finding). The 104-match canoe polo case lives in apps/scheduler.

const MINUTE_MS = 60_000;
const DAY_START = Date.parse("2026-11-14T01:00:00.000Z"); // 09:00 Asia/Singapore

function setting<T>(mode: ConstraintMode, value: T, weight?: number) {
  return { mode, value, ...(weight === undefined ? {} : { weight }) };
}

/** The API workspace defaults, with the daily cap supplied by each test. */
function defaults(overrides: Partial<SchedulingConstraints> = {}): SchedulingConstraints {
  return {
    minimumRest: setting("preferred", { minutes: 60 }, 4),
    maximumMatchesPerDay: setting("required", { matches: 4 }),
    preferredFinalTime: setting(
      "preferred",
      { targetStartEpochMs: DAY_START + 510 * MINUTE_MS, toleranceMinutes: 30 },
      3,
    ),
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

function courtSlots(courts: number, slotsPerCourt: number, dayStart = DAY_START): SchedulingSlot[] {
  return Array.from({ length: courts }, (_, court) =>
    Array.from({ length: slotsPerCourt }, (_, index) => ({
      id: `court-${court + 1}:${dayStart}:${index + 1}`,
      intervalId: `court-${court + 1}:${dayStart}`,
      areaId: `court-${court + 1}`,
      startEpochMs: dayStart + index * 30 * MINUTE_MS,
      endEpochMs: dayStart + (index + 1) * 30 * MINUTE_MS,
    })),
  ).flat();
}

function roundRobin(teams: number): SchedulingMatch[] {
  const matches: SchedulingMatch[] = [];
  for (let home = 1; home <= teams; home += 1)
    for (let away = home + 1; away <= teams; away += 1)
      matches.push({
        id: `rr-${String(home).padStart(2, "0")}-${String(away).padStart(2, "0")}`,
        divisionId: "badminton",
        durationMinutes: 30,
        dependencyMatchIds: [],
        possibleEntryIds: [`team-${home}`, `team-${away}`],
        officialIds: [],
        isChampionshipFinal: false,
      });
  return matches;
}

function badmintonRoundRobin(overrides: Partial<SchedulingConstraints>, slotsPerCourt = 18): ScheduleProblem {
  return {
    timeZone: "Asia/Singapore",
    objective: "balanced",
    matches: roundRobin(8),
    slots: courtSlots(2, slotsPerCourt),
    constraints: defaults(overrides),
  };
}

/** Mirrors DomainScheduleOptimizer: one independent iteration per worker step. */
function validIterations(problem: ScheduleProblem, iterations: number): number {
  let valid = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const [candidate] = generateScheduleCandidates(problem, { startIteration: iteration, maxIterations: 1 });
    if (candidate && validateSchedule(problem, candidate.assignments).valid) valid += 1;
  }
  return valid;
}

describe("QA scenario 1: 8-team badminton round robin, 2 courts, 1 day (28 matches, 36 slots)", () => {
  const dailySeven = { maximumMatchesPerDay: setting<{ matches: number }>("required", { matches: 7 }) };

  it("finds a valid schedule on every iteration with 30 minutes of required rest", () => {
    const problem = badmintonRoundRobin({ ...dailySeven, minimumRest: setting("required", { minutes: 30 }) });
    expect(validIterations(problem, 16)).toBe(16);
    const assignments = generateConstraintAwareSchedule(problem);
    expect(validateSchedule(problem, assignments).valid).toBe(true);
  });

  it.each([30, 60, 90])("never lets %i minutes of preferred rest produce no_solution on an exact fit", (minutes) => {
    // 28 matches on exactly 28 slots: any preference-led slot choice that strands a match is fatal.
    for (const objective of ["balanced", "fastest", "rest_focused"] as const) {
      const problem = {
        ...badmintonRoundRobin({ ...dailySeven, minimumRest: setting("preferred", { minutes }, 4) }, 14),
        objective,
      };
      expect(validIterations(problem, 8)).toBe(8);
    }
  });
});

describe("default daily match limit", () => {
  it("derives the per-day limit a format forces on an entry from the event dates", () => {
    const oneDay = courtSlots(2, 18).map((slot) => slot.startEpochMs);
    const twoDays = [...oneDay, ...courtSlots(2, 18, DAY_START + 24 * 60 * MINUTE_MS).map((slot) => slot.startEpochMs)];
    expect(minimumFeasibleDailyMatchLimit(roundRobin(8), oneDay, "Asia/Singapore")).toBe(7);
    expect(minimumFeasibleDailyMatchLimit(roundRobin(8), twoDays, "Asia/Singapore")).toBe(4);
    expect(minimumFeasibleDailyMatchLimit(roundRobin(4), oneDay, "Asia/Singapore")).toBe(3);
  });
});

describe("no_solution diagnostics", () => {
  const codes = (problem: ScheduleProblem) => diagnoseScheduleInfeasibility(problem).map((item) => item.code);

  it("explains the old default daily cap of 4 on a one-day 8-team round robin", () => {
    const problem = badmintonRoundRobin({});
    expect(generateScheduleCandidates(problem, { maxIterations: 4 })).toEqual([]);
    const [diagnostic] = diagnoseScheduleInfeasibility(problem);
    expect(diagnostic).toMatchObject({ code: "maximum_matches_per_day", severity: "required" });
    expect(diagnostic!.matchIds).toHaveLength(28);
    expect(diagnostic!.message).toContain("up to 7 matches");
    expect(diagnostic!.message).toContain("at least 7");
  });

  it("reports venue capacity (QA scenario 4: 28 matches on 12 slots) per playing area", () => {
    const problem = badmintonRoundRobin({ maximumMatchesPerDay: setting("required", { matches: 7 }) }, 6);
    expect(codes(problem)).toEqual(["insufficient_capacity"]);
    const [diagnostic] = diagnoseScheduleInfeasibility(problem);
    expect(diagnostic!.message).toContain("28 matches of 30 minutes need 840 court-minutes");
    expect(diagnostic!.message).toContain("12 slots (360 court-minutes)");
    expect(diagnostic!.message).toContain("court-1: 6 slots; court-2: 6 slots");
  });

  it("reports required rest that cannot fit and stays silent when rest is not the cause", () => {
    const problem = badmintonRoundRobin({
      maximumMatchesPerDay: setting("required", { matches: 7 }),
      minimumRest: setting("required", { minutes: 120 }),
    });
    expect(validIterations(problem, 4)).toBe(0);
    expect(codes(problem)).toEqual(["minimum_rest"]);
    expect(diagnoseScheduleInfeasibility(problem)[0]!.message).toContain("only 4 fit");
    expect(codes(badmintonRoundRobin({ maximumMatchesPerDay: setting("required", { matches: 7 }) })).length).toBe(0);
  });

  it("reports knockout rounds that cannot follow their prerequisites, and locks placed too early", () => {
    const semi = (id: string, entries: string[]): SchedulingMatch => ({
      id,
      divisionId: "cup",
      durationMinutes: 30,
      dependencyMatchIds: [],
      possibleEntryIds: entries,
      officialIds: [],
      isChampionshipFinal: false,
    });
    const final: SchedulingMatch = {
      ...semi("final", ["a", "b", "c", "d"]),
      dependencyMatchIds: ["semi-1", "semi-2"],
      isChampionshipFinal: true,
    };
    const base: ScheduleProblem = {
      timeZone: "Asia/Singapore",
      objective: "balanced",
      matches: [semi("semi-1", ["a", "b"]), semi("semi-2", ["c", "d"]), final],
      slots: courtSlots(3, 1), // three courts, one simultaneous slot: the final can never follow
      constraints: defaults({ maximumMatchesPerDay: setting("required", { matches: 4 }) }),
    };
    expect(generateScheduleCandidates(base, { maxIterations: 2 })).toEqual([]);
    const [dependency] = diagnoseScheduleInfeasibility(base);
    expect(dependency).toMatchObject({ code: "dependency_order", matchIds: ["final", "semi-1", "semi-2"] });
    expect(dependency!.message).toContain("2026-11-14 09:30");

    const slots = courtSlots(1, 4);
    const locked: ScheduleProblem = {
      ...base,
      slots,
      matches: [
        base.matches[0]!,
        base.matches[1]!,
        {
          ...final,
          fixedAssignment: {
            reason: "locked",
            areaId: "court-1",
            slotId: slots[0]!.id,
            startEpochMs: slots[0]!.startEpochMs,
            endEpochMs: slots[0]!.endEpochMs,
          },
        },
      ],
    };
    const [lockDiagnostic] = diagnoseScheduleInfeasibility(locked);
    expect(lockDiagnostic).toMatchObject({ code: "dependency_order" });
    expect(lockDiagnostic!.message).toContain("Locked match final starts at 2026-11-14 09:00");
  });
});
