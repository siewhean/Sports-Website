import { describe, expect, it } from "vitest";
import type { ScheduleJob, ScheduleOption } from "./phase4-schedule";
import { isAdvancedScheduleView, v1ScheduleObjective, v1ScheduleOption, v1ScheduleProgress } from "./v1-schedule";

function option(objective: ScheduleOption["objective"]): ScheduleOption {
  return {
    id: objective,
    jobId: "job",
    jobRevision: 1,
    resultRevision: 1,
    objective,
    quality: {
      score: 1,
      objective,
      valid: true,
      makespanMinutes: 1,
      minimumRestMinutes: null,
      maximumMatchesPerEntryDay: 1,
      preferredFinalDeltaMinutes: null,
      requiredViolationCount: 0,
      preferredPenalty: 0,
      components: [],
    },
    assignments: [],
    violations: [],
    assignmentHash: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("V1 schedule defaults", () => {
  it("uses only the balanced recommendation for the default journey", () => {
    const balanced = option("balanced");
    expect(v1ScheduleObjective).toBe("balanced");
    expect(v1ScheduleOption([option("fastest"), balanced, option("rest_focused")], option("fastest"))).toBe(balanced);
  });

  it("does not use a non-balanced best result as a default V1 schedule", () => {
    expect(v1ScheduleOption([option("fastest")], option("fastest"))).toBeNull();
  });

  it("requires an explicit advanced query value", () => {
    expect(isAdvancedScheduleView(undefined)).toBe(false);
    expect(isAdvancedScheduleView("true")).toBe(false);
    expect(isAdvancedScheduleView("1")).toBe(true);
  });

  it.each([
    ["queued", "creating"],
    ["running", "creating"],
    ["cancelling", "creating"],
    ["failed", "terminal"],
    ["no_solution", "terminal"],
    ["stale", "terminal"],
    ["cancelled", "terminal"],
  ] as const)("reports %s jobs without a candidate as %s", (status, expected) => {
    expect(v1ScheduleProgress(job(status))).toBe(expected);
  });
});

function job(status: ScheduleJob["status"]): ScheduleJob {
  return {
    id: "job",
    revision: 1,
    sourceRevision: 1,
    capacityRevision: 1,
    status,
    objective: "balanced",
    currentBest: null,
    progressIteration: null,
    exploredCandidates: 0,
    progressUpdatedAt: null,
    cancellationRequestedAt: null,
    failureClass: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
