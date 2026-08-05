import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createDefaultFormatTemplates,
  assertResolvedMatchParticipants,
  deriveSchedulingMatches,
  evaluateScheduleQuality,
  generateConstraintAwareSchedule,
  generateScheduleCandidates,
  intrinsicScheduleHardConstraints,
  toScheduleJobInput,
  validateSchedule,
  type ConstraintMode,
  type DefaultFormatEntryCount,
  type ScheduleAssignment,
  type ScheduleProblem,
  type SchedulingConstraints,
  type SchedulingMatch,
  type SchedulingSlot,
} from "../src/index.js";

const MINUTE_MS = 60_000;
const START = Date.parse("2026-08-01T01:00:00.000Z"); // 09:00 Asia/Singapore

function setting<T>(mode: ConstraintMode, value: T, weight?: number) {
  return { mode, value, ...(weight === undefined ? {} : { weight }) };
}

function constraints(overrides: Partial<SchedulingConstraints> = {}): SchedulingConstraints {
  return {
    minimumRest: setting("ignored", { minutes: 30 }),
    maximumMatchesPerDay: setting("ignored", { matches: 4 }),
    preferredFinalTime: setting("ignored", { targetStartEpochMs: START + 8 * 60 * MINUTE_MS, toleranceMinutes: 30 }),
    entryUnavailable: setting("ignored", { byEntryId: {} }),
    officialAvailability: setting("ignored", { byOfficialId: {} }),
    featuredPlayingArea: setting("ignored", { areaId: "area-1", matchIds: [] }),
    avoidConsecutiveMatches: setting("ignored", { minutes: 30 }),
    balanceEarlyMatches: setting("ignored", { beforeLocalTime: "10:00" }),
    balanceLateMatches: setting("ignored", { atOrAfterLocalTime: "17:00" }),
    keepDivisionTogether: setting("ignored", { maximumAreaCount: 2 }),
    preserveExistingSchedule: setting("ignored", { maximumShiftMinutes: 0, byMatchId: {} }),
    ...overrides,
  };
}

function slots(count: number, areas = 1, spacingMinutes = 30, start = START): SchedulingSlot[] {
  return Array.from({ length: count }, (_, index) => {
    const timeIndex = Math.floor(index / areas);
    const areaIndex = index % areas;
    return {
      id: `slot-${String(index + 1).padStart(3, "0")}`,
      intervalId: `interval-${areaIndex + 1}`,
      areaId: `area-${areaIndex + 1}`,
      startEpochMs: start + timeIndex * spacingMinutes * MINUTE_MS,
      endEpochMs: start + (timeIndex * spacingMinutes + 30) * MINUTE_MS,
    };
  });
}

function simpleMatch(
  id: string,
  possibleEntryIds: readonly string[],
  dependencyMatchIds: readonly string[] = [],
  extra: Partial<SchedulingMatch> = {},
): SchedulingMatch {
  return {
    id,
    divisionId: "open",
    durationMinutes: 30,
    dependencyMatchIds,
    possibleEntryIds,
    officialIds: [],
    isChampionshipFinal: false,
    ...extra,
  };
}

function problem(
  matches: readonly SchedulingMatch[],
  availableSlots: readonly SchedulingSlot[],
  configured: SchedulingConstraints = constraints(),
  objective: ScheduleProblem["objective"] = "balanced",
  timeZone = "Asia/Singapore",
): ScheduleProblem {
  return { timeZone, objective, matches, slots: availableSlots, constraints: configured };
}

function assignment(match: SchedulingMatch, slot: SchedulingSlot, fixed = false): ScheduleAssignment {
  return {
    matchId: match.id,
    divisionId: match.divisionId,
    areaId: slot.areaId,
    intervalId: slot.intervalId,
    slotId: slot.id,
    startEpochMs: slot.startEpochMs,
    endEpochMs: slot.endEpochMs,
    fixed,
  };
}

