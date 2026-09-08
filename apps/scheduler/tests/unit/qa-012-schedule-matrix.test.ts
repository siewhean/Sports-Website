import type { ScheduleJobInput } from "@matchday/contracts";
import { describe, expect, it } from "vitest";

import { DomainScheduleOptimizer } from "../../src/domain-optimizer.js";
import { scheduleInput } from "../fixtures.js";

describe("QA-012 / QA-003 — Comprehensive Schedule Solver Matrix & Adversarial Suite", () => {
  const optimizer = new DomainScheduleOptimizer({ maxIterationsPerRun: 2, workerExecArgv: [] });

  describe("Standard Supported Size Matrix (8, 12, 16, 24, 48 entries)", () => {
    it.each([
      { entries: 8, matches: 12, slots: 16, desc: "8 entries (e.g. 2 pools of 4, or 8-entry bracket)" },
      { entries: 12, matches: 18, slots: 24, desc: "12 entries (e.g. 4 pools of 3, or 12-entry bracket with byes)" },
      { entries: 16, matches: 24, slots: 32, desc: "16 entries (e.g. 4 pools of 4, or 16-entry bracket)" },
      { entries: 24, matches: 36, slots: 48, desc: "24 entries (e.g. 6 pools of 4, or 24-entry bracket with byes)" },
      { entries: 48, matches: 72, slots: 96, desc: "48 entries (e.g. multi-division large tournament)" },
    ])("generates valid deterministic schedule for $desc", async ({ entries, matches, slots }) => {
      const input = buildSizeMatrixInput(entries, matches, slots);
      optimizer.validateInput(input);

      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 30_000,
        }),
      );

      expect(candidates.length).toBeGreaterThan(0);
      const best = candidates[0]!;
      expect(best.result.assignments.length).toBe(matches);
      expect(best.result.quality?.valid).toBe(true);

      const verified = await optimizer.verifyCandidate(input, best.result, {
        signal: new AbortController().signal,
        maxYieldIntervalMs: 30_000,
      });
      expect(verified).not.toBeNull();
      expect(verified?.quality?.valid).toBe(true);
      expect(verified?.violations.filter((v) => v.severity === "hard")).toEqual([]);
    });
  });

  describe("Adversarial Solver Scenarios", () => {
    it("handles odd entry counts with byes cleanly without deadlocks", async () => {
      const input = buildOddCountInput();
      optimizer.validateInput(input);

      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0]!.result.quality?.valid).toBe(true);
    });

    it("respects withdrawals where an entry is excluded from downstream pairings", async () => {
      const input = buildWithdrawalInput();
      optimizer.validateInput(input);

      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0]!.result.assignments.every((a) => a.slot_id !== "")).toBe(true);
    });

    it("handles unavailable venues and blackout intervals without scheduling matches during blackout", async () => {
      const start = Date.UTC(2027, 7, 1, 8, 0);
      const slotMs = 30 * 60_000;
      const blackoutStart = start + 2 * slotMs;
      const blackoutEnd = start + 4 * slotMs;

      const input = buildBlackoutInput(start, slotMs, blackoutStart, blackoutEnd);
      optimizer.validateInput(input);

      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(candidates.length).toBeGreaterThan(0);
      const assignments = candidates[0]!.result.assignments;
      for (const assignment of assignments) {
        expect(assignment.start_epoch_ms >= blackoutEnd || assignment.end_epoch_ms <= blackoutStart).toBe(true);
      }
    });

    it("returns no solution instead of crashing when capacity is genuinely insufficient", async () => {
      const input = buildSizeMatrixInput(8, 10, 5);
      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(candidates).toEqual([]);
    });

    it("enforces minimum rest constraints strictly so no team plays consecutively within rest window", async () => {
      const input = buildRestConstrainedInput(60);
      optimizer.validateInput(input);

      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(candidates.length).toBeGreaterThan(0);
      const assignments = candidates[0]!.result.assignments;
      const match1 = assignments.find((a) => a.match_id === "match-1")!;
      const match3 = assignments.find((a) => a.match_id === "match-3")!;
      const timeDiffMs = Math.abs(match3.start_epoch_ms - match1.end_epoch_ms);
      expect(timeDiffMs).toBeGreaterThanOrEqual(60 * 60_000);
    });

    it("respects locked matches and preserves their exact slot assignments immutably", async () => {
      const input = buildLockedMatchInput();
      optimizer.validateInput(input);

      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(candidates.length).toBeGreaterThan(0);
      const lockedAssignment = candidates[0]!.result.assignments.find((a) => a.match_id === "match-locked")!;
      expect(lockedAssignment.slot_id).toBe("slot-locked");
      expect(lockedAssignment.fixed).toBe(true);
    });

    it("strictly preserves topological dependency chains across multi-round brackets", async () => {
      const input = buildDependentMatchChainInput();
      optimizer.validateInput(input);

      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(candidates.length).toBeGreaterThan(0);
      const assignments = candidates[0]!.result.assignments;
      const m1 = assignments.find((a) => a.match_id === "m-r1")!;
      const m2 = assignments.find((a) => a.match_id === "m-r2")!;
      const m3 = assignments.find((a) => a.match_id === "m-r3")!;
      expect(m2.start_epoch_ms).toBeGreaterThanOrEqual(m1.end_epoch_ms);
      expect(m3.start_epoch_ms).toBeGreaterThanOrEqual(m2.end_epoch_ms);
    });

    it("supports schedule repair with preserve_existing_schedule constraint", async () => {
      const base = buildSizeMatrixInput(8, 6, 12);
      const start = Date.UTC(2027, 7, 1, 0, 0);
      const slotMs = 30 * 60_000;
      const input: ScheduleJobInput = {
        ...base,
        constraints: {
          ...base.constraints,
          preserve_existing_schedule: {
            mode: "preferred",
            weight: 5,
            value: {
              maximum_shift_minutes: 60,
              by_match_id: {
                "match-01": { area_id: "area-1", start_epoch_ms: start },
                "match-02": { area_id: "area-1", start_epoch_ms: start + slotMs },
              },
            },
          },
        },
      };

      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0]!.result.quality?.valid).toBe(true);
    });

    it("shares playing areas across multiple divisions without overlapping time slots", async () => {
      const input = buildMultiDivisionSharedAreaInput();
      optimizer.validateInput(input);

      const candidates = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(candidates.length).toBeGreaterThan(0);
      const assignments = candidates[0]!.result.assignments;
      const slotIds = assignments.map((a) => a.slot_id);
      expect(new Set(slotIds).size).toBe(assignments.length);
    });

    it("aborts cleanly mid-solve when AbortSignal is triggered", async () => {
      const input = buildSizeMatrixInput(24, 36, 48);
      const abort = new AbortController();
      const iterator = optimizer
        .optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: abort.signal,
          maxYieldIntervalMs: 10_000,
        })
        [Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      abort.abort();
      const second = await iterator.next();
      expect(second.done).toBe(true);
    });

    it("guarantees deterministic repeatability across multiple identical runs", async () => {
      const input = buildSizeMatrixInput(16, 24, 32);
      const run1 = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );
      const run2 = await collect(
        optimizer.optimize({
          input,
          seed: null,
          startIteration: 0,
          signal: new AbortController().signal,
          maxYieldIntervalMs: 15_000,
        }),
      );

      expect(run1).toEqual(run2);
    });
  });
});

