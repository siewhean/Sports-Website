import type { ScheduleJobInput } from "@matchday/contracts";
import { describe, expect, it } from "vitest";

import { DomainScheduleOptimizer } from "../../src/domain-optimizer.js";
import { scheduleInput } from "../fixtures.js";

describe("DomainScheduleOptimizer", () => {
  it("maps strict transport input into deterministic valid candidate iterations", async () => {
    const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 3, workerExecArgv: [] });
    const input = solvableInput();
    optimizer.validateInput(input);

    const first = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 1_000,
      }),
    );
    const replay = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 1_000,
      }),
    );

    expect(first).toEqual(replay);
    expect(first.length).toBeGreaterThan(0);
    expect(
      (await Promise.all(first.map(({ result }) => optimizer.verifyCandidate(input, result)))).every(
        (result) => result !== null,
      ),
    ).toBe(true);
    expect(first.map(({ iteration }) => iteration)).toEqual(
      [...first.map(({ iteration }) => iteration)].sort((a, b) => a - b),
    );
  });

  it("treats an ordinary placement dead end as no candidate instead of invalid persisted input", async () => {
    const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 3, workerExecArgv: [] });
    const input = impossibleRestInput();
    optimizer.validateInput(input);

    await expect(
      collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 1_000,
        }),
      ),
    ).resolves.toEqual([]);
  });

  it("recomputes quality and violations instead of trusting forged solver provenance", async () => {
    const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 1 });
    const input = solvableInput();
    const [generated] = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 1_000,
      }),
    );
    expect(generated).toBeDefined();
    const forged = {
      ...generated!.result,
      quality: {
        ...generated!.result.quality,
        score: 999,
        objective: "fastest" as const,
        preferred_penalty: -999,
        components: [],
      },
      violations: [],
    };

    const verified = await optimizer.verifyCandidate(input, forged);

    expect(verified?.quality.score).not.toBe(999);
    expect(verified?.quality.objective).toBe("balanced");
    expect(verified?.quality.preferred_penalty).toBeGreaterThanOrEqual(0);
    expect(verified?.quality.components.length).toBeGreaterThan(0);
  });

  it("rejects unknown persisted input fields instead of silently ignoring them", () => {
    const optimizer = new DomainScheduleOptimizer();
    const forged = { ...solvableInput(), unexpected_override: true } as ScheduleJobInput;
    expect(() => optimizer.validateInput(forged)).toThrow("strict schedule schema");
  });

  it.each([
    ["schema version", { schema_version: 99 }],
    ["job identity", { job_id: "" }],
    ["competition identity", { competition_id: "not-a-uuid" }],
    ["source revision", { source_revision: 0 }],
    ["empty matches", { matches: [] }],
    ["empty slots", { slots: [] }],
  ])("rejects malformed %s before candidate generation", (_label, change) => {
    const optimizer = new DomainScheduleOptimizer();
    const malformed = { ...solvableInput(), ...change } as ScheduleJobInput;
    expect(() => optimizer.validateInput(malformed)).toThrow();
  });

  it("stops between deterministic iterations when cancellation is signalled", async () => {
    const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 10 });
    const abort = new AbortController();
    const iterator = optimizer
      .optimize({
        input: solvableInput(),
        seed: null,
        startIteration: 0,
        signal: abort.signal,
        maxYieldIntervalMs: 1_000,
      })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    abort.abort();
    expect((await iterator.next()).done).toBe(true);
  });
});

function solvableInput(): ScheduleJobInput {
  const base = scheduleInput();
  const start = Date.UTC(2026, 6, 20, 1, 0);
  return {
    ...base,
    matches: [
      {
        match_id: "match-1",
        division_id: "division-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["entry-1", "entry-2"],
        official_ids: [],
        is_championship_final: true,
      },
    ],
    slots: [0, 1, 2].map((offset) => ({
      slot_id: `slot-${offset + 1}`,
      interval_id: "interval-1",
      area_id: "area-1",
      start_epoch_ms: start + offset * 30 * 60_000,
      end_epoch_ms: start + (offset + 1) * 30 * 60_000,
    })),
    constraints: {
      ...base.constraints,
      preferred_final_time: {
        mode: "preferred",
        weight: 1,
        value: { target_start_epoch_ms: start, tolerance_minutes: 30 },
      },
      featured_playing_area: { mode: "ignored", value: { area_id: "area-1", match_ids: [] } },
    },
  };
}

function impossibleRestInput(): ScheduleJobInput {
  const base = solvableInput();
  const start = base.slots[0]!.start_epoch_ms;
  return {
    ...base,
    matches: [
      {
        match_id: "match-1",
        division_id: "division-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["entry-1", "entry-2"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "match-2",
        division_id: "division-1",
        duration_minutes: 30,
        dependency_match_ids: ["match-1"],
        possible_entry_ids: ["entry-1", "entry-2"],
        official_ids: [],
        is_championship_final: true,
      },
    ],
    slots: [0, 1].map((offset) => ({
      slot_id: `tight-slot-${offset + 1}`,
      interval_id: "tight-interval",
      area_id: "area-1",
      start_epoch_ms: start + offset * 30 * 60_000,
      end_epoch_ms: start + (offset + 1) * 30 * 60_000,
    })),
    constraints: {
      ...base.constraints,
      minimum_rest: { mode: "required", value: { minutes: 30 } },
      preferred_final_time: {
        mode: "ignored",
        value: { target_start_epoch_ms: start, tolerance_minutes: 30 },
      },
    },
  };
}

async function collect<Result>(iterable: AsyncIterable<Result>): Promise<Result[]> {
  const values: Result[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
