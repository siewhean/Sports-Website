import { readFileSync } from "node:fs";
import type { ScheduleJobInput } from "@matchday/contracts";
import { describe, expect, it } from "vitest";

import { DomainScheduleOptimizer } from "../../src/domain-optimizer.js";

// QA mock tournament scenario 2 (2026-10-11): canoe polo "Championship focus" for divisions of
// 16/12/8/16 entries, 104 matches on 4 courts over 2 days (144 slots), with the workspace default
// constraints (preferred rest 60, preferred balance, daily cap 4). Before the fix every iteration
// returned no candidate: preference-led greedy placement used up the slots the knockouts needed.
const input = JSON.parse(
  readFileSync(new URL("../fixtures/qa-canoe-polo-104-matches.json", import.meta.url), "utf8"),
) as ScheduleJobInput;

describe("QA scenario 2: preferred constraints never cause no_solution", () => {
  it("yields a valid schedule on every iteration with default preferences", async () => {
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

    expect(candidates.map((candidate) => candidate.iteration)).toEqual([0, 1, 2]);
    for (const { result } of candidates) {
      expect(result.assignments).toHaveLength(104);
      expect(result.quality?.valid).toBe(true);
      expect(result.violations.filter((violation) => violation.severity !== "preferred")).toEqual([]);
    }
  }, 120_000);
});
