import { describe, expect, it } from "vitest";
import {
  isScheduleLockResponse,
  isScheduleMoveValidation,
  isScheduleUnlockResponse,
  parseScheduleJobEnvelope,
  parseScheduleJobView,
  parseScheduleOptionView,
  parseScheduleRevisionView,
} from "./phase4-schedule";

const quality = {
  score: 91,
  objective: "balanced",
  valid: true,
  makespan_minutes: 600,
  minimum_rest_minutes: 60,
  maximum_matches_per_entry_day: 4,
  preferred_final_delta_minutes: 15,
  required_violation_count: 0,
  preferred_penalty: 5,
  components: [
    { key: "rest", score: 92, weight: 4, measured: 60, unit: "minutes", explanation: "Minimum rest is sixty minutes." },
  ],
};
const assignment = {
  match_id: "match-1",
  division_id: "division-1",
  area_id: "area-1",
  interval_id: "interval-1",
  slot_id: "slot-1",
  start_epoch_ms: 1_787_010_000_000,
  end_epoch_ms: 1_787_011_800_000,
  fixed: false,
};
const option = {
  id: "option-1",
  job_id: "job-1",
  result_revision: 2,
  solver_iteration: 12,
  result_status: "valid",
  quality,
  assignments: [assignment],
  violations: [],
  assignment_hash: "a".repeat(64),
  created_at: "2026-07-20T04:22:00.000Z",
};
const job = {
  id: "job-1",
  competition_id: "competition-1",
  revision: 3,
  source_revision: 4,
  capacity_revision: 2,
  capacity_hash: "b".repeat(64),
  status: "valid_best_found",
  objective: "balanced",
  continued_from_job_id: null,
  current_best_option_id: "option-1",
  current_best: option,
  progress_iteration: 12,
  explored_candidates: 13,
  progress_updated_at: "2026-07-20T04:22:00.000Z",
  cancellation_requested_at: null,
  started_at: "2026-07-20T04:20:00.000Z",
  completed_at: null,
  failure_class: null,
  created_at: "2026-07-20T04:20:00.000Z",
  updated_at: "2026-07-20T04:22:00.000Z",
};
const revision = {
  id: "revision-1",
  competition_id: "competition-1",
  revision: 4,
  parent_revision_id: null,
  source_job_id: "job-1",
  source_option_id: "option-1",
  status: "ready_for_review",
  editable_until: "2026-08-19T04:22:00.000Z",
  published_at: null,
  expired_at: null,
  created_at: "2026-07-20T04:22:00.000Z",
  updated_at: "2026-07-20T04:24:00.000Z",
};

describe("phase 4 schedule boundary parsers", () => {
  it("normalises valid option, job envelope and revision detail payloads", () => {
    expect(parseScheduleOptionView(option)?.assignments[0]?.startsAt).toBe(
      new Date(assignment.start_epoch_ms).toISOString(),
    );
    expect(
      parseScheduleJobEnvelope({ job, enqueued: true, recoverable: true, idempotent_replay: false })?.currentBest?.id,
    ).toBe("option-1");
    expect(parseScheduleJobView(job)?.exploredCandidates).toBe(13);
    expect(
      parseScheduleRevisionView(
        { ...revision, assignment_hash: "c".repeat(64), quality, assignments: [assignment] },
        true,
      )?.assignments,
    ).toHaveLength(1);
  });

  it("rejects unknown fields and malformed nested data instead of trusting the response", () => {
    expect(parseScheduleOptionView({ ...option, invented: true })).toBeNull();
    expect(parseScheduleJobView({ ...job, revision: 0 })).toBeNull();
    expect(
      parseScheduleRevisionView(
        {
          ...revision,
          assignment_hash: "c".repeat(64),
          quality,
          assignments: [{ ...assignment, end_epoch_ms: assignment.start_epoch_ms }],
        },
        true,
      ),
    ).toBeNull();
    expect(
      parseScheduleJobEnvelope({ job, enqueued: true, recoverable: true, idempotent_replay: false, extra: true }),
    ).toBeNull();
  });

  it("validates move consequences and lock mutation responses exactly", () => {
    expect(
      isScheduleMoveValidation({
        validation: { valid: true, violations: [] },
        assignments: [assignment],
        consequences: {
          moved_match_id: "match-1",
          from: {
            area_id: assignment.area_id,
            slot_id: assignment.slot_id,
            start_epoch_ms: assignment.start_epoch_ms,
            end_epoch_ms: assignment.end_epoch_ms,
          },
          to: {
            match_id: assignment.match_id,
            playing_area_id: assignment.area_id,
            slot_id: assignment.slot_id,
            start_epoch_ms: assignment.start_epoch_ms,
            end_epoch_ms: assignment.end_epoch_ms,
          },
          affected_match_ids: ["match-1"],
          dependency_match_ids: [],
          locked_match_ids: [],
          messages: ["Only the selected match moves."],
          quality,
        },
      }),
    ).toBe(true);
    expect(
      isScheduleLockResponse({
        id: "lock-1",
        match_id: "match-1",
        source_schedule_revision_id: "revision-1",
        playing_area_id: "area-1",
        start_epoch_ms: assignment.start_epoch_ms,
        end_epoch_ms: assignment.end_epoch_ms,
        locked_by: "account-1",
        created_at: "2026-07-20T04:22:00.000Z",
        idempotent_replay: false,
      }),
    ).toBe(true);
    expect(isScheduleUnlockResponse({ match_id: "match-1", unlocked: true, idempotent_replay: false })).toBe(true);
    expect(
      isScheduleUnlockResponse({ match_id: "match-1", unlocked: true, idempotent_replay: false, surprise: 1 }),
    ).toBe(false);
  });
});
