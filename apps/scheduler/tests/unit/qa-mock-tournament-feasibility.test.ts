import { readFileSync } from "node:fs";
import type { ScheduleJobInput } from "@matchday/contracts";
import { describe, expect, it } from "vitest";

import { generateScheduleCandidates, measureScheduleShape, validateSchedule } from "@matchday/domain";

import { DomainScheduleOptimizer, toDomainAssignment, toProblem } from "../../src/domain-optimizer.js";

// QA mock tournament scenario 2 (2026-10-11): canoe polo "Championship focus" for divisions of
// 16/12/8/16 entries, 104 matches on 4 courts over 2 days (144 slots), with the workspace default
// constraints (preferred rest 60, preferred balance, daily cap 4). Before the fix every iteration
// returned no candidate: preference-led greedy placement used up the slots the knockouts needed.
const input = JSON.parse(
  readFileSync(new URL("../fixtures/qa-canoe-polo-104-matches.json", import.meta.url), "utf8"),
) as ScheduleJobInput;

describe("QA scenario 2: preferred constraints never cause no_solution", () => {
  it("constructs a valid schedule on every greedy iteration with default preferences", () => {
    const problem = toProblem(input);
    const candidates = generateScheduleCandidates(problem, { startIteration: 0, maxIterations: 3 });
    expect(candidates.map((candidate) => candidate.iteration)).toEqual([0, 1, 2]);
    for (const candidate of candidates) {
      expect(candidate.assignments).toHaveLength(104);
      expect(validateSchedule(problem, candidate.assignments).valid).toBe(true);
    }
  });

  it("offers only valid schedules, the first with no back-to-backs", async () => {
    const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 3, workerExecArgv: [] });
    const candidates = [];
    for await (const candidate of optimizer.optimize({
      input,
      seed: null,
      startIteration: 0,
      signal: new AbortController().signal,
      maxYieldIntervalMs: 60_000,
    }))
      candidates.push(candidate);

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const problem = toProblem(input);
    const first = candidates[0]!.result.assignments.map(toDomainAssignment);
    expect(measureScheduleShape(problem, first).backToBackCount).toBe(0);
    for (const { result } of candidates) {
      expect(result.assignments).toHaveLength(104);
      expect(result.quality?.valid).toBe(true);
      expect(result.violations.filter((violation) => violation.severity !== "preferred")).toEqual([]);
    }
  }, 120_000);
});
