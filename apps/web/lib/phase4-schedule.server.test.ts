import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "api.test" }),
  cookies: async () => ({
    get: (name: string) => (name === "matchday_session" ? { value: "session-token" } : undefined),
  }),
}));

import { getScheduleDocument } from "./phase4-schedule.server";

const originalApiBase = process.env.MATCHDAY_API_BASE_URL;
const originalDataMode = process.env.MATCHDAY_PHASE2_DATA_MODE;

function constraints() {
  return {
    minimum_rest: { mode: "preferred", value: { minutes: 60 }, weight: 4 },
    maximum_matches_per_day: { mode: "required", value: { matches: 4 } },
    preferred_final_time: {
      mode: "preferred",
      value: { target_start_epoch_ms: Date.parse("2026-08-15T07:00:00.000Z"), tolerance_minutes: 30 },
      weight: 3,
    },
    entry_unavailable: { mode: "ignored", value: { by_entry_id: {} } },
    official_availability: { mode: "ignored", value: { by_official_id: {} } },
    featured_playing_area: { mode: "ignored", value: { area_id: "area-1", match_ids: [] } },
    avoid_consecutive_matches: { mode: "preferred", value: { minutes: 30 }, weight: 4 },
    balance_early_matches: { mode: "preferred", value: { before_local_time: "09:00" }, weight: 2 },
    balance_late_matches: { mode: "preferred", value: { at_or_after_local_time: "16:00" }, weight: 2 },
    keep_division_together: { mode: "preferred", value: { maximum_area_count: 1 }, weight: 2 },
    preserve_existing_schedule: { mode: "ignored", value: { maximum_shift_minutes: 0, by_match_id: {} } },
  };
}

function quality(objective: "fastest" | "balanced" | "rest_focused") {
  return {
    score: 90,
    objective,
    valid: true,
    makespan_minutes: 120,
    minimum_rest_minutes: 60,
    maximum_matches_per_entry_day: 2,
    preferred_final_delta_minutes: 0,
    required_violation_count: 0,
    preferred_penalty: 0,
    components: [
      {
        key: "schedule_preservation",
        score: 100,
        weight: 5,
        measured: 0,
        unit: "matches",
        explanation: "0 of 0 existing assignments move; total start-time shift is 0 minutes.",
      },
    ],
  };
}

function job(
  objective: "fastest" | "balanced" | "rest_focused",
  id: string,
  updatedAt: string,
  overrides: { sourceRevision?: number; hardViolation?: boolean } = {},
) {
  const optionId = `option-${id}`;
  const hardViolation = overrides.hardViolation ?? false;
  return {
    id,
    competition_id: "competition-1",
    revision: 7,
    source_revision: overrides.sourceRevision ?? 4,
    capacity_revision: 2,
    capacity_hash: "a".repeat(64),
    status: "completed",
    objective,
    continued_from_job_id: null,
    current_best_option_id: optionId,
    current_best: {
      id: optionId,
      job_id: id,
      result_revision: 3,
      solver_iteration: 12,
      result_status: "valid",
      quality: quality(objective),
      assignments: [],
      violations: hardViolation
        ? [{ code: "area_overlap", severity: "hard", match_ids: ["match-1"], message: "Area overlaps." }]
        : [],
      assignment_hash: "b".repeat(64),
      created_at: updatedAt,
    },
    progress_iteration: 12,
    explored_candidates: 13,
    progress_updated_at: updatedAt,
    cancellation_requested_at: null,
    started_at: "2026-07-20T04:00:00.000Z",
    completed_at: updatedAt,
    failure_class: null,
    created_at: "2026-07-20T04:00:00.000Z",
    updated_at: updatedAt,
  };
}

describe("production schedule alternative loading", () => {
  beforeEach(() => {
    process.env.MATCHDAY_API_BASE_URL = "http://api.test";
    delete process.env.MATCHDAY_PHASE2_DATA_MODE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiBase === undefined) delete process.env.MATCHDAY_API_BASE_URL;
    else process.env.MATCHDAY_API_BASE_URL = originalApiBase;
    if (originalDataMode === undefined) delete process.env.MATCHDAY_PHASE2_DATA_MODE;
    else process.env.MATCHDAY_PHASE2_DATA_MODE = originalDataMode;
  });

  it("loads completed comparable jobs when active_job is null and rejects stale or hard-invalid newer options", async () => {
    const workspace = {
      competition: {
        id: "competition-1",
        name: "Singapore Open",
        time_zone: "Asia/Singapore",
        status: "draft",
        permission: "write",
        read_only: false,
        publication: { schedule_version: 0, published_schedule_revision_id: null },
      },
      generation: {
        source_revision: 4,
        capacity_revision: 2,
        capacity_hash: "a".repeat(64),
        objective: "balanced",
        format_revisions: [],
        constraints: constraints(),
      },
      areas: [],
      matches: [],
      active_job: null,
      current_revision: null,
      revisions: [],
      locks: [],
      warnings: [],
    };
    const jobs = [
      job("fastest", "fast-valid", "2026-07-20T04:03:00.000Z"),
      job("balanced", "balanced-valid", "2026-07-20T04:04:00.000Z"),
      job("rest_focused", "rest-valid", "2026-07-20T04:05:00.000Z"),
      job("fastest", "fast-stale", "2026-07-20T04:07:00.000Z", { sourceRevision: 3 }),
      job("balanced", "balanced-hard", "2026-07-20T04:06:00.000Z", { hardViolation: true }),
      { malformed_historical_job: true },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: URL | RequestInfo) => {
        const url = String(request);
        return new Response(JSON.stringify(url.endsWith("/schedule-jobs") ? jobs : workspace), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const document = await getScheduleDocument({
      competitionId: "competition-1",
      competitionName: "Singapore Open",
      timeZone: "Asia/Singapore",
      publicationRevision: "0",
    });

    expect(document.activeJob).toBeNull();
    expect(document.alternatives.map((option) => [option.objective, option.jobId, option.jobRevision])).toEqual([
      ["fastest", "fast-valid", 7],
      ["balanced", "balanced-valid", 7],
      ["rest_focused", "rest-valid", 7],
    ]);
  });
});
