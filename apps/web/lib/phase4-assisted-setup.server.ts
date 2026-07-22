import "server-only";

import { cookies, headers } from "next/headers";
import type { Phase4SetupDocument } from "@matchday/contracts";
import { cookieHostMatches } from "@/lib/phase2-organiser";
import {
  parseAssistedSetupDocument,
  type AssistedSetupPageDocument,
  type AssistedSetupSurfaceState,
} from "@/lib/phase4-assisted-setup";

function apiBaseUrl(): URL | null {
  try {
    const value = process.env.MATCHDAY_API_BASE_URL?.trim();
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function sessionCookie(apiUrl: URL): Promise<string | null> {
  const requestHeaders = await headers();
  if (!cookieHostMatches(requestHeaders.get("host"), apiUrl.hostname)) return null;
  const store = await cookies();
  for (const name of ["__Host-matchday_session", "matchday_session"]) {
    const value = store.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

function unavailable(
  competitionId: string,
  competitionName: string,
  state: AssistedSetupSurfaceState,
): AssistedSetupPageDocument {
  return { state, competitionId, competitionName, setup: null, resumeRequired: false };
}

function demoSetup(competitionId: string): Phase4SetupDocument {
  const now = "2026-07-20T06:18:00.000Z";
  const expires = "2026-08-19T06:18:00.000Z";
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
    id: "0cc48815-adc6-4bda-838f-3b52eb8c7862",
    organisation_id: "79685f62-e0f7-4c41-a329-5532bf41cfa2",
    competition_id: competitionId,
    competition_status: "draft",
    revision: 4,
    status: "active",
    current_step: "capacity",
    completed_steps: ["basics"],
    steps: stepIds.map((id, index) => ({
      id,
      status: index === 0 ? ("completed" as const) : index === 1 ? ("current" as const) : ("not_started" as const),
      prerequisite_step_ids: index === 0 ? [] : [stepIds[index - 1]!],
      errors: [],
      completed_at: index === 0 ? now : null,
    })),
    values: {
      basics: {
        name: "Singapore Open 2026",
        sport_code: "canoe_polo",
        location: {
          venue: "OCBC Aquatic Centre",
          address: "7 Stadium Drive",
          locality: "Singapore",
          country_code: "SG",
        },
        starts_on: "2026-08-15",
        ends_on: "2026-08-16",
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
        divisions: [
          {
            division_id: "a641f08e-23de-4611-8893-01bfebf42684",
            division_revision: 2,
            entry_ids: Array.from({ length: 8 }, (_, index) => `demo-entry-open-${index + 1}`),
            confirmed_count: 8,
            placeholder_count: 0,
          },
          {
            division_id: "fd16448b-61ab-4dd0-a0a1-b61e77fd5c3a",
            division_revision: 2,
            entry_ids: Array.from({ length: 8 }, (_, index) => `demo-entry-women-${index + 1}`),
            confirmed_count: 8,
            placeholder_count: 0,
          },
        ],
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
      format_recommendations: {
        recommendations: [
          {
            id: "balanced-groups",
            format_revision_id: "43e3501f-df87-466c-b2a7-ded47ae92ee5",
            format_definition_hash: "demo-format-balanced",
            name: "Balanced groups",
            structure: "Two groups, semi-finals, bronze match and final",
            advantage: "Every team plays at least three matches with a complete podium.",
            match_count: 31,
            minimum_matches_per_entry: 3,
            guaranteed_matches: 3,
            ranking_coverage: "all_entries",
            available_match_slots: 36,
            division_formats: [
              {
                division_id: "4a1cae2b-1ef7-4fb0-b323-7046077f7a80",
                candidate_division_id: "43e3501f-df87-466c-b2a7-ded47ae92ee1",
                format_revision_id: "43e3501f-df87-466c-b2a7-ded47ae92ee5",
                format_definition_hash: "demo-format-balanced",
                match_count: 31,
                guaranteed_matches: 3,
                ranking_coverage: "all_entries",
              },
            ],
            capacity_status: "fits",
            scheduling_status: "feasible",
            warning_codes: [],
          },
          {
            id: "compact-knockout",
            format_revision_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c8",
            format_definition_hash: "demo-format-compact",
            name: "Compact knockout",
            structure: "Seeded elimination with placement matches",
            advantage: "Finishes earlier while preserving final rankings.",
            match_count: 23,
            minimum_matches_per_entry: 2,
            guaranteed_matches: 2,
            ranking_coverage: "all_entries",
            available_match_slots: 36,
            division_formats: [
              {
                division_id: "4a1cae2b-1ef7-4fb0-b323-7046077f7a80",
                candidate_division_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c1",
                format_revision_id: "8f94c1f8-41dd-4500-9368-d8a4e7ca73c8",
                format_definition_hash: "demo-format-compact",
                match_count: 23,
                guaranteed_matches: 2,
                ranking_coverage: "all_entries",
              },
            ],
            capacity_status: "fits",
            scheduling_status: "feasible",
            warning_codes: [],
          },
        ],
        requires_changes: null,
        selected_recommendation_id: "balanced-groups",
        acknowledged_capacity_shortfall: false,
        recommendation_set_hash: "demo-recommendation-set",
      },
      schedule_review: null,
      review_publish: null,
    },
    permission: "write",
    read_only: false,
    autosave: { status: "saved", last_saved_at: now, expires_at: expires },
    created_at: "2026-07-20T05:50:00.000Z",
    updated_at: now,
    completed_at: null,
  };
}

export async function getAssistedSetupDocument(
  competitionId: string,
  competitionName: string,
  previewState?: string,
  previewStep?: string,
): Promise<AssistedSetupPageDocument> {
  if (process.env.MATCHDAY_PHASE2_DATA_MODE === "demo") {
    const allowed = new Set<AssistedSetupSurfaceState>([
      "ready",
      "loading",
      "empty",
      "error",
      "offline",
      "permission",
      "read-only",
      "conflict",
      "expired",
      "quota",
      "plan",
    ]);
    const state = allowed.has(previewState as AssistedSetupSurfaceState)
      ? (previewState as AssistedSetupSurfaceState)
      : "ready";
    if (state !== "ready" && state !== "read-only") return unavailable(competitionId, competitionName, state);
    const baseSetup = demoSetup(competitionId);
    const previewStepIds = baseSetup.steps.map((step) => step.id);
    const selectedStep = previewStepIds.includes(previewStep as (typeof previewStepIds)[number])
      ? (previewStep as (typeof previewStepIds)[number])
      : baseSetup.current_step;
    const selectedIndex = previewStepIds.indexOf(selectedStep);
    const setup: Phase4SetupDocument = {
      ...baseSetup,
      current_step: selectedStep,
      completed_steps: previewStepIds.slice(0, selectedIndex),
      steps: baseSetup.steps.map((step, index) => ({
        ...step,
        status: index < selectedIndex ? "completed" : index === selectedIndex ? "current" : "not_started",
        completed_at: index < selectedIndex ? baseSetup.updated_at : null,
      })),
    };
    return {
      state,
      competitionId,
      competitionName,
      setup: state === "read-only" ? { ...setup, permission: "read", read_only: true } : setup,
      resumeRequired: false,
    };
  }
  const base = apiBaseUrl();
  if (!base) return unavailable(competitionId, competitionName, "error");
  const cookie = await sessionCookie(base);
  if (!cookie) return unavailable(competitionId, competitionName, "permission");
  try {
    const response = await fetch(
      new URL(`/api/v1/competitions/${encodeURIComponent(competitionId)}/setup-draft`, base),
      {
        cache: "no-store",
        headers: { accept: "application/json", cookie },
      },
    );
    if (response.status === 404) return unavailable(competitionId, competitionName, "empty");
    if (response.status === 401 || response.status === 403)
      return unavailable(competitionId, competitionName, "permission");
    if (!response.ok) return unavailable(competitionId, competitionName, "error");
    const setup = parseAssistedSetupDocument(await response.json().catch(() => null), competitionId);
    if (!setup) return unavailable(competitionId, competitionName, "error");
    return {
      state: setup.status === "expired" ? "expired" : setup.read_only ? "read-only" : "ready",
      competitionId,
      competitionName,
      setup,
      resumeRequired: !setup.read_only,
    };
  } catch {
    return unavailable(competitionId, competitionName, "offline");
  }
}
