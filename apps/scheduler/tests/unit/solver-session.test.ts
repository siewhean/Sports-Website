import { readFileSync } from "node:fs";
import type { ScheduleJobInput } from "@matchday/contracts";
import { generateScheduleCandidates } from "@matchday/domain";
import { describe, expect, it, vi } from "vitest";

import { DomainScheduleOptimizer, toProblem } from "../../src/domain-optimizer.js";
import { SolverYieldDeadlineError } from "../../src/errors.js";

const workerStarts = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class CountingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workerStarts.count += 1;
    }
  }
  return { ...actual, Worker: CountingWorker };
});

// QA scenario 2: 104 canoe polo matches on 4 courts over 2 days (see qa-mock-tournament-feasibility).
const input = JSON.parse(
  readFileSync(new URL("../fixtures/qa-canoe-polo-104-matches.json", import.meta.url), "utf8"),
) as ScheduleJobInput;

describe("solver session", () => {
  it("serves a whole run, including candidate verification, from one solver thread", async () => {
    workerStarts.count = 0;
    const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 4, workerExecArgv: [] });
    const signal = new AbortController().signal;
    const verified = [];
    for await (const candidate of optimizer.optimize({
      input,
      seed: null,
      startIteration: 0,
      signal,
      maxYieldIntervalMs: 30_000,
    })) {
      verified.push(await optimizer.verifyCandidate(input, candidate.result, { signal, maxYieldIntervalMs: 30_000 }));
    }

    expect(verified).toHaveLength(4);
    expect(verified.every((result) => result?.quality.valid === true)).toBe(true);
    expect(workerStarts.count).toBe(1);
  }, 60_000);

  it("still terminates a solve that misses the yield deadline", async () => {
    const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 4, workerExecArgv: [] });
    const run = async () => {
      for await (const candidate of optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 1,
      }))
        void candidate;
    };
    await expect(run()).rejects.toBeInstanceOf(SolverYieldDeadlineError);
  }, 60_000);
});

describe("solver speed regression (QA scenario 2, 104 matches)", () => {
  it("is deterministic whether iterations run in one batch or one at a time, within a generous bound", () => {
    const problem = toProblem(input);
    const started = performance.now();
    const batch = generateScheduleCandidates(problem, { startIteration: 0, maxIterations: 32 });
    const elapsedMs = performance.now() - started;
    const single = Array.from({ length: 32 }, (_, iteration) =>
      generateScheduleCandidates(toProblem(input), { startIteration: iteration, maxIterations: 1 }),
    ).flat();

    // Batches deduplicate identical schedules, single steps cannot; compare per iteration.
    const byIteration = new Map(single.map((candidate) => [candidate.iteration, candidate.assignments]));
    for (const candidate of batch) expect(candidate.assignments).toEqual(byIteration.get(candidate.iteration));
    expect(single.every((candidate) => candidate.assignments.length === 104)).toBe(true);
    // Before indexed placement this took ~27 s (32 iterations); it now takes well under 2 s locally.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 120_000);
});
