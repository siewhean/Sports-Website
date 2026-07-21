import type { ScheduleJobInput, ScheduleJobResult, ScheduleQuality } from "@matchday/contracts";
import type { JobExecutionContext } from "@matchday/jobs";
import { vi } from "vitest";

import { deterministicJsonHash } from "../src/canonical.js";

export const jobId = "10000000-0000-4000-a000-000000000001";
export const competitionId = "20000000-0000-4000-a000-000000000001";

export function scheduleInput(): ScheduleJobInput {
  return {
    schema_version: 1,
    job_id: jobId,
    competition_id: competitionId,
    source_revision: 4,
    capacity_revision: 2,
    capacity_hash: "a".repeat(64),
    time_zone: "Asia/Singapore",
    objective: "balanced",
    matches: [],
    slots: [],
    constraints: {
      minimum_rest: { mode: "required", value: { minutes: 30 } },
      maximum_matches_per_day: { mode: "preferred", value: { matches: 3 }, weight: 2 },
      preferred_final_time: {
        mode: "preferred",
        value: { target_start_epoch_ms: 1_800_000, tolerance_minutes: 30 },
        weight: 1,
      },
      entry_unavailable: { mode: "required", value: { by_entry_id: {} } },
      official_availability: { mode: "ignored", value: { by_official_id: {} } },
      featured_playing_area: { mode: "ignored", value: { area_id: "", match_ids: [] } },
      avoid_consecutive_matches: { mode: "ignored", value: { minutes: 0 } },
      balance_early_matches: { mode: "ignored", value: { before_local_time: "09:00" } },
      balance_late_matches: { mode: "ignored", value: { at_or_after_local_time: "17:00" } },
      keep_division_together: { mode: "ignored", value: { maximum_area_count: 1 } },
      preserve_existing_schedule: {
        mode: "ignored",
        value: { maximum_shift_minutes: 0, by_match_id: {} },
      },
    },
  };
}

export function quality(score: number, makespan = 100): ScheduleQuality {
  const componentKeys: ScheduleQuality["components"][number]["key"][] = [
    "completion",
    "rest",
    "daily_balance",
    "preferred_final",
    "featured_area",
    "consecutive",
    "time_balance",
    "division_cohesion",
    "schedule_preservation",
    "entry_availability",
    "official_availability",
  ];
  return {
    score,
    objective: "balanced",
    valid: true,
    makespan_minutes: makespan,
    minimum_rest_minutes: 30,
    maximum_matches_per_entry_day: 2,
    preferred_final_delta_minutes: 0,
    required_violation_count: 0,
    preferred_penalty: 100 - score,
    components: componentKeys.map((key) => ({
      key,
      score: 100,
      weight: 1,
      measured: 0,
      unit: "percent",
      explanation: `${key} score`,
    })),
  };
}

export function candidate(score: number, revision = 0): ScheduleJobResult {
  return {
    schema_version: 1,
    job_id: jobId,
    source_revision: 4,
    result_revision: revision,
    status: "valid",
    assignments: [],
    violations: [],
    quality: quality(score),
    assignment_hash: "0".repeat(64),
  };
}

export function queuePayload(input = scheduleInput()) {
  return {
    schemaVersion: 1 as const,
    jobId,
    competitionId,
    inputHash: deterministicJsonHash(input),
    correlationId: "request-phase4-schedule",
  };
}

export function executionContext(overrides: Partial<JobExecutionContext> = {}): JobExecutionContext {
  return {
    jobId: "schedule.optimize:queue-id",
    attempt: 1,
    isCancellationRequested: vi.fn(async () => false),
    throwIfCancellationRequested: vi.fn(async () => undefined),
    updateProgress: vi.fn(async () => undefined),
    ...overrides,
  };
}
