import type { Phase3SportCode } from "./phase-3.js";

export const phase4AiActionKinds = ["text_to_brief", "format_recommendations"] as const;
export type Phase4AiActionKind = (typeof phase4AiActionKinds)[number];

export const phase4AiMissingFields = [
  "sport",
  "entry_count",
  "division_count",
  "divisions",
  "location",
  "dates.start",
  "dates.end",
  "playing_areas",
  "daily_availability",
  "time_slot_minutes",
  "minimum_matches_per_entry",
  "knockout_required",
  "rank_all_entries",
  "placement_required",
  "cross_group_qualification_allowed",
  "organiser_priority",
] as const;
export type Phase4AiMissingField = (typeof phase4AiMissingFields)[number];

export type Phase4CompetitionBrief = {
  schema_version: "1.0";
  name: string | null;
  sport: Phase3SportCode | null;
  entry_count: number | null;
  division_count: number | null;
  divisions: Array<{ name: string; entry_count: number }> | null;
  location: {
    venue: string | null;
    address: string | null;
    locality: string | null;
    country_code: string | null;
  } | null;
  dates: { start: string | null; end: string | null };
  playing_areas: number | null;
  daily_availability: Array<{ date: string; start_time: string; end_time: string }> | null;
  time_slot_minutes: number | null;
  minimum_matches_per_entry: number | null;
  knockout_required: boolean | null;
  rank_all_entries: boolean | null;
  placement_required: boolean | null;
  cross_group_qualification_allowed: boolean | null;
  organiser_priority: "speed" | "simplicity" | "participation" | null;
  missing_fields: Phase4AiMissingField[];
};

export type Phase4SetupInput = {
  name: string | null;
  sport: Phase3SportCode;
  entryCount: number;
  divisionCount: number;
  divisions: Array<{ name: string; entryCount: number }>;
  location: NonNullable<Phase4CompetitionBrief["location"]>;
  dates: { start: string; end: string };
  playingAreas: number;
  dailyAvailability: Array<{ date: string; startTime: string; endTime: string }>;
  timeSlotMinutes: number;
  minimumMatchesPerEntry: number;
  knockoutRequired: boolean;
  rankAllEntries: boolean;
  placementRequired: boolean;
  crossGroupQualificationAllowed: boolean;
  organiserPriority: "speed" | "simplicity" | "participation";
};

export type Phase4FormatRecommendationInput = {
  sport: Phase3SportCode;
  entryCount: number;
  divisionCount: number;
  availableMatchSlots: number;
  minimumMatchesPerEntry: number;
  rankAllEntries: boolean;
  knockoutRequired: boolean;
  placementRequired: boolean;
  crossGroupQualificationAllowed: boolean;
  organiserPriority: "speed" | "simplicity" | "participation";
};

export type Phase4AiMappingResult<T> = { ok: true; value: T } | { ok: false; missing_fields: Phase4AiMissingField[] };

export type Phase4AiFailureCode =
  | "aborted"
  | "invalid_input"
  | "invalid_response"
  | "provider_authentication"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "quota_exhausted"
  | "timeout"
  | "unknown";

export type Phase4AiAccountingDecision = {
  charge: boolean;
  reason: "successful_uncached_action" | "cached" | "cache_unavailable" | "failed" | "invalid" | "manual_fallback";
  units: 0 | 1;
};

export type Phase4AiAuditMetadata = {
  action: Phase4AiActionKind;
  request_fingerprint: string;
  input_character_count: number;
  outcome: "success" | "failure" | "manual_fallback";
  cache_status: "hit" | "miss" | "not_checked";
  charged_units: 0 | 1;
  attempts: number;
  duration_ms: number;
  failure_code?: Phase4AiFailureCode;
  provider_request_id?: string;
};

export type Phase4AiBriefWorkflowState =
  | { status: "idle" }
  | { status: "requesting"; attempt: number; maximum_attempts: number }
  | { status: "retrying"; attempt: number; maximum_attempts: number; reason: Phase4AiFailureCode }
  | {
      status: "complete";
      source: "provider" | "cache";
      brief: Phase4CompetitionBrief;
      missing_fields: Phase4AiMissingField[];
      charged_units: 0 | 1;
    }
  | { status: "quota_exhausted"; manual_fallback_available: true }
  | {
      status: "manual_fallback";
      reason: Phase4AiFailureCode | "provider_disabled";
      preserved_text: string;
      charged_units: 0;
    };
