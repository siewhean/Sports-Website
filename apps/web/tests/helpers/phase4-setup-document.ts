import type { Phase4SetupDocument } from "@matchday/contracts";

export const competitionId = "cmp_sgopen_2026";
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

export function setupDocument(input: {
  startsOn?: string;
  endsOn?: string;
  revision: number;
  currentStep: (typeof stepIds)[number];
  name: string;
}): Phase4SetupDocument {
  const currentIndex = stepIds.indexOf(input.currentStep);
  const now = "2026-07-22T00:00:00.000Z";
  return {
    schema_version: 1,
    id: "0cc48815-adc6-4bda-838f-3b52eb8c7862",
    organisation_id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
    competition_id: competitionId,
    competition_status: "draft",
    revision: input.revision,
    status: "active",
    current_step: input.currentStep,
    completed_steps: stepIds.slice(0, currentIndex),
    steps: stepIds.map((id, index) => ({
      id,
      status: index < currentIndex ? "completed" : index === currentIndex ? "current" : "not_started",
      prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]!],
      errors: [],
      completed_at: index < currentIndex ? now : null,
    })),
    values: {
      basics: {
        name: input.name,
        sport_code: "canoe_polo",
        location: {
          venue: "OCBC Aquatic Centre",
          address: "7 Stadium Drive",
          locality: "Singapore",
          country_code: "SG",
        },
        starts_on: input.startsOn ?? "2026-08-15",
        ends_on: input.endsOn ?? "2026-08-16",
        time_zone: "Asia/Singapore",
        locale: "en-SG",
        entry_count: 16,
        division_count: 2,
        entry_count_status: "confirmed",
      },
      capacity: {
        kind: "phase3_capacity_revision",
        competition_id: competitionId,
        revision: 4,
        time_zone: "Asia/Singapore",
        area_ids: ["8e66bd53-a9cb-4cde-840a-cc94988ca461", "059d20be-13b3-4707-b4d1-14867693c019"],
        source_hash: "e2e-demo-capacity-hash",
        effective: {
          slotMinutes: 30,
          rawTotalSlots: 54,
          fixedReserveSlots: 2,
          availableMatchSlots: 52,
          requiredMatchSlots: 31,
          remainingMatchSlots: 21,
          status: "comfortable",
        },
      },
      settings: [
        {
          competition_id: competitionId,
          scope: "competition",
          division_id: null,
          settings_revision: 3,
          mode: "recommended",
          pack_schema_version: 1,
          pack_version: "2026.1",
          pack_definition_hash: "demo-settings-hash",
        },
      ],
      entries: {
        competition_id: competitionId,
        divisions: [],
        imports: [],
        total_entry_count: 16,
      },
      format_preferences: {
        minimum_matches: { per_entry: 3 },
        ranking: { rank_all_entries: true },
        knockout: { required: true },
        placement: { required: true },
        qualification: { cross_group_allowed: false },
        priority: { value: "participation" },
      },
      format_recommendations: null,
      schedule_review: null,
      review_publish: null,
    },
    permission: "write",
    read_only: false,
    autosave: {
      status: "saved",
      last_saved_at: now,
      expires_at: "2026-08-22T00:00:00.000Z",
    },
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
}
