import { describe, expect, it } from "vitest";
import type { Phase4SetupDocument } from "@matchday/contracts";
import {
  isAssistedSetupAutosaveRequest,
  parseAssistedSetupDocument,
} from "./phase4-assisted-setup-current";
import type { ScheduleOption } from "./phase4-schedule";
import { syncAcceptedScheduleWithSetup, syncPublishedScheduleWithSetup } from "./phase4-schedule-setup-sync";

const competitionId = "00000000-0000-4000-8000-000000000001";
const organisationId = "00000000-0000-4000-8000-000000000002";
const divisionId = "00000000-0000-4000-8000-000000000003";
const formatId = "00000000-0000-4000-8000-000000000004";
const jobId = "00000000-0000-4000-8000-000000000005";
const optionId = "00000000-0000-4000-8000-000000000006";
const scheduleId = "00000000-0000-4000-8000-000000000007";
const candidateId = "00000000-0000-4000-8000-000000000008";
const now = "2026-07-22T00:00:00.000Z";
const hash = "a".repeat(64);

function setupDocument(
  overrides: Partial<Phase4SetupDocument> = {},
  valueOverrides: Partial<Phase4SetupDocument["values"]> = {},
): Phase4SetupDocument {
  const stepIds = [
    "basics",
    "capacity",
    "settings",
    "entries",
    "format_preferences",
    "format_recommendations",
    "schedule_review",
    "review_publish",
  ] as const;
  return {
    schema_version: 1,
    id: "00000000-0000-4000-8000-000000000009",
    organisation_id: organisationId,
    competition_id: competitionId,
    competition_status: "ready",
    revision: 7,
    status: "active",
    current_step: "schedule_review",
    completed_steps: stepIds.slice(0, 6),
    steps: stepIds.map((id, index) => ({
      id,
      status: index < 6 ? "completed" : index === 6 ? "current" : "not_started",
      prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]!],
      errors: [],
      completed_at: index < 6 ? now : null,
    })),
    values: {
      basics: {
        name: "Gate B Sync Cup",
        sport_code: "badminton",
        location: { venue: "Hall", address: "1 Road", locality: "Singapore", country_code: "SG" },
        starts_on: "2027-11-01",
        ends_on: "2027-11-01",
        time_zone: "Asia/Singapore",
        locale: "en-SG",
        entry_count: 8,
        division_count: 1,
        entry_count_status: "confirmed",
      },
      capacity: {
        kind: "phase3_capacity_revision",
        competition_id: competitionId,
        revision: 2,
        time_zone: "Asia/Singapore",
        area_ids: ["00000000-0000-4000-8000-000000000010"],
        source_hash: hash,
        effective: {
          slotMinutes: 40,
          rawTotalSlots: 21,
          fixedReserveSlots: 0,
          availableMatchSlots: 21,
          requiredMatchSlots: 7,
          remainingMatchSlots: 14,
          status: "comfortable",
        },
      },
      settings: [
        {
          competition_id: competitionId,
          scope: "competition",
          division_id: null,
          settings_revision: 1,
          mode: "recommended",
          pack_schema_version: 1,
          pack_version: "badminton-1",
          pack_definition_hash: hash,
        },
        {
          competition_id: competitionId,
          scope: "division",
          division_id: divisionId,
          settings_revision: 1,
          mode: "recommended",
          pack_schema_version: 1,
          pack_version: "badminton-1",
          pack_definition_hash: hash,
        },
      ],
      entries: {
        competition_id: competitionId,
        divisions: [
          {
            division_id: divisionId,
            division_revision: 1,
            entry_ids: Array.from(
              { length: 8 },
              (_, index) => `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
            ),
            confirmed_count: 8,
            placeholder_count: 0,
          },
        ],
        imports: [],
        total_entry_count: 8,
      },
      format_preferences: {
        minimum_matches: { per_entry: 1 },
        ranking: { rank_all_entries: false },
        knockout: { required: true },
        placement: { required: false },
        qualification: { cross_group_allowed: true },
        priority: { value: "speed" },
      },
      format_recommendations: {
        recommendations: [
          {
            id: candidateId,
            format_revision_id: formatId,
            format_definition_hash: hash,
            name: "Fast knockout",
            structure: "Single elimination",
            advantage: "Finishes quickly",
            match_count: 7,
            minimum_matches_per_entry: 1,
            guaranteed_matches: 1,
            ranking_coverage: "champion",
            available_match_slots: 21,
            division_formats: [
              {
                division_id: divisionId,
                candidate_division_id: "00000000-0000-4000-8000-000000000011",
                format_revision_id: formatId,
                format_definition_hash: hash,
                match_count: 7,
                guaranteed_matches: 1,
                ranking_coverage: "champion",
              },
            ],
            capacity_status: "fits",
            scheduling_status: "feasible",
            warning_codes: [],
          },
        ],
        requires_changes: null,
        selected_recommendation_id: candidateId,
        acknowledged_capacity_shortfall: false,
        recommendation_set_hash: hash,
      },
      schedule_review: null,
      review_publish: null,
      ...valueOverrides,
    },
    permission: "write",
    read_only: false,
    autosave: { status: "saved", last_saved_at: now, expires_at: "2026-08-22T00:00:00.000Z" },
    created_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  };
}

function option(): ScheduleOption {
  return {
    id: optionId,
    jobId,
    jobRevision: 4,
    resultRevision: 3,
    objective: "balanced",
    quality: {
      score: 95,
      objective: "balanced",
      valid: true,
      makespanMinutes: 240,
      minimumRestMinutes: 40,
      maximumMatchesPerEntryDay: 3,
      preferredFinalDeltaMinutes: 0,
      requiredViolationCount: 0,
      preferredPenalty: 5,
      components: [],
    },
    assignments: [],
    violations: [],
    assignmentHash: hash,
    createdAt: now,
  };
}

function revisionWire(status: "ready_for_review" | "published") {
  const revision = {
    id: scheduleId,
    competition_id: competitionId,
    revision: 1,
    parent_revision_id: null,
    source_job_id: jobId,
    source_option_id: optionId,
    status,
    editable_until: status === "published" ? null : "2026-08-22T00:00:00.000Z",
    published_at: status === "published" ? now : null,
    expired_at: null,
    created_at: now,
    updated_at: now,
    assignment_hash: hash,
    quality: null,
    assignments: [],
    idempotent_replay: false,
  };
  return status === "published" ? { ...revision, schedule_version: 1 } : revision;
}

function fetchSequence(payloads: unknown[], calls: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const payload = payloads.shift();
    if (payload === undefined) throw new Error("Unexpected fetch");
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("current Assisted Setup recommendation contract", () => {
  it("accepts selected and unselected canonical recommendation lineage", () => {
    const selected = setupDocument();
    expect(parseAssistedSetupDocument(selected, competitionId)).toEqual(selected);

    const unselected = structuredClone(selected);
    const selection = unselected.values.format_recommendations!;
    selection.selected_recommendation_id = null;
    selection.recommendations[0]!.format_revision_id = null;
    selection.recommendations[0]!.division_formats[0]!.format_revision_id = null;
    expect(parseAssistedSetupDocument(unselected, competitionId)).toEqual(unselected);
    expect(
      isAssistedSetupAutosaveRequest({
        expected_revision: unselected.revision,
        idempotency_key: "setup-current-parser-1",
        transition: {
          kind: "save_step",
          step: { step_id: "format_recommendations", value: selection },
        },
      }),
    ).toBe(true);
  });

  it("rejects recommendation evidence without per-division lineage", () => {
    const forged = structuredClone(setupDocument()) as unknown as Record<string, unknown>;
    const values = forged.values as Record<string, unknown>;
    const selection = values.format_recommendations as { recommendations: Array<Record<string, unknown>> };
    delete selection.recommendations[0]!.division_formats;
    expect(parseAssistedSetupDocument(forged, competitionId)).toBeNull();
  });
});

describe("schedule to Assisted Setup synchronization", () => {
  it("stores exact accepted option provenance and reduced settings pointers", async () => {
    const before = setupDocument();
    const after = setupDocument(
      { revision: 8, current_step: "review_publish", completed_steps: [...before.completed_steps, "schedule_review"] },
      {
        schedule_review: {
          schedule_job_id: jobId,
          source_revision: 5,
          selected_recommendation_id: candidateId,
          format_revision_id: formatId,
          format_definition_hash: hash,
          capacity_revision: 2,
          settings_references: [
            { scope: "competition", division_id: null, settings_revision: 1, pack_definition_hash: hash },
            { scope: "division", division_id: divisionId, settings_revision: 1, pack_definition_hash: hash },
          ],
          selected_result_revision: 3,
          selected_result_hash: hash,
          objective: "balanced",
          schedule_revision_id: scheduleId,
          feasibility: "valid",
        },
      },
    );
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await syncAcceptedScheduleWithSetup(
      { competitionId, sourceRevision: 5, capacityRevision: 2, option: option(), response: revisionWire("ready_for_review") },
      fetchSequence([before, { outcome: "saved", document: after }], calls),
    );

    expect(result.values.schedule_review).toEqual(after.values.schedule_review);
    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[1]!.init?.body)) as {
      expected_revision: number;
      transition: { step: { step_id: string; value: Record<string, unknown> } };
    };
    expect(body.expected_revision).toBe(7);
    expect(body.transition.step).toMatchObject({
      step_id: "schedule_review",
      value: {
        schedule_job_id: jobId,
        selected_recommendation_id: candidateId,
        format_revision_id: formatId,
        selected_result_revision: 3,
        selected_result_hash: hash,
        schedule_revision_id: scheduleId,
      },
    });
  });

  it("stores publication evidence against the exact accepted revision", async () => {
    const schedule = {
      schedule_job_id: jobId,
      source_revision: 5,
      selected_recommendation_id: candidateId,
      format_revision_id: formatId,
      format_definition_hash: hash,
      capacity_revision: 2,
      settings_references: [
        { scope: "competition" as const, division_id: null, settings_revision: 1, pack_definition_hash: hash },
        { scope: "division" as const, division_id: divisionId, settings_revision: 1, pack_definition_hash: hash },
      ],
      selected_result_revision: 3,
      selected_result_hash: hash,
      objective: "balanced" as const,
      schedule_revision_id: scheduleId,
      feasibility: "valid" as const,
    };
    const before = setupDocument(
      { revision: 8, current_step: "review_publish" },
      { schedule_review: schedule },
    );
    const review = {
      selected_format_revision_id: formatId,
      selected_schedule_result_hash: hash,
      capacity_revision: 2,
      settings_references: schedule.settings_references,
      acknowledged_warning_codes: [],
      publication_status: "published" as const,
      published_schedule_revision_id: scheduleId,
    };
    const after = setupDocument(
      { revision: 9, current_step: "review_publish" },
      { schedule_review: schedule, review_publish: review },
    );
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await syncPublishedScheduleWithSetup(
      { competitionId, response: revisionWire("published") },
      fetchSequence([before, { outcome: "saved", document: after }], calls),
    );

    expect(result.values.review_publish).toEqual(review);
    const body = JSON.parse(String(calls[1]!.init?.body)) as {
      expected_revision: number;
      transition: { step: { step_id: string; value: Record<string, unknown> } };
    };
    expect(body.expected_revision).toBe(8);
    expect(body.transition.step).toMatchObject({
      step_id: "review_publish",
      value: { published_schedule_revision_id: scheduleId, publication_status: "published" },
    });
  });
});