function compactMatches(size: DefaultFormatEntryCount, divisionId = "open", prefix = `e${size}-`) {
  const graph = createDefaultFormatTemplates(size).find((template) => template.strategy === "compact_knockout")!.graph;
  return deriveSchedulingMatches(
    graph,
    divisionId,
    Object.fromEntries(Array.from({ length: size }, (_, index) => [index + 1, `${prefix}${index + 1}`])),
    30,
  );
}

describe("Phase 4 scheduling contracts and hard constraints", () => {
  it("publishes an explicit non-downgradable intrinsic hard-constraint set", () => {
    expect(intrinsicScheduleHardConstraints).toEqual([
      "entry_overlap",
      "playing_area_overlap",
      "dependency_order",
      "playing_area_availability",
      "fixed_match_immutability",
      "official_overlap",
      "full_slot_occupancy",
    ]);
  });

  it("rejects empty match or slot problems instead of producing a valid empty schedule", () => {
    expect(() => generateConstraintAwareSchedule(problem([], slots(1)))).toThrow(/at least one match/);
    expect(() => generateConstraintAwareSchedule(problem([simpleMatch("one", ["a", "b"])], []))).toThrow(
      /at least one available slot/,
    );
    expect(() => generateScheduleCandidates(problem([], []))).toThrow(/at least one match/);
  });

  it("propagates every possible participant and dependency into unresolved advancement", () => {
    const matches = compactMatches(8);
    const final = matches.find((match) => match.isChampionshipFinal)!;
    expect(final.possibleEntryIds).toEqual(Array.from({ length: 8 }, (_, index) => `e8-${index + 1}`));
    expect(final.dependencyMatchIds).toHaveLength(2);
  });

  it("propagates a manual qualifier from its complete prior-stage participant universe", () => {
    const template = createDefaultFormatTemplates(8).find((candidate) => candidate.strategy === "full_placement")!;
    const target = template.graph.matches.find((match) => match.stageId === "championship")!;
    const graph = {
      ...template.graph,
      matches: template.graph.matches.map((match) =>
        match.id === target.id
          ? {
              ...match,
              home: { type: "manual_qualifier" as const, qualifierId: "wildcard-1", stageId: "groups" },
            }
          : match,
      ),
    };
    const derived = deriveSchedulingMatches(
      graph,
      "open",
      Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, `entry-${index + 1}`])),
      30,
    );
    const scheduled = derived.find((match) => match.id === target.id)!;
    expect(scheduled.possibleEntryIds).toEqual(Array.from({ length: 8 }, (_, index) => `entry-${index + 1}`));
    expect(scheduled.dependencyMatchIds).toEqual(
      template.graph.stages.find((stage) => stage.id === "groups")!.matchIds,
    );
    expect(() => assertResolvedMatchParticipants(scheduled, ["entry-1", "entry-8"])).not.toThrow();
    expect(() => assertResolvedMatchParticipants(scheduled, ["entry-1", "outside"])).toThrow(
      /outside match .* possible-participant universe/,
    );
    const other = derived.find(
      (match) =>
        match.id !== scheduled.id && match.id.startsWith("championship") && match.possibleEntryIds.includes("entry-1"),
    )!;
    const simultaneous = slots(2, 2);
    const manualWithoutCompletedDependencies = { ...scheduled, dependencyMatchIds: [] };
    const otherWithoutCompletedDependencies = { ...other, dependencyMatchIds: [] };
    expect(
      validateSchedule(problem([manualWithoutCompletedDependencies, otherWithoutCompletedDependencies], simultaneous), [
        assignment(manualWithoutCompletedDependencies, simultaneous[0]!),
        assignment(otherWithoutCompletedDependencies, simultaneous[1]!),
      ]).violations,
    ).toContainEqual(expect.objectContaining({ code: "possible_entry_overlap", severity: "hard" }));
  });

  it("rejects blank possible participants and duplicate seed-to-entry identity mappings", () => {
    expect(() => generateConstraintAwareSchedule(problem([simpleMatch("bad", ["", "a"])], slots(1)))).toThrow(
      /unique non-empty possible entry IDs/,
    );
    const graph = createDefaultFormatTemplates(8).find((template) => template.strategy === "compact_knockout")!.graph;
    expect(() =>
      deriveSchedulingMatches(
        graph,
        "open",
        Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, index < 2 ? "same" : `e-${index}`])),
        30,
      ),
    ).toThrow(/unique non-empty entry ID/);
  });

  it("rejects area, possible-participant, official, dependency, full-slot, and fixed-match violations", () => {
    const available = [
      ...slots(1),
      { ...slots(1)[0]!, id: "overlap", intervalId: "overlap", areaId: "area-1" },
      { ...slots(1)[0]!, id: "other-area", intervalId: "other", areaId: "area-2" },
      { ...slots(1)[0]!, id: "wrong-duration", endEpochMs: START + 20 * MINUTE_MS },
    ];
    const first = simpleMatch("first", ["a", "b"], [], { officialIds: ["official-1"] });
    const second = simpleMatch("second", ["a", "c"], ["first"], { officialIds: ["official-1"] });
    const fixed = simpleMatch("fixed", ["d", "e"], [], {
      fixedAssignment: {
        reason: "published_history",
        areaId: "area-2",
        slotId: "other-area",
        startEpochMs: START,
        endEpochMs: START + 30 * MINUTE_MS,
      },
    });
    const result = validateSchedule(problem([first, second, fixed], available), [
      assignment(first, available[0]!),
      assignment(second, available[1]!),
      assignment(fixed, available[3]!),
    ]);
    expect(new Set(result.violations.map((violation) => violation.code))).toEqual(
      new Set([
        "area_overlap",
        "possible_entry_overlap",
        "official_overlap",
        "dependency_order",
        "slot_duration",
        "fixed_match_moved",
        "assignment_mismatch",
      ]),
    );
    expect(result.valid).toBe(false);
  });
});

