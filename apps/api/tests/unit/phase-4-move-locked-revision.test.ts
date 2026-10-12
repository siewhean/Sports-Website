import { describe, expect, it } from "vitest";
import { Phase4Runtime } from "../../src/phase-4-runtime.js";

const ignored = <T>(value: T) => ({ mode: "ignored" as const, value });
const MINUTE = 60_000;
const base = Date.parse("2027-08-01T09:00:00Z");
const slot = (index: number) => ({
  slot_id: `w:${index + 1}`,
  interval_id: "w",
  area_id: "area",
  start_epoch_ms: base + index * 30 * MINUTE,
  end_epoch_ms: base + (index + 1) * 30 * MINUTE,
});
const slots = [slot(0), slot(1), slot(2), slot(3)];
const snapshot = {
  time_zone: "UTC",
  objective: "balanced",
  constraints: {
    minimum_rest: ignored({ minutes: 0 }),
    maximum_matches_per_day: ignored({ matches: 8 }),
    preferred_final_time: ignored({ target_start_epoch_ms: base, tolerance_minutes: 60 }),
    entry_unavailable: ignored({ by_entry_id: {} }),
    official_availability: ignored({ by_official_id: {} }),
    featured_playing_area: ignored({ area_id: "area", match_ids: [] }),
    avoid_consecutive_matches: ignored({ minutes: 0 }),
    balance_early_matches: ignored({ before_local_time: "09:00" }),
    balance_late_matches: ignored({ at_or_after_local_time: "18:00" }),
    keep_division_together: ignored({ maximum_area_count: 1 }),
    preserve_existing_schedule: ignored({ maximum_shift_minutes: 0, by_match_id: {} }),
  },
  matches: [
    {
      match_id: "locked",
      division_id: "div",
      duration_minutes: 30,
      dependency_match_ids: [],
      possible_entry_ids: ["a", "b"],
      official_ids: [],
      is_championship_final: false,
      fixed_assignment: {
        reason: "locked",
        area_id: "area",
        slot_id: slots[0]!.slot_id,
        start_epoch_ms: slots[0]!.start_epoch_ms,
        end_epoch_ms: slots[0]!.end_epoch_ms,
      },
    },
    {
      match_id: "free",
      division_id: "div",
      duration_minutes: 30,
      dependency_match_ids: [],
      possible_entry_ids: ["c", "d"],
      official_ids: [],
      is_championship_final: false,
    },
  ],
  slots,
};

// revisionDetail does not persist lock state, so every assignment arrives as
// fixed:false even when the source snapshot fixed the match.
const assignment = (matchId: string, index: number) => ({
  match_id: matchId,
  division_id: "div",
  area_id: "area",
  interval_id: "w",
  slot_id: slots[index]!.slot_id,
  start_epoch_ms: slots[index]!.start_epoch_ms,
  end_epoch_ms: slots[index]!.end_epoch_ms,
  fixed: false,
});
const revision = {
  source_job_id: "job",
  status: "ready_for_review",
  competition_id: "competition",
  assignments: [assignment("locked", 0), assignment("free", 1)],
};

type MovePreview = {
  validation: { valid: boolean; violations: Array<{ code: string; message: string }> };
};

function preview(lockedMatchIds: string[], matchId: string, index: number): Promise<MovePreview> {
  const instance = Object.create(Phase4Runtime.prototype) as {
    assertScheduleJobCurrent: () => Promise<void>;
    validateScheduleMoveOn: (tx: unknown, revision: unknown, input: unknown) => Promise<MovePreview>;
  };
  instance.assertScheduleJobCurrent = async () => undefined;
  const tx = {
    unsafe: async (query: string) =>
      query.includes("schedule_generation_jobs")
        ? [{ input_snapshot: snapshot }]
        : lockedMatchIds.map((match_id) => ({ match_id })),
  };
  return instance.validateScheduleMoveOn(tx, revision, {
    match_id: matchId,
    playing_area_id: "area",
    slot_id: slots[index]!.slot_id,
    start_epoch_ms: slots[index]!.start_epoch_ms,
    end_epoch_ms: slots[index]!.end_epoch_ms,
  });
}

describe("schedule move on a revision generated around locked matches", () => {
  it("accepts a valid move of an unlocked match", async () => {
    const result = await preview(["locked"], "free", 2);
    expect(result.validation.violations).toEqual([]);
    expect(result.validation.valid).toBe(true);
  });

  it("rejects moving the locked match with a clear error", async () => {
    const result = await preview(["locked"], "locked", 3);
    expect(result.validation.valid).toBe(false);
    const codes = result.validation.violations.map((violation) => violation.code);
    expect(codes).toContain("fixed_match_moved");
    expect(codes).not.toContain("assignment_mismatch");
  });
});
