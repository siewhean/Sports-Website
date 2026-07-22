import type { ScheduleJobInput } from "@matchday/contracts";
import { describe, expect, it } from "vitest";

import { DomainScheduleOptimizer } from "../../src/domain-optimizer.js";
import { scheduleInput } from "../fixtures.js";

const generationP95CeilingMs = 15_000;
const verificationP95CeilingMs = 5_000;
const samples = 5;

describe("Gate B scheduler performance qualification", () => {
  it(
    "keeps deterministic multi-match generation and verification within the pinned local ceilings",
    async () => {
      const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 8 });
      const input = qualificationInput();
      optimizer.validateInput(input);

      const generationDurations: number[] = [];
      const verificationDurations: number[] = [];
      let canonicalResult = "";

      for (let sample = 0; sample < samples; sample += 1) {
        const generationStarted = performance.now();
        const candidates = await collect(
          optimizer.optimize({
            input,
            seed: null,
            startIteration: 0,
            signal: new AbortController().signal,
            maxYieldIntervalMs: 2_000,
          }),
        );
        generationDurations.push(performance.now() - generationStarted);
        expect(candidates.length).toBeGreaterThan(0);

        const serialized = JSON.stringify(candidates);
        if (sample === 0) canonicalResult = serialized;
        else expect(serialized).toBe(canonicalResult);

        const verificationStarted = performance.now();
        const verified = await Promise.all(
          candidates.slice(0, 3).map(({ result }) => optimizer.verifyCandidate(input, result)),
        );
        verificationDurations.push(performance.now() - verificationStarted);
        expect(verified.every((result) => result !== null)).toBe(true);
      }

      expect(percentile95(generationDurations)).toBeLessThanOrEqual(generationP95CeilingMs);
      expect(percentile95(verificationDurations)).toBeLessThanOrEqual(verificationP95CeilingMs);
    },
    120_000,
  );
});

function qualificationInput(): ScheduleJobInput {
  const base = scheduleInput();
  const start = Date.UTC(2027, 7, 1, 0, 0);
  const divisions = [qualificationUuid("8001", 1), qualificationUuid("8001", 2)] as const;
  const areas = [qualificationUuid("8002", 1), qualificationUuid("8002", 2)] as const;
  const intervals = [qualificationUuid("8003", 1), qualificationUuid("8003", 2)] as const;
  const matches = Array.from({ length: 16 }, (_, index) => ({
    match_id: qualificationUuid("8004", index + 1),
    division_id: index < 8 ? divisions[0] : divisions[1],
    duration_minutes: 30,
    dependency_match_ids: [],
    possible_entry_ids: [
      qualificationUuid("8005", index * 2 + 1),
      qualificationUuid("8005", index * 2 + 2),
    ],
    official_ids: [],
    is_championship_final: index === 15,
  }));
  const slots = Array.from({ length: 48 }, (_, index) => {
    const areaIndex = index % 2;
    const slotIndex = Math.floor(index / 2);
    return {
      slot_id: qualificationUuid("8006", index + 1),
      interval_id: intervals[areaIndex],
      area_id: areas[areaIndex],
      start_epoch_ms: start + slotIndex * 30 * 60_000,
      end_epoch_ms: start + (slotIndex + 1) * 30 * 60_000,
    };
  });
  return {
    ...base,
    matches,
    slots,
    constraints: {
      ...base.constraints,
      minimum_rest: { mode: "preferred", value: { minutes: 30 }, weight: 2 },
      maximum_matches_per_day: { mode: "required", value: { matches: 4 } },
      preferred_final_time: {
        mode: "preferred",
        weight: 1,
        value: { target_start_epoch_ms: slots.at(-1)!.start_epoch_ms, tolerance_minutes: 60 },
      },
      featured_playing_area: {
        mode: "preferred",
        weight: 1,
        value: { area_id: areas[0], match_ids: [matches.at(-1)!.match_id] },
      },
      keep_division_together: { mode: "preferred", weight: 1, value: { maximum_area_count: 2 } },
    },
  };
}

function qualificationUuid(variant: string, value: number): string {
  return `00000000-0000-4000-${variant}-${value.toString(16).padStart(12, "0")}`;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot calculate a percentile without samples");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

async function collect<Result>(iterable: AsyncIterable<Result>): Promise<Result[]> {
  const values: Result[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