describe("Phase 4 configurable constraint semantics", () => {
  it("allows preference weights only on preferred constraints", () => {
    const input = problem(
      [simpleMatch("one", ["a", "b"])],
      slots(1),
      constraints({ minimumRest: setting("required", { minutes: 30 }, 2) }),
    );
    expect(() => generateConstraintAwareSchedule(input)).toThrow(/weight is allowed only in preferred mode/);
  });

  it.each(["minimumRest", "maximumMatchesPerDay", "preferredFinalTime"] as const)(
    "%s distinguishes required, preferred, and ignored",
    (name) => {
      const first = simpleMatch("first", ["a", "b"]);
      const second = simpleMatch("second", ["a", "c"], [], { isChampionshipFinal: true });
      const available = slots(2, 1, 30);
      const assignments = [assignment(first, available[0]!), assignment(second, available[1]!)];
      const value =
        name === "minimumRest"
          ? { minutes: 60 }
          : name === "maximumMatchesPerDay"
            ? { matches: 1 }
            : { targetStartEpochMs: START + 180 * MINUTE_MS, toleranceMinutes: 0 };
      const code =
        name === "minimumRest"
          ? "minimum_rest"
          : name === "maximumMatchesPerDay"
            ? "maximum_matches_per_day"
            : "preferred_final_time";
      const configured = (mode: ConstraintMode) =>
        constraints({ [name]: setting(mode, value, mode === "preferred" ? 3 : undefined) });
      const required = validateSchedule(problem([first, second], available, configured("required")), assignments);
      const preferred = validateSchedule(problem([first, second], available, configured("preferred")), assignments);
      const ignored = validateSchedule(problem([first, second], available, configured("ignored")), assignments);
      expect(required.valid).toBe(false);
      expect(required.violations).toContainEqual(expect.objectContaining({ code, severity: "required" }));
      expect(preferred.valid).toBe(true);
      expect(preferred.violations).toContainEqual(expect.objectContaining({ code, severity: "preferred" }));
      expect(ignored.violations.some((violation) => violation.code === code)).toBe(false);
    },
  );

  it("counts maximum matches by the competition-local civil day across a UTC boundary", () => {
    const first = simpleMatch("before-midnight", ["a", "b"]);
    const second = simpleMatch("after-midnight", ["a", "c"]);
    const available = slots(2, 1, 30, Date.parse("2026-08-01T15:30:00.000Z"));
    const configured = constraints({ maximumMatchesPerDay: setting("required", { matches: 1 }) });
    expect(
      validateSchedule(problem([first, second], available, configured), [
        assignment(first, available[0]!),
        assignment(second, available[1]!),
      ]).valid,
    ).toBe(true);
  });

  it("rejects an impossible required daily match load before candidate search", () => {
    const matches = [simpleMatch("one", ["a", "b"]), simpleMatch("two", ["a", "c"]), simpleMatch("three", ["a", "d"])];
    const configured = constraints({ maximumMatchesPerDay: setting("required", { matches: 2 }) });
    expect(generateScheduleCandidates(problem(matches, slots(3), configured), { maxIterations: 3 })).toEqual([]);
  });

  it("enforces entry/official availability, featured area, division cohesion, and existing schedule preservation", () => {
    const match = simpleMatch("featured", ["a", "b"], [], { officialIds: ["o1"] });
    const available = slots(2, 2);
    const configured = constraints({
      entryUnavailable: setting("required", {
        byEntryId: { a: [{ startEpochMs: START, endEpochMs: START + 30 * MINUTE_MS }] },
      }),
      officialAvailability: setting("required", {
        byOfficialId: { o1: [{ startEpochMs: START + 60 * MINUTE_MS, endEpochMs: START + 90 * MINUTE_MS }] },
      }),
      featuredPlayingArea: setting("required", { areaId: "area-2", matchIds: ["featured"] }),
      keepDivisionTogether: setting("required", { maximumAreaCount: 1 }),
      preserveExistingSchedule: setting("required", {
        maximumShiftMinutes: 0,
        byMatchId: { featured: { areaId: "area-2", startEpochMs: START + 60 * MINUTE_MS } },
      }),
    });
    const invalid = validateSchedule(problem([match], available, configured), [assignment(match, available[0]!)]);
    expect(new Set(invalid.violations.map((violation) => violation.code))).toEqual(
      new Set(["entry_unavailable", "official_unavailable", "featured_playing_area", "existing_schedule_moved"]),
    );
  });

  it("fails closed when required official availability omits an assigned official", () => {
    const match = simpleMatch("officiated", ["a", "b"], [], { officialIds: ["o1"] });
    const available = slots(1);
    const required = problem(
      [match],
      available,
      constraints({ officialAvailability: setting("required", { byOfficialId: {} }) }),
    );
    expect(validateSchedule(required, [assignment(match, available[0]!)]).violations).toContainEqual(
      expect.objectContaining({ code: "official_unavailable", severity: "required" }),
    );
    expect(() => generateConstraintAwareSchedule(required)).toThrow(/No valid slot remains/);

    const preferred = problem(
      [match],
      available,
      constraints({ officialAvailability: setting("preferred", { byOfficialId: {} }) }),
    );
    expect(validateSchedule(preferred, [assignment(match, available[0]!)]).violations).toContainEqual(
      expect.objectContaining({ code: "official_unavailable", severity: "preferred" }),
    );
    const ignored = problem(
      [match],
      available,
      constraints({ officialAvailability: setting("ignored", { byOfficialId: {} }) }),
    );
    expect(validateSchedule(ignored, [assignment(match, available[0]!)]).violations).toEqual([]);
  });

  it("rejects availability maps with entry or official IDs outside the immutable problem", () => {
    const match = simpleMatch("one", ["a", "b"], [], { officialIds: ["o1"] });
    expect(() =>
      generateConstraintAwareSchedule(
        problem([match], slots(1), constraints({ entryUnavailable: setting("ignored", { byEntryId: { typo: [] } }) })),
      ),
    ).toThrow(/unknown entry typo/);
    expect(() =>
      generateConstraintAwareSchedule(
        problem(
          [match],
          slots(1),
          constraints({ officialAvailability: setting("ignored", { byOfficialId: { typo: [] } }) }),
        ),
      ),
    ).toThrow(/unassigned official typo/);
  });

  it("applies preferred and ignored semantics to every remaining organiser constraint", () => {
    const matches = [
      simpleMatch("m1", ["a", "b"], [], { officialIds: ["o1"] }),
      simpleMatch("m2", ["a", "c"]),
      simpleMatch("m3", ["a", "d"]),
    ];
    const available: SchedulingSlot[] = [
      slots(1)[0]!,
      {
        ...slots(1)[0]!,
        id: "slot-2",
        intervalId: "i2",
        areaId: "area-2",
        startEpochMs: START + 30 * MINUTE_MS,
        endEpochMs: START + 60 * MINUTE_MS,
      },
      { ...slots(1)[0]!, id: "slot-3", startEpochMs: START + 60 * MINUTE_MS, endEpochMs: START + 90 * MINUTE_MS },
    ];
    const assignments = matches.map((match, index) => assignment(match, available[index]!));
    const configured = (mode: ConstraintMode) =>
      constraints({
        entryUnavailable: setting(mode, {
          byEntryId: { b: [{ startEpochMs: START, endEpochMs: START + 30 * MINUTE_MS }] },
        }),
        officialAvailability: setting(mode, { byOfficialId: { o1: [] } }),
        featuredPlayingArea: setting(mode, { areaId: "area-2", matchIds: ["m1"] }),
        avoidConsecutiveMatches: setting(mode, { minutes: 60 }),
        balanceEarlyMatches: setting(mode, { beforeLocalTime: "11:00" }),
        balanceLateMatches: setting(mode, { atOrAfterLocalTime: "09:00" }),
        keepDivisionTogether: setting(mode, { maximumAreaCount: 1 }),
        preserveExistingSchedule: setting(mode, {
          maximumShiftMinutes: 0,
          byMatchId: { m1: { areaId: "area-2", startEpochMs: START + 30 * MINUTE_MS } },
        }),
      });
    const expectedCodes = new Set([
      "entry_unavailable",
      "official_unavailable",
      "featured_playing_area",
      "consecutive_matches",
      "early_match_balance",
      "late_match_balance",
      "division_area_spread",
      "existing_schedule_moved",
    ]);
    const preferred = validateSchedule(problem(matches, available, configured("preferred")), assignments);
    expect(preferred.valid).toBe(true);
    expect(new Set(preferred.violations.map((violation) => violation.code))).toEqual(expectedCodes);
    expect(preferred.violations.every((violation) => violation.severity === "preferred")).toBe(true);
    const ignored = validateSchedule(problem(matches, available, configured("ignored")), assignments);
    expect(ignored.valid).toBe(true);
    expect(ignored.violations).toEqual([]);
  });
});