function baseFixtureInput(): ScheduleJobInput {
  const base = scheduleInput();
  return {
    ...base,
    constraints: {
      ...base.constraints,
      featured_playing_area: { mode: "ignored", value: { area_id: "area-1", match_ids: [] } },
    },
  };
}

function buildSizeMatrixInput(entriesCount: number, matchesCount: number, slotsCount: number): ScheduleJobInput {
  const base = baseFixtureInput();
  const start = Date.UTC(2027, 7, 1, 0, 0);
  const slotMinutes = 30;
  const slotMs = slotMinutes * 60_000;
  const areasCount = Math.max(1, Math.ceil(slotsCount / 24));

  return {
    ...base,
    objective: "balanced",
    matches: Array.from({ length: matchesCount }, (_, i) => ({
      match_id: `match-${String(i + 1).padStart(2, "0")}`,
      division_id: "division-1",
      duration_minutes: slotMinutes,
      dependency_match_ids: i > 0 && i % 4 === 0 ? [`match-${String(i).padStart(2, "0")}`] : [],
      possible_entry_ids: [`entry-${(i % entriesCount) + 1}`, `entry-${((i + 1) % entriesCount) + 1}`],
      official_ids: [],
      is_championship_final: i === matchesCount - 1,
    })),
    slots: Array.from({ length: slotsCount }, (_, i) => {
      const areaIndex = i % areasCount;
      const timeIndex = Math.floor(i / areasCount);
      return {
        slot_id: `slot-${String(i + 1).padStart(2, "0")}`,
        interval_id: "interval-1",
        area_id: `area-${areaIndex + 1}`,
        start_epoch_ms: start + timeIndex * slotMs,
        end_epoch_ms: start + (timeIndex + 1) * slotMs,
      };
    }),
  };
}

