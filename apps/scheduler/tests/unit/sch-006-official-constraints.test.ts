import type { ScheduleJobInput, ScheduleJobResult } from "@matchday/contracts";
import { diagnoseScheduleInfeasibility } from "@matchday/domain";
import { describe, expect, it, vi } from "vitest";

import { deterministicJsonHash } from "../../src/canonical.js";
import { DomainScheduleOptimizer, toProblem } from "../../src/domain-optimizer.js";
import type { ClaimedScheduleJob, ScheduleJobStore } from "../../src/ports.js";
import { ScheduleJobProcessor } from "../../src/processor.js";
import { executionContext, scheduleInput } from "../fixtures.js";

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

  it("verifies exact availability boundary (09:00, 09:30 valid; 10:00 invalid) and missing required availability", async () => {
    // Official availability: 09:00 - 10:00. Match duration: 30 minutes.
    // Slots: 09:00-09:30 (valid), 09:30-10:00 (valid), 10:00-10:30 (invalid, starts at end boundary)
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
          official_ids: ["official-boundary"],
          is_championship_final: false,
        },
      ],
      slots: [
        {
          slot_id: "slot-0900",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-0930",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START + 30 * MINUTE_MS,
          end_epoch_ms: START + 60 * MINUTE_MS,
        },
        {
          slot_id: "slot-1000",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START + 60 * MINUTE_MS,
          end_epoch_ms: START + 90 * MINUTE_MS,
        },
      ],
      constraints: {
        ...base.constraints,
        official_availability: {
          mode: "required",
          value: {
            by_official_id: {
              "official-boundary": [
                {
                  start_epoch_ms: START,
                  end_epoch_ms: START + 60 * MINUTE_MS, // 09:00 - 10:00
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
    const assignedSlot = candidates[0]!.result.assignments[0]!.slot_id;
    expect(["slot-0900", "slot-0930"]).toContain(assignedSlot);

    // Forged candidate placing match at 10:00 (outside window) fails verification
    const forgedOutside: ScheduleJobResult = {
      ...candidates[0]!.result,
      assignments: [
        {
          match_id: "match-1",
          division_id: "division-1",
          area_id: "pitch-1",
          interval_id: "i-1",
          slot_id: "slot-1000",
          start_epoch_ms: START + 60 * MINUTE_MS,
          end_epoch_ms: START + 90 * MINUTE_MS,
          fixed: false,
        },
      ],
    };
    const outsideVerified = await optimizer.verifyCandidate(input, forgedOutside);
    expect(outsideVerified).toBeNull();

    // Missing availability intervals fails closed
    const missingInput: ScheduleJobInput = {
      ...input,
      constraints: {
        ...input.constraints,
        official_availability: {
          mode: "required",
          value: {
            by_official_id: {
              "official-boundary": [],
            },
          },
        },
      },
    };
    optimizer.validateInput(missingInput);
    const missingCandidates = await collect(
      optimizer.optimize({
        input: missingInput,
        seed: null,
        startIteration: 0,
        signal: new AbortController().signal,
        maxYieldIntervalMs: 5_000,
      }),
    );
    expect(missingCandidates).toHaveLength(0);
  });

  it("permits different available officials to officiate simultaneous matches on different pitches", async () => {
    // Official A -> Match 1, Official B -> Match 2
    // Both available at 09:00, 2 pitches available at 09:00
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
          official_ids: ["official-alpha"],
          is_championship_final: false,
        },
        {
          match_id: "match-2",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-c", "team-d"],
          official_ids: ["official-beta"],
          is_championship_final: false,
        },
      ],
      slots: [
        {
          slot_id: "slot-p1",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-p2",
          interval_id: "i-2",
          area_id: "pitch-2",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
      ],
      constraints: {
        ...base.constraints,
        official_availability: {
          mode: "required",
          value: {
            by_official_id: {
              "official-alpha": [{ start_epoch_ms: START, end_epoch_ms: START + 30 * MINUTE_MS }],
              "official-beta": [{ start_epoch_ms: START, end_epoch_ms: START + 30 * MINUTE_MS }],
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
    expect(result.assignments).toHaveLength(2);
    // Both scheduled simultaneously at 09:00 on different pitches
    expect(result.assignments[0]!.start_epoch_ms).toBe(START);
    expect(result.assignments[1]!.start_epoch_ms).toBe(START);
    expect(result.assignments[0]!.area_id).not.toBe(result.assignments[1]!.area_id);

    const verified = await optimizer.verifyCandidate(input, result);
    expect(verified).not.toBeNull();
    expect(verified?.quality.valid).toBe(true);
    expect(verified?.violations).toEqual([]);
  });

  it("enforces official overlap prevention even when official_availability mode is ignored", async () => {
    // Both matches require official-ignored, 2 simultaneous slots at 09:00
    // Availability mode is ignored with restrictive availability
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
          official_ids: ["official-ignored"],
          is_championship_final: false,
        },
        {
          match_id: "match-2",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-c", "team-d"],
          official_ids: ["official-ignored"],
          is_championship_final: false,
        },
      ],
      slots: [
        {
          slot_id: "slot-p1",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-p2",
          interval_id: "i-2",
          area_id: "pitch-2",
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
              "official-ignored": [
                {
                  start_epoch_ms: START + 180 * MINUTE_MS,
                  end_epoch_ms: START + 240 * MINUTE_MS,
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
        maxYieldIntervalMs: 5_000,
      }),
    );

    // Overlap remains hard constraint: 0 candidates yielded
    expect(candidates).toHaveLength(0);

    // Explicit forged simultaneous candidate fails verification with official_overlap
    const forged: ScheduleJobResult = {
      schema_version: 1,
      job_id: input.job_id,
      source_revision: input.source_revision,
      result_revision: 0,
      status: "valid",
      assignments: [
        {
          match_id: "match-1",
          division_id: "division-1",
          area_id: "pitch-1",
          interval_id: "i-1",
          slot_id: "slot-p1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
          fixed: false,
        },
        {
          match_id: "match-2",
          division_id: "division-1",
          area_id: "pitch-2",
          interval_id: "i-2",
          slot_id: "slot-p2",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
          fixed: false,
        },
      ],
      violations: [],
      quality: {
        score: 100,
        objective: "balanced",
        valid: true,
        makespan_minutes: 30,
        minimum_rest_minutes: 0,
        maximum_matches_per_entry_day: 1,
        preferred_final_delta_minutes: 0,
        required_violation_count: 0,
        preferred_penalty: 0,
        components: [],
      },
      assignment_hash: "0".repeat(64),
    };

    const forgedVerified = await optimizer.verifyCandidate(input, forged);
    expect(forgedVerified).toBeNull();
  });

  it("enforces official overlap prevention across multiple divisions sharing playing areas", async () => {
    const base = baseInput("pitch-1");
    const input: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-div1",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-cross-div"],
          is_championship_final: false,
        },
        {
          match_id: "match-div2",
          division_id: "division-2",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-c", "team-d"],
          official_ids: ["official-cross-div"],
          is_championship_final: false,
        },
      ],
      slots: [
        // Simultaneous round 1
        {
          slot_id: "slot-p1-r1",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-p2-r1",
          interval_id: "i-2",
          area_id: "pitch-2",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        // Sequential round 2
        {
          slot_id: "slot-p1-r2",
          interval_id: "i-1",
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
    const start1 = result.assignments.find((a) => a.match_id === "match-div1")!.start_epoch_ms;
    const start2 = result.assignments.find((a) => a.match_id === "match-div2")!.start_epoch_ms;
    expect(start1).not.toBe(start2);

    const verified = await optimizer.verifyCandidate(input, result);
    expect(verified).not.toBeNull();
    expect(verified?.quality.valid).toBe(true);
    expect(verified?.violations.filter((v) => v.code === "official_overlap")).toEqual([]);
  });

  it("enforces availability intersection when multiple officials are assigned to one match", async () => {
    // Official A available 09:00 - 11:00 (T+0..T+120m)
    // Official B available 10:00 - 12:00 (T+60m..T+180m)
    // Intersection: 10:00 - 11:00 (T+60m..T+120m)
    const base = baseInput("pitch-1");
    const input: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-multi",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-multi-a", "official-multi-b"],
          is_championship_final: false,
        },
      ],
      slots: [
        {
          slot_id: "slot-0930",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START + 30 * MINUTE_MS,
          end_epoch_ms: START + 60 * MINUTE_MS,
        },
        {
          slot_id: "slot-1000",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START + 60 * MINUTE_MS,
          end_epoch_ms: START + 90 * MINUTE_MS,
        },
        {
          slot_id: "slot-1030",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START + 90 * MINUTE_MS,
          end_epoch_ms: START + 120 * MINUTE_MS,
        },
        {
          slot_id: "slot-1100",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START + 120 * MINUTE_MS,
          end_epoch_ms: START + 150 * MINUTE_MS,
        },
      ],
      constraints: {
        ...base.constraints,
        official_availability: {
          mode: "required",
          value: {
            by_official_id: {
              "official-multi-a": [{ start_epoch_ms: START, end_epoch_ms: START + 120 * MINUTE_MS }],
              "official-multi-b": [{ start_epoch_ms: START + 60 * MINUTE_MS, end_epoch_ms: START + 180 * MINUTE_MS }],
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
    const assignedSlot = candidates[0]!.result.assignments[0]!.slot_id;
    // Must be in intersection (slot-1000 or slot-1030)
    expect(["slot-1000", "slot-1030"]).toContain(assignedSlot);

    // Forged candidate at 09:30 (where only A is available) fails verification
    const forgedAOnly: ScheduleJobResult = {
      ...candidates[0]!.result,
      assignments: [
        {
          match_id: "match-multi",
          division_id: "division-1",
          area_id: "pitch-1",
          interval_id: "i-1",
          slot_id: "slot-0930",
          start_epoch_ms: START + 30 * MINUTE_MS,
          end_epoch_ms: START + 60 * MINUTE_MS,
          fixed: false,
        },
      ],
    };
    expect(await optimizer.verifyCandidate(input, forgedAOnly)).toBeNull();

    // Forged candidate at 11:00 (where only B is available) fails verification
    const forgedBOnly: ScheduleJobResult = {
      ...candidates[0]!.result,
      assignments: [
        {
          match_id: "match-multi",
          division_id: "division-1",
          area_id: "pitch-1",
          interval_id: "i-1",
          slot_id: "slot-1100",
          start_epoch_ms: START + 120 * MINUTE_MS,
          end_epoch_ms: START + 150 * MINUTE_MS,
          fixed: false,
        },
      ],
    };
    expect(await optimizer.verifyCandidate(input, forgedBOnly)).toBeNull();
  });

  it("fails closed when fixed / locked assignments conflict with official availability", async () => {
    // Match 1 is locked at 09:00 on pitch-1, but assigned official is only available at 10:00
    const base = baseInput("pitch-1");
    const input: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-locked",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-locked"],
          is_championship_final: false,
          fixed_assignment: {
            reason: "locked",
            area_id: "pitch-1",
            slot_id: "slot-0900",
            start_epoch_ms: START,
            end_epoch_ms: START + 30 * MINUTE_MS,
          },
        },
      ],
      slots: [
        {
          slot_id: "slot-0900",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-1000",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START + 60 * MINUTE_MS,
          end_epoch_ms: START + 90 * MINUTE_MS,
        },
      ],
      constraints: {
        ...base.constraints,
        official_availability: {
          mode: "required",
          value: {
            by_official_id: {
              "official-locked": [
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
        maxYieldIntervalMs: 5_000,
      }),
    );

    // Fixed match cannot be moved to satisfy availability -> 0 valid candidates
    expect(candidates).toHaveLength(0);

    // Verifying candidate with fixed match at 09:00 fails verification
    const fixedCandidate: ScheduleJobResult = {
      schema_version: 1,
      job_id: input.job_id,
      source_revision: input.source_revision,
      result_revision: 0,
      status: "valid",
      assignments: [
        {
          match_id: "match-locked",
          division_id: "division-1",
          area_id: "pitch-1",
          interval_id: "i-1",
          slot_id: "slot-0900",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
          fixed: true,
        },
      ],
      violations: [],
      quality: {
        score: 100,
        objective: "balanced",
        valid: true,
        makespan_minutes: 30,
        minimum_rest_minutes: 0,
        maximum_matches_per_entry_day: 1,
        preferred_final_delta_minutes: 0,
        required_violation_count: 0,
        preferred_penalty: 0,
        components: [],
      },
      assignment_hash: "0".repeat(64),
    };

    const verified = await optimizer.verifyCandidate(input, fixedCandidate);
    expect(verified).toBeNull();
  });

  it("diagnoses impossible official schedules into structured violations for organizer UI", () => {
    // Case 1: Assigned official unavailable for all slots
    const base = baseInput("pitch-1");
    const inputUnavailable: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "match-unavail",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-x"],
          is_championship_final: false,
        },
      ],
      slots: [
        {
          slot_id: "slot-0900",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
      ],
      constraints: {
        ...base.constraints,
        official_availability: {
          mode: "required",
          value: {
            by_official_id: {
              // Official only available at 12:00, but slot is at 09:00
              "official-x": [{ start_epoch_ms: START + 180 * MINUTE_MS, end_epoch_ms: START + 240 * MINUTE_MS }],
            },
          },
        },
      },
    };

    const problemUnavailable = toProblem(inputUnavailable);
    const diagUnavailable = diagnoseScheduleInfeasibility(problemUnavailable);
    expect(diagUnavailable).toHaveLength(1);
    expect(diagUnavailable[0]).toMatchObject({
      code: "official_unavailable",
      severity: "required",
      matchIds: ["match-unavail"],
    });

    // Case 2: Official overlap / over-allocation
    const inputOverAllocated: ScheduleJobInput = {
      ...base,
      matches: [
        {
          match_id: "m1",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-shared"],
          is_championship_final: false,
        },
        {
          match_id: "m2",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-c", "team-d"],
          official_ids: ["official-shared"],
          is_championship_final: false,
        },
      ],
      // 2 simultaneous slots on 2 pitches at 09:00 -> max 1 sequential slot!
      slots: [
        {
          slot_id: "slot-p1",
          interval_id: "i-1",
          area_id: "pitch-1",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
        {
          slot_id: "slot-p2",
          interval_id: "i-1",
          area_id: "pitch-2",
          start_epoch_ms: START,
          end_epoch_ms: START + 30 * MINUTE_MS,
        },
      ],
      constraints: {
        ...base.constraints,
        official_availability: {
          mode: "required",
          value: {
            by_official_id: {
              "official-shared": [{ start_epoch_ms: START, end_epoch_ms: START + 60 * MINUTE_MS }],
            },
          },
        },
      },
    };

    const problemOverAllocated = toProblem(inputOverAllocated);
    const diagOverlap = diagnoseScheduleInfeasibility(problemOverAllocated);
    expect(diagOverlap).toHaveLength(1);
    expect(diagOverlap[0]).toMatchObject({
      code: "official_overlap",
      severity: "hard",
      matchIds: ["m1", "m2"],
    });
  });

  it("integrates with ScheduleJobProcessor to persist no_solution on impossible official schedule", async () => {
    const impossibleInput: ScheduleJobInput = {
      ...baseInput("pitch-1"),
      matches: [
        {
          match_id: "match-imp",
          division_id: "division-1",
          duration_minutes: 30,
          dependency_match_ids: [],
          possible_entry_ids: ["team-a", "team-b"],
          official_ids: ["official-none"],
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
      ],
      constraints: {
        ...baseInput("pitch-1").constraints,
        official_availability: {
          mode: "required",
          value: { by_official_id: { "official-none": [] } },
        },
      },
    };

    class TestStore implements ScheduleJobStore {
      currentBest: ScheduleJobResult | null = null;
      finishedState: string | null = null;
      async probe() {
        return true;
      }
      async claimJob(): Promise<{ outcome: "claimed"; job: ClaimedScheduleJob }> {
        return {
          outcome: "claimed",
          job: {
            jobId: impossibleInput.job_id,
            competitionId: impossibleInput.competition_id,
            input: impossibleInput,
            inputHash: deterministicJsonHash(impossibleInput),
            fenceToken: "fence-1",
            correlationId: "corr-1",
            continuedFromJobId: null,
            continuationIteration: 0,
            exploredCandidates: 0,
            currentBest: null,
          },
        };
      }
      async renewLease() {
        return true;
      }
      getCancellationStatus = vi.fn(async () => ({ requested: false, requestedAtEpochMs: null }));
      async checkpointBest(req: { candidate: ScheduleJobResult; iteration: number }) {
        this.currentBest = req.candidate;
        return { accepted: true, result: req.candidate };
      }
      async recordProgress() {}
      async finishJob(req: {
        state: "cancelled" | "completed" | "no_solution" | "stale";
        currentBestRevision: number | null;
      }) {
        this.finishedState = req.state;
      }
      async releaseAfterFailure() {}
      async markDeadLettered() {}
      async close() {}
    }

    const impossibleStore = new TestStore();
    const processor = new ScheduleJobProcessor({
      workerId: "test-worker",
      store: impossibleStore,
      optimizer,
      cancellationPollMs: 50,
      maxYieldIntervalMs: 5_000,
    });

    const processResult = await processor.process(
      {
        schemaVersion: 1,
        jobId: impossibleInput.job_id,
        competitionId: impossibleInput.competition_id,
        inputHash: deterministicJsonHash(impossibleInput),
        correlationId: "corr-1",
      },
      executionContext(),
    );

    // Job finishes with state: "no_solution" and currentBestRevision: null
    expect(processResult.state).toBe("no_solution");
    expect(processResult.currentBestRevision).toBeNull();
    expect(impossibleStore.finishedState).toBe("no_solution");

    // Infeasibility diagnostic pinpoints the exact cause
    const violations = diagnoseScheduleInfeasibility(toProblem(impossibleInput));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.code).toBe("official_unavailable");
  });
});

async function collect<Result>(iterable: AsyncIterable<Result>): Promise<Result[]> {
  const values: Result[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