describe("Phase 4 objectives, quality, and worker boundary", () => {
  it("provides deterministic Fastest, Balanced, and Rest-focused candidates with explained persisted metrics", () => {
    const matches = [simpleMatch("one", ["a", "b"]), simpleMatch("two", ["a", "c"])] as const;
    const available = slots(5, 1, 60);
    const byObjective = (["fastest", "balanced", "rest_focused"] as const).map((objective) => {
      const input = problem(matches, available, constraints(), objective);
      const generated = generateConstraintAwareSchedule(input);
      expect(generated).toEqual(generateConstraintAwareSchedule(input));
      const quality = evaluateScheduleQuality(input, generated);
      expect(quality.valid).toBe(true);
      expect(quality.score).toBeGreaterThanOrEqual(0);
      expect(quality.score).toBeLessThanOrEqual(100);
      expect(quality.components).toHaveLength(11);
      expect(quality.components.reduce((total, component) => total + component.weight, 0)).toBe(100);
      expect(quality.components.every((component) => component.explanation.length > 20)).toBe(true);
      return { objective, generated, quality };
    });
    expect(byObjective[0]!.generated[1]!.startEpochMs).toBeLessThan(byObjective[2]!.generated[1]!.startEpochMs);
    expect(new Set(byObjective.map((result) => result.quality.objective))).toEqual(
      new Set(["fastest", "balanced", "rest_focused"]),
    );
    const selectedRest = (["fastest", "balanced", "rest_focused"] as const).map((objective) => {
      const input = problem(matches, available, constraints(), objective);
      const best = generateScheduleCandidates(input, { maxIterations: 64 })
        .map((candidate) => ({ candidate, quality: evaluateScheduleQuality(input, candidate.assignments) }))
        .sort(
          (left, right) =>
            right.quality.score - left.quality.score ||
            left.quality.preferredPenalty - right.quality.preferredPenalty ||
            left.candidate.iteration - right.candidate.iteration,
        )[0]!;
      return best.quality.minimumRestMinutes;
    });
    expect(selectedRest).toEqual([30, 90, 210]);
  });

  it("scores Fastest completion against problem-wide area capacity, not candidate area usage", () => {
    const matches = [simpleMatch("one", ["a", "b"]), simpleMatch("two", ["c", "d"])] as const;
    const available = slots(4, 2);
    const input = problem(matches, available, constraints(), "fastest");
    const simultaneous = [assignment(matches[0], available[0]!), assignment(matches[1], available[1]!)];
    const sequential = [assignment(matches[0], available[0]!), assignment(matches[1], available[2]!)];
    const fastQuality = evaluateScheduleQuality(input, simultaneous);
    const slowQuality = evaluateScheduleQuality(input, sequential);
    expect(fastQuality.makespanMinutes).toBe(30);
    expect(slowQuality.makespanMinutes).toBe(60);
    expect(fastQuality.components.find((component) => component.key === "completion")!.score).toBe(100);
    expect(slowQuality.components.find((component) => component.key === "completion")!.score).toBe(0);
    expect(fastQuality.score).toBeGreaterThan(slowQuality.score);
  });

  it("reports actual movement facts instead of the configured baseline size", () => {
    const matches = [simpleMatch("one", ["a", "b"]), simpleMatch("two", ["c", "d"])] as const;
    const available = slots(4, 2);
    const scheduled = [assignment(matches[0], available[0]!), assignment(matches[1], available[3]!)];
    const input = problem(
      matches,
      available,
      constraints({
        preserveExistingSchedule: setting("preferred", {
          maximumShiftMinutes: 0,
          byMatchId: {
            one: { areaId: scheduled[0]!.areaId, startEpochMs: scheduled[0]!.startEpochMs },
            two: { areaId: "area-1", startEpochMs: scheduled[1]!.startEpochMs - 30 * MINUTE_MS },
          },
        }),
      }),
    );
    const movement = evaluateScheduleQuality(input, scheduled).components.find(
      (component) => component.key === "schedule_preservation",
    )!;
    expect(movement.measured).toBe(1);
    expect(movement.unit).toBe("matches");
    expect(movement.explanation).toBe(
      "1 of 2 existing assignments move; total start-time shift is 30 minutes with 1 playing-area change.",
    );
  });

  it.each(["fastest", "balanced", "rest_focused"] as const)(
    "%s candidates never cross a hard or required constraint boundary",
    (objective) => {
      const matches = [simpleMatch("one", ["a", "b"]), simpleMatch("two", ["a", "c"])] as const;
      const input = problem(
        matches,
        slots(8, 1, 60),
        constraints({ minimumRest: setting("required", { minutes: 30 }) }),
        objective,
      );
      const candidates = generateScheduleCandidates(input, { maxIterations: 64 });
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        const validation = validateSchedule(input, candidate.assignments);
        expect(validation.valid).toBe(true);
        expect(validation.violations.some((violation) => violation.severity !== "preferred")).toBe(false);
      }
    },
  );

  it("retains a feasibility-first candidate when rest-focused ranking consumes a dependency slot", () => {
    const matches = [simpleMatch("a", ["x", "y"]), simpleMatch("b", ["x", "z"]), simpleMatch("c", ["z", "w"], ["b"])];
    const input = problem(matches, slots(3), constraints(), "rest_focused");

    const candidates = generateScheduleCandidates(input, { maxIterations: 1 });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.assignments.map((item) => item.slotId)).toEqual(["slot-001", "slot-002", "slot-003"]);
    expect(validateSchedule(input, candidates[0]!.assignments).valid).toBe(true);
    expect(evaluateScheduleQuality(input, candidates[0]!.assignments).objective).toBe("rest_focused");
  });

  it("offers bounded resumable candidate iterations and validates a seed checkpoint", () => {
    const input = problem([simpleMatch("one", ["a", "b"]), simpleMatch("two", ["a", "c"])], slots(8, 1, 60));
    const first = generateScheduleCandidates(input, { startIteration: 0, maxIterations: 4 });
    expect(first.length).toBeGreaterThan(1);
    const resumed = generateScheduleCandidates(input, {
      startIteration: 4,
      maxIterations: 4,
      seedAssignments: first[0]!.assignments,
    });
    expect(resumed[0]).toEqual({ iteration: 4, assignments: first[0]!.assignments });
    expect(resumed.every((candidate) => validateSchedule(input, candidate.assignments).valid)).toBe(true);
  });

  it("optimises preferred choices beyond the first four candidates and explores every relevant slot", () => {
    const match = simpleMatch("featured", ["a", "b"]);
    const available = slots(5, 5);
    const preferred = problem(
      [match],
      available,
      constraints({
        featuredPlayingArea: setting("preferred", { areaId: "area-5", matchIds: ["featured"] }, 100),
        preserveExistingSchedule: setting(
          "preferred",
          { maximumShiftMinutes: 0, byMatchId: { featured: { areaId: "area-5", startEpochMs: START } } },
          100,
        ),
      }),
      "balanced",
    );
    expect(generateConstraintAwareSchedule(preferred)[0]!.areaId).toBe("area-5");

    const exploratory = problem([match], available, constraints(), "balanced");
    const candidates = generateScheduleCandidates(exploratory, { maxIterations: 64 });
    expect(new Set(candidates.map((candidate) => candidate.assignments[0]!.areaId))).toEqual(
      new Set(["area-1", "area-2", "area-3", "area-4", "area-5"]),
    );
  });

  it("ranks preferred entry and official availability across more than four time choices", () => {
    const match = simpleMatch("available-late", ["a", "b"], [], { officialIds: ["o1"] });
    const available = slots(5, 1, 60);
    const fifth = available[4]!;
    const input = problem(
      [match],
      available,
      constraints({
        entryUnavailable: setting(
          "preferred",
          { byEntryId: { a: [{ startEpochMs: START, endEpochMs: fifth.startEpochMs }] } },
          100,
        ),
        officialAvailability: setting(
          "preferred",
          { byOfficialId: { o1: [{ startEpochMs: fifth.startEpochMs, endEpochMs: fifth.endEpochMs }] } },
          100,
        ),
      }),
      "fastest",
    );
    expect(generateConstraintAwareSchedule(input)[0]!.slotId).toBe(fifth.id);
  });

  it("serializes a versioned immutable worker payload without host-timezone fields", () => {
    const input = problem([simpleMatch("one", ["a", "b"])], slots(1));
    expect(
      toScheduleJobInput(input, {
        jobId: "10000000-0000-4000-a000-000000000001",
        competitionId: "20000000-0000-4000-a000-000000000001",
        sourceRevision: 7,
        capacityRevision: 3,
        capacityHash: "a".repeat(64),
      }),
    ).toEqual(
      expect.objectContaining({
        schema_version: 1,
        job_id: "10000000-0000-4000-a000-000000000001",
        competition_id: "20000000-0000-4000-a000-000000000001",
        source_revision: 7,
        capacity_revision: 3,
        capacity_hash: "a".repeat(64),
        time_zone: "Asia/Singapore",
        objective: "balanced",
      }),
    );
    expect(() =>
      toScheduleJobInput(input, {
        jobId: "10000000-0000-4000-a000-000000000001",
        competitionId: "20000000-0000-4000-a000-000000000001",
        sourceRevision: 7,
        capacityRevision: 0,
        capacityHash: "not-a-hash",
      }),
    ).toThrow(/Capacity revision/);
  });
});

