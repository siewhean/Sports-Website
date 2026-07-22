import { describe, expect, it } from "vitest";
import type { ScheduleOption } from "./phase4-schedule";
import { syncAcceptedScheduleWithSetup } from "./phase4-schedule-setup-sync";

const competitionId = "00000000-0000-4000-8000-000000000001";
const jobId = "00000000-0000-4000-8000-000000000002";
const optionId = "00000000-0000-4000-8000-000000000003";
const scheduleId = "00000000-0000-4000-8000-000000000004";
const hash = "a".repeat(64);
const now = "2026-07-23T00:00:00.000Z";

function option(): ScheduleOption {
  return {
    id: optionId,
    jobId,
    jobRevision: 3,
    resultRevision: 2,
    objective: "balanced",
    quality: {
      score: 90,
      objective: "balanced",
      valid: true,
      makespanMinutes: 300,
      minimumRestMinutes: 45,
      maximumMatchesPerEntryDay: 3,
      preferredFinalDeltaMinutes: 0,
      requiredViolationCount: 0,
      preferredPenalty: 10,
      components: [],
    },
    assignments: [],
    violations: [],
    assignmentHash: hash,
    createdAt: now,
  };
}

function accepted(overrides: Record<string, unknown> = {}) {
  return {
    id: scheduleId,
    competition_id: competitionId,
    revision: 1,
    parent_revision_id: null,
    source_job_id: jobId,
    source_option_id: optionId,
    status: "ready_for_review",
    editable_until: "2026-08-23T00:00:00.000Z",
    published_at: null,
    expired_at: null,
    created_at: now,
    updated_at: now,
    assignment_hash: hash,
    quality: null,
    assignments: [],
    idempotent_replay: false,
    ...overrides,
  };
}

describe("accepted schedule provenance", () => {
  it.each([
    ["job", { source_job_id: "00000000-0000-4000-8000-000000000099" }],
    ["option", { source_option_id: "00000000-0000-4000-8000-000000000099" }],
    ["assignment hash", { assignment_hash: "b".repeat(64) }],
  ])("rejects a mismatched %s before reading setup", async (_label, override) => {
    let fetchCalls = 0;
    const fetcher = (async () => {
      fetchCalls += 1;
      throw new Error("Setup fetch must not run for forged provenance");
    }) as typeof fetch;

    await expect(
      syncAcceptedScheduleWithSetup(
        {
          competitionId,
          sourceRevision: 4,
          capacityRevision: 2,
          option: option(),
          response: accepted(override),
        },
        fetcher,
      ),
    ).rejects.toThrow(/does not match the selected solver option/i);
    expect(fetchCalls).toBe(0);
  });
});
