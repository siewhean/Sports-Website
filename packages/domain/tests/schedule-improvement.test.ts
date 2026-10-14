import { describe, expect, it } from "vitest";
import {
  evaluateScheduleQuality,
  generateConstraintAwareSchedule,
  generateScheduleCandidates,
  improveSchedule,
  measureScheduleShape,
  validateSchedule,
  type ConstraintMode,
  type ScheduleAssignment,
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

/** QA scenario 1: 8-team badminton round robin, 2 courts, 1 day, workspace defaults. */
function scenarioOne(overrides: Partial<SchedulingConstraints> = {}): ScheduleProblem {
  return {
    timeZone: "Asia/Singapore",
    objective: "balanced",
    matches: roundRobin(8),
    slots: courtSlots(2, 18),
    constraints: defaults(overrides),
  };
}

/** Four-team semi-final bracket after two pools, with an official and a locked semi-final. */
function bracketWithLock(): ScheduleProblem {
  const pools = [...roundRobin(4, "pool-a"), ...roundRobin(4, "pool-b")];
  const poolIds = pools.map((match) => match.id);
  const entries = [...new Set(pools.flatMap((match) => match.possibleEntryIds))];
  const lockedSlot = courtSlots(2, 18).find((slot) => slot.id === "court-1:10")!;
  const knockout: SchedulingMatch[] = [
    {
      id: "sf-1",
      divisionId: "ko",
      durationMinutes: 30,
      dependencyMatchIds: poolIds,
      possibleEntryIds: entries,
      officialIds: ["ref-1"],
      isChampionshipFinal: false,
      fixedAssignment: {
        reason: "locked",
        areaId: lockedSlot.areaId,
        slotId: lockedSlot.id,
        startEpochMs: lockedSlot.startEpochMs,
        endEpochMs: lockedSlot.endEpochMs,
      },
    },
    {
      id: "sf-2",
      divisionId: "ko",
      durationMinutes: 30,
      dependencyMatchIds: poolIds,
      possibleEntryIds: entries,
      officialIds: ["ref-1"],
      isChampionshipFinal: false,
    },
    {
      id: "final",
      divisionId: "ko",
      durationMinutes: 30,
      dependencyMatchIds: ["sf-1", "sf-2"],
      possibleEntryIds: entries,
      officialIds: ["ref-1"],
      isChampionshipFinal: true,
    },
  ];
  return {
    timeZone: "Asia/Singapore",
    objective: "balanced",
    matches: [...pools, ...knockout],
    slots: courtSlots(2, 18),
    constraints: defaults({
      minimumRest: setting("required", { minutes: 30 }),
      maximumMatchesPerDay: setting("required", { matches: 5 }),
    }),
  };
}

function hardViolations(problem: ScheduleProblem, assignments: readonly ScheduleAssignment[]) {
  return validateSchedule(problem, assignments).violations.filter((violation) => violation.severity !== "preferred");
}

describe("deterministic local search after construction", () => {
  it("improves QA scenario 1 without lowering the quality score", () => {
    const problem = scenarioOne();
    const constructed = generateConstraintAwareSchedule(problem);
    const improved = improveSchedule(problem, constructed, { seed: 0 });
    const before = measureScheduleShape(problem, constructed);
    const after = measureScheduleShape(problem, improved.assignments);

    expect(hardViolations(problem, improved.assignments)).toEqual([]);
    expect(evaluateScheduleQuality(problem, improved.assignments).score).toBeGreaterThanOrEqual(
      evaluateScheduleQuality(problem, constructed).score,
    );
    expect(improved.acceptedMoves).toBeGreaterThan(0);
    expect(after.backToBackCount).toBeLessThan(before.backToBackCount);
    expect(after.courtLoadSpreadMinutes).toBeLessThanOrEqual(before.courtLoadSpreadMinutes);
  });

  it("is deterministic for a given seed", () => {
    const problem = scenarioOne();
    const constructed = generateConstraintAwareSchedule(problem);
    expect(improveSchedule(problem, constructed, { seed: 7 })).toEqual(
      improveSchedule(problem, constructed, { seed: 7 }),
    );
  });

  it("never breaks hard or required constraints and never moves locked matches", () => {
    const problem = bracketWithLock();
    const candidates = generateScheduleCandidates(problem, { startIteration: 0, maxIterations: 6 });
    expect(candidates.length).toBeGreaterThan(0);
    let accepted = 0;
    for (const candidate of candidates) {
      for (const seed of [0, 1, 2]) {
        const improved = improveSchedule(problem, candidate.assignments, {
          seed: candidate.iteration * 10 + seed,
          maxMoveEvaluations: 3_000,
        });
        accepted += improved.acceptedMoves;
        expect(hardViolations(problem, improved.assignments)).toEqual([]);
        const locked = improved.assignments.find((assignment) => assignment.matchId === "sf-1")!;
        expect(locked.slotId).toBe("court-1:10");
        const final = improved.assignments.find((assignment) => assignment.matchId === "final")!;
        const semis = improved.assignments.filter((assignment) => assignment.matchId.startsWith("sf-"));
        expect(semis.every((semi) => semi.endEpochMs + 30 * MINUTE_MS <= final.startEpochMs)).toBe(true);
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it("returns an invalid input unchanged", () => {
    const problem = scenarioOne();
    const constructed = generateConstraintAwareSchedule(problem);
    const broken = constructed.map((assignment, index) =>
      index === 1
        ? { ...assignment, slotId: constructed[0]!.slotId, startEpochMs: constructed[0]!.startEpochMs }
        : assignment,
    );
    expect(improveSchedule(problem, broken, { seed: 0 })).toMatchObject({ acceptedMoves: 0 });
  });
});

describe("minimal change when regenerating (QA scenario 7)", () => {
  // Publish scenario 1, close court 2 from 13:00 to 15:00, regenerate preferring the old schedule.
  const base = scenarioOne({ minimumRest: setting("ignored", { minutes: 60 }) });
  const published = generateConstraintAwareSchedule(base);
  const closedFrom = DAY_START + 4 * 60 * MINUTE_MS;
  const closedTo = DAY_START + 6 * 60 * MINUTE_MS;
  const displaced = published.filter(
    (assignment) =>
      assignment.areaId === "court-2" && assignment.startEpochMs >= closedFrom && assignment.startEpochMs < closedTo,
  ).length;
  const repair: ScheduleProblem = {
    ...base,
    slots: base.slots.filter(
      (slot) => !(slot.areaId === "court-2" && slot.startEpochMs >= closedFrom && slot.startEpochMs < closedTo),
    ),
    constraints: {
      ...base.constraints,
      preserveExistingSchedule: setting(
        "preferred",
        {
          maximumShiftMinutes: 30,
          byMatchId: Object.fromEntries(
            published.map((assignment) => [
              assignment.matchId,
              { areaId: assignment.areaId, startEpochMs: assignment.startEpochMs },
            ]),
          ),
        },
        50,
      ),
    },
  };

  it("moves only the matches the closure displaces, on every iteration", () => {
    expect(displaced).toBeGreaterThan(0);
    const candidates = generateScheduleCandidates(repair, { startIteration: 0, maxIterations: 8 });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(hardViolations(repair, candidate.assignments)).toEqual([]);
      expect(measureScheduleShape(repair, candidate.assignments).movedMatchCount).toBe(displaced);
    }
  });

  it("local search keeps the change minimal", () => {
    const constructed = generateConstraintAwareSchedule(repair);
    const improved = improveSchedule(repair, constructed, { seed: 3 });
    expect(measureScheduleShape(repair, improved.assignments).movedMatchCount).toBe(displaced);
    expect(hardViolations(repair, improved.assignments)).toEqual([]);
  });
});

describe("moved matches outrank every shape term (QA scenario 5 regeneration)", () => {
  // Three matches on one court. Team A plays back to back at 09:00 and 09:30 while team B rests
  // until 17:30, so relocating A's second match to the free 17:30 slot on court 2 removes a
  // back-to-back, 60 minutes of rest shortfall, and all rest unfairness: a shape gain well above
  // the former 1000-per-move weight. With the previous revision preserved and every previous slot
  // still valid, nothing may move regardless.
  const slots = courtSlots(2, 18);
  const slot = (id: string) => slots.find((candidate) => candidate.id === id)!;
  const matches: SchedulingMatch[] = (
    [
      ["m1", ["team-a", "team-b"]],
      ["m2", ["team-a", "team-c"]],
      ["m3", ["team-b", "team-d"]],
    ] as const
  ).map(([id, entries]) => ({
    id,
    divisionId: "rr",
    durationMinutes: 30,
    dependencyMatchIds: [],
    possibleEntryIds: [...entries],
    officialIds: [],
    isChampionshipFinal: false,
  }));
  const previous: ScheduleAssignment[] = (
    [
      ["m1", "court-1:1"],
      ["m2", "court-1:2"],
      ["m3", "court-1:18"],
    ] as const
  ).map(([matchId, slotId]) => {
    const target = slot(slotId);
    return {
      matchId,
      divisionId: "rr",
      areaId: target.areaId,
      intervalId: target.intervalId,
      slotId: target.id,
      startEpochMs: target.startEpochMs,
      endEpochMs: target.endEpochMs,
      fixed: false,
    };
  });
  const byMatchId = Object.fromEntries(
    previous.map((assignment) => [
      assignment.matchId,
      { areaId: assignment.areaId, startEpochMs: assignment.startEpochMs },
    ]),
  );
  const regeneration = (lockedMatchId?: string): ScheduleProblem => ({
    timeZone: "Asia/Singapore",
    objective: "rest_focused",
    matches: matches.map((match) => {
      if (match.id !== lockedMatchId) return match;
      const locked = previous.find((assignment) => assignment.matchId === lockedMatchId)!;
      return {
        ...match,
        fixedAssignment: {
          reason: "locked",
          areaId: locked.areaId,
          slotId: locked.slotId,
          startEpochMs: locked.startEpochMs,
          endEpochMs: locked.endEpochMs,
        },
      };
    }),
    slots,
    constraints: defaults({
      preserveExistingSchedule: setting("preferred", { maximumShiftMinutes: 0, byMatchId }, 1),
    }),
  });
  const placementsOf = (assignments: readonly ScheduleAssignment[]) =>
    [...assignments]
      .sort((left, right) => left.matchId.localeCompare(right.matchId))
      .map(({ matchId, areaId, startEpochMs }) => ({ matchId, areaId, startEpochMs }));

  it("has a shape improvement available that the search would otherwise take", () => {
    const unpreserved: ScheduleProblem = {
      ...regeneration(),
      constraints: defaults({
        preserveExistingSchedule: setting("ignored", { maximumShiftMinutes: 0, byMatchId: {} }),
      }),
    };
    const improved = improveSchedule(unpreserved, previous, { seed: 1 });
    expect(improved.acceptedMoves).toBeGreaterThan(0);
    expect(measureScheduleShape(regeneration(), improved.assignments).movedMatchCount).toBeGreaterThan(0);
  });

  it("keeps every unlocked match in its still-valid previous slot", () => {
    for (const seed of [1, 2, 3, 5, 8]) {
      const problem = regeneration();
      const improved = improveSchedule(problem, previous, { seed });
      expect(measureScheduleShape(problem, improved.assignments).movedMatchCount).toBe(0);
      expect(placementsOf(improved.assignments)).toEqual(placementsOf(previous));
      expect(hardViolations(problem, improved.assignments)).toEqual([]);
    }
  });

  it("keeps every unlocked match put when one match is locked in place, as scenario 5 regenerates", () => {
    const problem = regeneration("m1");
    const start = previous.map((assignment) => ({ ...assignment, fixed: assignment.matchId === "m1" }));
    for (const seed of [1, 2, 3, 5, 8]) {
      const improved = improveSchedule(problem, start, { seed });
      expect(measureScheduleShape(problem, improved.assignments).movedMatchCount).toBe(0);
      expect(placementsOf(improved.assignments)).toEqual(placementsOf(previous));
    }
    // Constructing from the same inputs keeps the previous placements too: no candidate drifts.
    for (const candidate of generateScheduleCandidates(problem, { startIteration: 0, maxIterations: 4 })) {
      expect(measureScheduleShape(problem, candidate.assignments).movedMatchCount).toBe(0);
    }
  });
});