describe("Phase 4 golden schedule oracles", () => {
  const oracle = JSON.parse(
    readFileSync(new URL("../../../validation/phase-4/schedules/golden-oracles.json", import.meta.url), "utf8"),
  ) as {
    sizes: Array<{
      entry_count: DefaultFormatEntryCount;
      expected_match_count: number;
      expected_span_minutes: number;
      expected_match_order: string[];
    }>;
    multi_division: {
      expected_match_count: number;
      expected_area_count: number;
      expected_simultaneous_pairs: number;
      expected_assignment_order: Array<[string, string, string]>;
    };
  };

  it.each(oracle.sizes)(
    "matches the deterministic $entry_count-entry assignment oracle",
    ({ entry_count, expected_match_count, expected_span_minutes, expected_match_order }) => {
      const matches = compactMatches(entry_count);
      const input = problem(matches, slots(matches.length), constraints(), "fastest");
      const generated = generateConstraintAwareSchedule(input);
      expect(generated).toHaveLength(expected_match_count);
      expect((generated.at(-1)!.endEpochMs - generated[0]!.startEpochMs) / MINUTE_MS).toBe(expected_span_minutes);
      expect(generated.map((item) => item.matchId)).toEqual(expected_match_order);
      expect(validateSchedule(input, generated).valid).toBe(true);
    },
  );

  it.each(oracle.sizes)(
    "keeps all three objectives feasible for the exact $entry_count-entry capacity oracle",
    ({ entry_count }) => {
      const matches = compactMatches(entry_count);
      for (const objective of ["fastest", "balanced", "rest_focused"] as const) {
        const input = problem(matches, slots(matches.length), constraints(), objective);
        expect(validateSchedule(input, generateConstraintAwareSchedule(input)).valid).toBe(true);
      }
    },
  );

  it("schedules two divisions concurrently without double-booking their shared areas", () => {
    const left = compactMatches(8, "women", "w-").map((match) => ({
      ...match,
      id: `w-${match.id}`,
      dependencyMatchIds: match.dependencyMatchIds.map((id) => `w-${id}`),
    }));
    const right = compactMatches(8, "open", "o-").map((match) => ({
      ...match,
      id: `o-${match.id}`,
      dependencyMatchIds: match.dependencyMatchIds.map((id) => `o-${id}`),
    }));
    const available = slots((left.length + right.length) * 2, 2);
    const input = problem([...left, ...right], available);
    const generated = generateConstraintAwareSchedule(input);
    expect(generated).toHaveLength(oracle.multi_division.expected_match_count);
    expect(new Set(generated.map((item) => item.divisionId))).toEqual(new Set(["women", "open"]));
    expect(new Set(generated.map((item) => item.areaId)).size).toBe(oracle.multi_division.expected_area_count);
    const simultaneousPairs = generated.flatMap((one, index) =>
      generated.slice(index + 1).filter((two) => one.startEpochMs === two.startEpochMs && one.areaId !== two.areaId),
    ).length;
    expect(simultaneousPairs).toBe(oracle.multi_division.expected_simultaneous_pairs);
    expect(generated.map((item) => [item.matchId, item.areaId, item.slotId])).toEqual(
      oracle.multi_division.expected_assignment_order,
    );
    expect(validateSchedule(input, generated).valid).toBe(true);
  });
});
