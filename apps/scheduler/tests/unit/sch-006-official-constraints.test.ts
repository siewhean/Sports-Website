import type { ScheduleJobInput, ScheduleJobResult } from "@matchday/contracts";
import { describe, expect, it } from "vitest";

import { DomainScheduleOptimizer } from "../../src/domain-optimizer.js";
import { scheduleInput } from "../fixtures.js";

const START = Date.UTC(2026, 6, 20, 1, 0); // 09:00 Asia/Singapore
const MINUTE_MS = 60_000;

function baseInput(primaryAreaId = "pitch-1"): ScheduleJobInput {
  const base = scheduleInput();
  return {
    ...base,
    constraints: {
      ...base.constraints,
      featured_playing_area: {
        mode: "ignored",
        value: { area_id: primaryAreaId, match_ids: [] },
      },
    },
  };
}

describe("SCH-006: Scheduler Worker Official Constraint Activation", () => {
  const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 4, workerExecArgv: [] });

  it("activates hard official availability constraints in worker optimization and verification", async () => {
    // Match requires official-1, who is only available in slot-3 (T+60..T+90)
    const base = baseInput("pitch-1");
    const input: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-1",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-1"],
          is_championship_final: false,
        },
      ],
      slots: [0, 1, 2].map((i) => ({
        slot_id: `slot-${i + 1}`,
        interval_id: "interval-1",
        area_id: "pitch-1",
        start_epoch_ms: START + i * 30 * MINUTE_MS,
        end_epoch_ms: START + (i + 1) * 30 * MINUTE_MS,
      })),
      constraints: {
        ...base.constraints,
        official_availability: {
          mode: "required",
          value: {
            by_official_id: {
              "official-1": [
                {
                  start_epoch_ms: START + 60 * MINUTE_MS,
                  end_epoch_ms: START + 90 * MINUTE_MS,
                },
              ],
            },
          },
        },
      },
    };

    optimizer.validateInput(input);

    const candidates = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 10_000,
      }),
    );

    expect(candidates.length).toBeGreaterThan(0);
    const validCandidate = candidates[0]!.result;
    expect(validCandidate.assignments).toHaveLength(1);
    expect(validCandidate.assignments[0]!.slot_id).toBe("slot-3");
    expect(validCandidate.assignments[0]!.start_epoch_ms).toBe(START + 60 * MINUTE_MS);

    const verified = await optimizer.verifyCandidate(input, validCandidate);
    expect(verified).not.toBeNull();
    expect(verified?.quality.valid).toBe(true);
    expect(verified?.violations.filter((v) => v.code === "official_unavailable")).toEqual([]);

    // A forged candidate placing the match in slot-1 (where official is unavailable) is rejected
    const forged: ScheduleJobResult = {
      ...validCandidate,
      assignments: [
        {
          ...validCandidate.assignments[0]!,
          slot_id: "slot-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
      ],
    };
    const forgedVerified = await optimizer.verifyCandidate(input, forged);
    expect(forgedVerified).toBeNull();
  });

  it("enforces official overlap hard constraints preventing simultaneous matches on different pitches", async () => {
    // 2 matches both officiated by official-2, 2 simultaneous pitches (pitch-1 and pitch-2) across 2 rounds
    const base = baseInput("pitch-1");
    const input: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-1",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-2"],
          is_championship_final: false,
        },
        {
          match_id: "match-2",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-c", "team-d"],
          official_ids: ["official-2"],
          is_championship_final: false,
        },
      ],
      slots: [
        // Round 1: simultaneous
        {
          slot_id: "slot-p1-r1",
          interval_id: "i-p1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-p2-r1",
          interval_id: "i-p2",
          area_id: "pitch-2",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        // Round 2: simultaneous
        {
          slot_id: "slot-p1-r2",
          interval_id: "i-p1",
          area_id: "pitch-1",
          start_epoch_ms: START + 30 * MINUTE_MS,
          end_epoch_ms: START + 60 * MINUTE_MS,
        },
        {
          slot_id: "slot-p2-r2",
          interval_id: "i-p2",
          area_id: "pitch-2",
          start_epoch_ms: START + 30 * MINUTE_MS,
          end_epoch_ms: START + 60 * MINUTE_MS,
        },
      ],
    };

    optimizer.validateInput(input);

    const candidates = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 10_000,
      }),
    );

    expect(candidates.length).toBeGreaterThan(0);
    const result = candidates[0]!.result;
    expect(result.assignments).toHaveLength(2);

    // Matches must NOT be scheduled at the same time
    const start1 = result.assignments.find((a) => a.match_id === "match-1")!.start_epoch_ms;
    const start2 = result.assignments.find((a) => a.match_id === "match-2")!.start_epoch_ms;
    expect(start1).not.toBe(start2);

    const verified = await optimizer.verifyCandidate(input, result);
    expect(verified).not.toBeNull();
    expect(verified?.quality.valid).toBe(true);
    expect(verified?.violations.filter((v) => v.code === "official_overlap")).toEqual([]);

    // A forged candidate assigning both matches simultaneously is rejected by verifyCandidate
    const forgedSimultaneous: ScheduleJobResult = {
      ...result,
      assignments: [
        {
          match_id: "match-1",
          division_id: "division-1",
          area_id: "pitch-1",
          interval_id: "i-p1",
          slot_id: "slot-p1-r1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
          fixed: false,
        },
        {
          match_id: "match-2",
          division_id: "division-1",
          area_id: "pitch-2",
          interval_id: "i-p2",
          slot_id: "slot-p2-r1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
          fixed: false,
        },
      ],
    };
    const simultaneousVerified = await optimizer.verifyCandidate(input, forgedSimultaneous);
    expect(simultaneousVerified).toBeNull();
  });

  it("allows adjacent back-to-back matches for the same official", async () => {
    const base = baseInput("pitch-1");
    const input: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-1",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-3"],
          is_championship_final: false,
        },
        {
          match_id: "match-2",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-c", "team-d"],
          official_ids: ["official-3"],
          is_championship_final: false,
        },
      ],
      slots: [
        {
          slot_id: "slot-1",
          interval_id: "interval-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-2",
          interval_id: "interval-1",
          area_id: "pitch-1",
          start_epoch_ms: START + 30 * MINUTE_MS,
          end_epoch_ms: START + 60 * MINUTE_MS,
        },
      ],
    };

    optimizer.validateInput(input);

    const candidates = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 10_000,
      }),
    );

    expect(candidates.length).toBeGreaterThan(0);
    const result = candidates[0]!.result;
    expect(result.assignments).toHaveLength(2);

    const verified = await optimizer.verifyCandidate(input, result);
    expect(verified).not.toBeNull();
    expect(verified?.quality.valid).toBe(true);
    expect(verified?.violations).toEqual([]);
  });

  it("evaluates preferred official availability penalties and quality components in worker thread", async () => {
    const base = baseInput("pitch-1");
    const input: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-1",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-4"],
          is_championship_final: false,
        },
      ],
      slots: [
        {
          slot_id: "slot-1",
          interval_id: "interval-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-2",
          interval_id: "interval-1",
          area_id: "pitch-1",
          start_epoch_ms: START + 30 * MINUTE_MS,
          end_epoch_ms: START + 60 * MINUTE_MS,
        },
      ],
      constraints: {
        ...base.constraints,
        official_availability: {
          mode: "preferred",
          weight: 5,
          value: {
            by_official_id: {
              "official-4": [
                {
                  start_epoch_ms: START,
                  end_epoch_ms: START + 30 * MINUTE_MS,
                },
              ],
            },
          },
        },
      },
    };

    optimizer.validateInput(input);

    const candidates = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 10_000,
      }),
    );

    expect(candidates.length).toBeGreaterThan(0);
    // Best candidate chooses preferred slot (slot-1)
    const best = candidates[0]!.result;
    expect(best.assignments[0]!.slot_id).toBe("slot-1");

    const verified = await optimizer.verifyCandidate(input, best);
    expect(verified).not.toBeNull();
    const officialComponent = verified?.quality.components.find((c) => c.key === "official_availability");
    expect(officialComponent).toBeDefined();
    expect(officialComponent!.score).toBe(100);

    // Verify that assigning to slot-2 incurs preferred violation and penalties
    const nonPreferredCandidate: ScheduleJobResult = {
      ...best,
      assignments: [
        {
          ...best.assignments[0]!,
          slot_id: "slot-2",
          start_epoch_ms: START + 30 * MINUTE_MS,
          end_epoch_ms: START + 60 * MINUTE_MS,
        },
      ],
    };
    const nonPreferredVerified = await optimizer.verifyCandidate(input, nonPreferredCandidate);
    expect(nonPreferredVerified).not.toBeNull();
    expect(nonPreferredVerified?.violations).toContainEqual(
      expect.objectContaining({
        code: "official_unavailable",
        severity: "preferred",
      }),
    );
    expect(nonPreferredVerified?.quality.score).toBeLessThan(verified!.quality.score);
  });

  it("ignores official availability completely when mode is ignored", async () => {
    const base = baseInput("pitch-1");
    const input: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-1",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-5"],
          is_championship_final: false,
        },
      ],
      slots: [
        {
          slot_id: "slot-1",
          interval_id: "interval-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
      ],
      constraints: {
        ...base.constraints,
        official_availability: {
          mode: "ignored",
          value: {
            by_official_id: {
              "official-5": [
                {
                  start_epoch_ms: START + 60 * MINUTE_MS,
                  end_epoch_ms: START + 90 * MINUTE_MS,
                },
              ],
            },
          },
        },
      },
    };

    optimizer.validateInput(input);

    const candidates = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 10_000,
      }),
    );

    expect(candidates.length).toBeGreaterThan(0);
    const result = candidates[0]!.result;
    expect(result.assignments[0]!.slot_id).toBe("slot-1");

    const verified = await optimizer.verifyCandidate(input, result);
    expect(verified).not.toBeNull();
    expect(verified?.quality.valid).toBe(true);
    expect(verified?.violations.filter((v) => v.code === "official_unavailable")).toEqual([]);
  });

  it("yields zero candidates when official constraints are completely unsatisfiable", async () => {
    // 2 matches both requiring official-6, but only 1 single simultaneous round exists
    const base = baseInput("pitch-1");
    const input: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-1",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-6"],
          is_championship_final: false,
        },
        {
          match_id: "match-2",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-c", "team-d"],
          official_ids: ["official-6"],
          is_championship_final: false,
        },
      ],
      slots: [
        {
          slot_id: "slot-1",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-2",
          interval_id: "i-2",
          area_id: "pitch-2",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
      ],
    };

    optimizer.validateInput(input);

    const candidates = await collect(
      optimizer.optimize({
        input,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 5_000,
      }),
    );

    // Cannot schedule 2 matches with same official in 1 round
    expect(candidates).toHaveLength(0);
  });
});

async function collect<Result>(iterable: AsyncIterable<Result>): Promise<Result[]> {
  const values: Result[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