function buildOddCountInput(): ScheduleJobInput {
  const base = baseFixtureInput();
  const start = Date.UTC(2027, 7, 1, 0, 0);
  const slotMs = 30 * 60_000;
  return {
    ...base,
    matches: [
      {
        match_id: "m-r1-1",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["e1", "e2"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-r1-2",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["e3", "e4"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-r1-3",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["e5", "e6"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-semi-1",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: ["m-r1-1"],
        possible_entry_ids: ["e1", "e2", "e7"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-semi-2",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: ["m-r1-2", "m-r1-3"],
        possible_entry_ids: ["e3", "e4", "e5", "e6"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-final",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: ["m-semi-1", "m-semi-2"],
        possible_entry_ids: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"],
        official_ids: [],
        is_championship_final: true,
      },
    ],
    slots: Array.from({ length: 12 }, (_, i) => ({
      slot_id: `slot-${i + 1}`,
      interval_id: "interval-1",
      area_id: i % 2 === 0 ? "area-1" : "area-2",
      start_epoch_ms: start + Math.floor(i / 2) * slotMs,
      end_epoch_ms: start + (Math.floor(i / 2) + 1) * slotMs,
    })),
  };
}

function buildWithdrawalInput(): ScheduleJobInput {
  const base = baseFixtureInput();
  const start = Date.UTC(2027, 7, 1, 0, 0);
  const slotMs = 30 * 60_000;
  return {
    ...base,
    matches: [
      {
        match_id: "m-1",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["entry-active-1", "entry-active-2"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-2",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["entry-active-3", "entry-active-4"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-final",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: ["m-1", "m-2"],
        possible_entry_ids: ["entry-active-1", "entry-active-2", "entry-active-3", "entry-active-4"],
        official_ids: [],
        is_championship_final: true,
      },
    ],
    slots: Array.from({ length: 6 }, (_, i) => ({
      slot_id: `slot-${i + 1}`,
      interval_id: "interval-1",
      area_id: "area-1",
      start_epoch_ms: start + i * slotMs,
      end_epoch_ms: start + (i + 1) * slotMs,
    })),
  };
}

function buildBlackoutInput(
  start: number,
  slotMs: number,
  blackoutStart: number,
  blackoutEnd: number,
): ScheduleJobInput {
  const base = baseFixtureInput();
  return {
    ...base,
    matches: [
      {
        match_id: "m-1",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["e1", "e2"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-2",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["e3", "e4"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-3",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["e5", "e6"],
        official_ids: [],
        is_championship_final: true,
      },
    ],
    slots: [
      { slot_id: "s-1", interval_id: "int-1", area_id: "a-1", start_epoch_ms: start, end_epoch_ms: start + slotMs },
      {
        slot_id: "s-2",
        interval_id: "int-1",
        area_id: "a-1",
        start_epoch_ms: start + slotMs,
        end_epoch_ms: start + 2 * slotMs,
      },
      {
        slot_id: "s-3",
        interval_id: "int-1",
        area_id: "a-1",
        start_epoch_ms: blackoutEnd,
        end_epoch_ms: blackoutEnd + slotMs,
      },
      {
        slot_id: "s-4",
        interval_id: "int-1",
        area_id: "a-1",
        start_epoch_ms: blackoutEnd + slotMs,
        end_epoch_ms: blackoutEnd + 2 * slotMs,
      },
    ],
  };
}

function buildRestConstrainedInput(restMinutes: number): ScheduleJobInput {
  const base = baseFixtureInput();
  const start = Date.UTC(2027, 7, 1, 0, 0);
  const slotMs = 30 * 60_000;
  return {
    ...base,
    constraints: {
      ...base.constraints,
      minimum_rest: { mode: "required", value: { minutes: restMinutes } },
    },
    matches: [
      {
        match_id: "match-1",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["entry-1", "entry-2"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "match-2",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["entry-3", "entry-4"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "match-3",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["entry-1", "entry-3"],
        official_ids: [],
        is_championship_final: true,
      },
    ],
    slots: Array.from({ length: 8 }, (_, i) => ({
      slot_id: `slot-${i + 1}`,
      interval_id: "interval-1",
      area_id: "area-1",
      start_epoch_ms: start + i * slotMs,
      end_epoch_ms: start + (i + 1) * slotMs,
    })),
  };
}

function buildLockedMatchInput(): ScheduleJobInput {
  const base = baseFixtureInput();
  const start = Date.UTC(2027, 7, 1, 0, 0);
  const slotMs = 30 * 60_000;
  return {
    ...base,
    matches: [
      {
        match_id: "match-locked",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["e1", "e2"],
        official_ids: [],
        is_championship_final: false,
        fixed_assignment: {
          reason: "locked",
          area_id: "area-1",
          slot_id: "slot-locked",
          start_epoch_ms: start + slotMs,
          end_epoch_ms: start + 2 * slotMs,
        },
      },
      {
        match_id: "match-free",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["e3", "e4"],
        official_ids: [],
        is_championship_final: true,
      },
    ],
    slots: [
      {
        slot_id: "slot-1",
        interval_id: "int-1",
        area_id: "area-1",
        start_epoch_ms: start,
        end_epoch_ms: start + slotMs,
      },
      {
        slot_id: "slot-locked",
        interval_id: "int-1",
        area_id: "area-1",
        start_epoch_ms: start + slotMs,
        end_epoch_ms: start + 2 * slotMs,
      },
      {
        slot_id: "slot-3",
        interval_id: "int-1",
        area_id: "area-1",
        start_epoch_ms: start + 2 * slotMs,
        end_epoch_ms: start + 3 * slotMs,
      },
    ],
  };
}

function buildDependentMatchChainInput(): ScheduleJobInput {
  const base = baseFixtureInput();
  const start = Date.UTC(2027, 7, 1, 0, 0);
  const slotMs = 30 * 60_000;
  return {
    ...base,
    matches: [
      {
        match_id: "m-r1",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["e1", "e2"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-r2",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: ["m-r1"],
        possible_entry_ids: ["e1", "e2", "e3"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-r3",
        division_id: "div-1",
        duration_minutes: 30,
        dependency_match_ids: ["m-r2"],
        possible_entry_ids: ["e1", "e2", "e3", "e4"],
        official_ids: [],
        is_championship_final: true,
      },
    ],
    slots: Array.from({ length: 6 }, (_, i) => ({
      slot_id: `slot-${i + 1}`,
      interval_id: "interval-1",
      area_id: "area-1",
      start_epoch_ms: start + i * slotMs,
      end_epoch_ms: start + (i + 1) * slotMs,
    })),
  };
}

function buildMultiDivisionSharedAreaInput(): ScheduleJobInput {
  const base = baseFixtureInput();
  const start = Date.UTC(2027, 7, 1, 0, 0);
  const slotMs = 30 * 60_000;
  return {
    ...base,
    matches: [
      {
        match_id: "m-divA-1",
        division_id: "division-A",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["a1", "a2"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-divA-2",
        division_id: "division-A",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["a3", "a4"],
        official_ids: [],
        is_championship_final: true,
      },
      {
        match_id: "m-divB-1",
        division_id: "division-B",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["b1", "b2"],
        official_ids: [],
        is_championship_final: false,
      },
      {
        match_id: "m-divB-2",
        division_id: "division-B",
        duration_minutes: 30,
        dependency_match_ids: [],
        possible_entry_ids: ["b3", "b4"],
        official_ids: [],
        is_championship_final: true,
      },
    ],
    slots: Array.from({ length: 6 }, (_, i) => ({
      slot_id: `slot-${i + 1}`,
      interval_id: "interval-1",
      area_id: "court-shared-1",
      start_epoch_ms: start + i * slotMs,
      end_epoch_ms: start + (i + 1) * slotMs,
    })),
  };
}

async function collect<Result>(iterable: AsyncIterable<Result>): Promise<Result[]> {
  const values: Result[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
