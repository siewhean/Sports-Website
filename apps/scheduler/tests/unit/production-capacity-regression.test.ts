import type { ScheduleJobInput } from "@matchday/contracts";
import { describe, expect, it } from "vitest";

import { DomainScheduleOptimizer } from "../../src/domain-optimizer.js";
import { scheduleInput } from "../fixtures.js";

describe("production scheduling capacity regressions", () => {
  it("produces a valid balanced schedule when 36 required fixtures exactly fill 36 slots", async () => {
    const input = exactCapacityInput(36);
    const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 1, workerExecArgv: [] });

    const candidates = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 30_000,
      }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.result.assignments).toHaveLength(36);
    expect(new Set(candidates[0]?.result.assignments.map((assignment) => assignment.slot_id)).size).toBe(36);
    expect(candidates[0]?.result.quality?.valid).toBe(true);
    expect(
      await optimizer.verifyCandidate(input, candidates[0]!.result, {
        signal: new AbortController().signal,
        maxYieldIntervalMs: 30_000,
      }),
    ).not.toBeNull();
  });

  it("returns no solution instead of throwing a runtime failure when capacity is genuinely short", async () => {
    const input = exactCapacityInput(35);
    const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 1, workerExecArgv: [] });

    const candidates = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 30_000,
      }),
    );

    expect(candidates).toEqual([]);
  });
});

function exactCapacityInput(slotCount: number): ScheduleJobInput {
  const base = scheduleInput();
  const start = Date.UTC(2027, 7, 1, 0, 0);
  const slotMinutes = 30;
  const slotMs = slotMinutes * 60_000;
  return {
    ...base,
    objective: "balanced",
    matches: Array.from({ length: 36 }, (_, index) => ({
      match_id: `match-${String(index + 1).padStart(2, "0")}`,
      division_id: "division-1",
      duration_minutes: slotMinutes,
      dependency_match_ids: [],
      possible_entry_ids: [`entry-${index + 1}-home`, `entry-${index + 1}-away`],
      official_ids: [],
      is_championship_final: index === 35,
    })),
    slots: Array.from({ length: slotCount }, (_, index) => ({
      slot_id: `slot-${String(index + 1).padStart(2, "0")}`,
      interval_id: "interval-1",
      area_id: "area-1",
      start_epoch_ms: start + index * slotMs,
      end_epoch_ms: start + (index + 1) * slotMs,
    })),
    constraints: {
      ...base.constraints,
      preferred_final_time: {
        mode: "preferred",
        weight: 1,
        value: {
          target_start_epoch_ms: start + Math.max(0, slotCount - 1) * slotMs,
          tolerance_minutes: slotMinutes,
        },
      },
      featured_playing_area: { mode: "ignored", value: { area_id: "area-1", match_ids: [] } },
    },
  };
}

async function collect<Result>(iterable: AsyncIterable<Result>): Promise<Result[]> {
  const values: Result[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
