import type { Phase3CapacityView, Phase3CompetitionStatus, Phase3SportCode } from "./phase-3.js";
import type { Phase4FormatRecommendationInput } from "./phase-4-ai.js";
import type { ScheduleObjective } from "./phase-4-schedule.js";

/** The production wizard has one ordered state machine on every viewport. */
export const phase4SetupStepIds = [
  "basics",
  "capacity",
  "settings",
  "entries",
  "format_preferences",
  "format_recommendations",
  "schedule_review",
  "review_publish",
] as const;
export type Phase4SetupStepId = (typeof phase4SetupStepIds)[number];

export type Phase4SetupIssue = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

export type Phase4SetupBasics = {
  readonly name: string;
  readonly sport_code: Phase3SportCode;
  readonly location: {
    readonly venue: string;
    readonly address: string;
    readonly locality: string | null;
    readonly country_code: string;
  };
  /** ISO civil dates in time_zone. */
  readonly starts_on: string;
  readonly ends_on: string;
  readonly time_zone: string;
  readonly locale: string;
  readonly entry_count: number;
  readonly division_count: number;
  readonly entry_count_status: "confirmed" | "estimated";
};

/**
 * A lossless pointer to the canonical Phase 3 capacity document. Consumers
 * must fetch this exact revision; they must never rebuild it from slot totals.
 */
export type Phase4SetupCapacityReference = {
  readonly kind: "phase3_capacity_revision";
  readonly competition_id: string;
  readonly revision: number;
  readonly time_zone: string;
  readonly area_ids: readonly string[];
  readonly source_hash: string;
  /** Derived preview only. Phase 3 remains the calculation authority. */
  readonly effective: Pick<
    Phase3CapacityView,
    | "slotMinutes"
    | "rawTotalSlots"
    | "fixedReserveSlots"
    | "availableMatchSlots"
    | "requiredMatchSlots"
    | "remainingMatchSlots"
    | "status"
  >;
};

/** Immutable references to the sport-pack settings pinned by Phase 3. */
export type Phase4SetupSettingsReference = {
  readonly competition_id: string;
  readonly scope: "competition" | "division";
  readonly division_id: string | null;
  readonly settings_revision: number;
  readonly mode: "recommended" | "customised";
  readonly pack_schema_version: number;
  readonly pack_version: string;
  readonly pack_definition_hash: string;
};

export type Phase4SetupDivisionEntryReference = {
  readonly division_id: string;
  readonly division_revision: number;
  readonly entry_ids: readonly string[];
  readonly confirmed_count: number;
  readonly placeholder_count: number;
};

/**
 * Import references contain no pasted text, file contents, contact fields or
 * row payloads. Those sensitive source values stay behind the authenticated
 * server import boundary.
 */
export type Phase4SetupImportReference = {
  readonly import_id: string;
  readonly status: "validated" | "applied" | "rolled_back";
  readonly accepted_row_count: number;
  readonly rejected_row_count: number;
};

export type Phase4SetupEntriesReference = {
  readonly competition_id: string;
  readonly divisions: readonly Phase4SetupDivisionEntryReference[];
  readonly imports: readonly Phase4SetupImportReference[];
  readonly total_entry_count: number;
};

/** Six explicit preference groups from the Assisted Setup specification. */
export type Phase4SetupFormatPreferences = {
  readonly minimum_matches: { readonly per_entry: number };
  readonly ranking: { readonly rank_all_entries: boolean };
  readonly knockout: { readonly required: boolean };
  readonly placement: { readonly required: boolean };
  readonly qualification: { readonly cross_group_allowed: boolean };
  readonly priority: { readonly value: "speed" | "simplicity" | "participation" };
};

export type Phase4SetupRecommendation = {
  readonly id: string;
  readonly format_revision_id: string;
  readonly format_definition_hash: string;
  readonly name: string;
  readonly structure: string;
  readonly advantage: string;
  readonly match_count: number;
  readonly minimum_matches_per_entry: number;
  readonly capacity_status: "fits" | "tight" | "requires_changes";
  readonly scheduling_status: "feasible" | "infeasible" | "not_checked";
  readonly warning_codes: readonly string[];
};

export type Phase4SetupRecommendationSelection = {
  /** Normal recommendations are capped at three; an over-capacity option is separate. */
  readonly recommendations: readonly Phase4SetupRecommendation[];
  readonly requires_changes: Phase4SetupRecommendation | null;
  readonly selected_recommendation_id: string | null;
  readonly acknowledged_capacity_shortfall: boolean;
  readonly recommendation_set_hash: string;
};

export type Phase4SetupScheduleSelection = {
  readonly schedule_job_id: string;
  readonly source_revision: number;
  readonly selected_recommendation_id: string;
  readonly format_revision_id: string;
  readonly format_definition_hash: string;
  readonly capacity_revision: number;
  readonly settings_references: readonly Pick<
    Phase4SetupSettingsReference,
    "scope" | "division_id" | "settings_revision" | "pack_definition_hash"
  >[];
  readonly selected_result_revision: number;
  readonly selected_result_hash: string;
  readonly objective: ScheduleObjective;
  readonly schedule_revision_id: string;
  readonly feasibility: "valid" | "infeasible";
};

type Phase4SetupReviewSelectionBase = {
  readonly selected_format_revision_id: string;
  readonly selected_schedule_result_hash: string;
  readonly capacity_revision: number;
  readonly settings_references: readonly Pick<
    Phase4SetupSettingsReference,
    "scope" | "division_id" | "settings_revision" | "pack_definition_hash"
  >[];
  readonly acknowledged_warning_codes: readonly string[];
};

export type Phase4SetupReviewSelection = Phase4SetupReviewSelectionBase &
  (
    | {
        readonly publication_status: "not_requested" | "publishing" | "failed";
        readonly published_schedule_revision_id: null;
      }
    | { readonly publication_status: "published"; readonly published_schedule_revision_id: string }
  );

export type Phase4SetupValues = {
  readonly basics: Phase4SetupBasics | null;
  readonly capacity: Phase4SetupCapacityReference | null;
  readonly settings: readonly Phase4SetupSettingsReference[] | null;
  readonly entries: Phase4SetupEntriesReference | null;
  readonly format_preferences: Phase4SetupFormatPreferences | null;
  readonly format_recommendations: Phase4SetupRecommendationSelection | null;
  readonly schedule_review: Phase4SetupScheduleSelection | null;
  readonly review_publish: Phase4SetupReviewSelection | null;
};

export type Phase4SetupStepState = {
  readonly id: Phase4SetupStepId;
  readonly status: "not_started" | "current" | "completed" | "error";
  readonly prerequisite_step_ids: readonly Phase4SetupStepId[];
  readonly errors: readonly Phase4SetupIssue[];
  readonly completed_at: string | null;
};

export type Phase4SetupAutosaveState = {
  readonly status: "idle" | "saving" | "saved" | "replaying" | "conflict" | "expired" | "read_only" | "error";
  readonly last_saved_at: string | null;
  readonly expires_at: string;
};

export type Phase4SetupDocument = {
  readonly schema_version: 1;
  readonly id: string;
  readonly organisation_id: string;
  readonly competition_id: string;
  readonly competition_status: Phase3CompetitionStatus;
  /** Server-owned optimistic concurrency token. */
  readonly revision: number;
  readonly status: "active" | "completed" | "expired";
  readonly current_step: Phase4SetupStepId;
  readonly completed_steps: readonly Phase4SetupStepId[];
  readonly steps: readonly Phase4SetupStepState[];
  readonly values: Phase4SetupValues;
  readonly permission: "read" | "write";
  readonly read_only: boolean;
  readonly autosave: Phase4SetupAutosaveState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
};

export type Phase4SetupStepValue = {
  [Step in Phase4SetupStepId]: { readonly step_id: Step; readonly value: NonNullable<Phase4SetupValues[Step]> };
}[Phase4SetupStepId];

export type Phase4SetupAutosaveRequest = {
  readonly expected_revision: number;
  readonly idempotency_key: string;
  readonly transition:
    | { readonly kind: "save_step"; readonly step: Phase4SetupStepValue }
    | { readonly kind: "go_to_step"; readonly step_id: Phase4SetupStepId }
    | { readonly kind: "complete"; readonly review: Phase4SetupReviewSelection };
};

export type Phase4SetupAutosaveResponse =
  | { readonly outcome: "saved"; readonly document: Phase4SetupDocument }
  | { readonly outcome: "idempotent_replay"; readonly document: Phase4SetupDocument }
  | { readonly outcome: "conflict"; readonly current: Phase4SetupDocument }
  | { readonly outcome: "expired"; readonly document: Phase4SetupDocument }
  | { readonly outcome: "read_only"; readonly document: Phase4SetupDocument }
  | { readonly outcome: "idempotency_mismatch"; readonly document: Phase4SetupDocument };

export type Phase4SetupRecommendationInputResult =
  | { readonly ok: true; readonly value: Phase4FormatRecommendationInput }
  | {
      readonly ok: false;
      readonly missing_steps: readonly Extract<Phase4SetupStepId, "basics" | "capacity" | "format_preferences">[];
    };

/** Maps persisted values without repeating Phase 3 capacity calculations. */
export function mapSetupValuesToFormatRecommendationInput(
  values: Phase4SetupValues,
): Phase4SetupRecommendationInputResult {
  const missingSteps: Array<"basics" | "capacity" | "format_preferences"> = [];
  if (!values.basics) missingSteps.push("basics");
  if (!values.capacity) missingSteps.push("capacity");
  if (!values.format_preferences) missingSteps.push("format_preferences");
  if (missingSteps.length > 0) return { ok: false, missing_steps: missingSteps };

  const basics = values.basics!;
  const capacity = values.capacity!;
  const preferences = values.format_preferences!;
  return {
    ok: true,
    value: {
      sport: basics.sport_code,
      entryCount: basics.entry_count,
      divisionCount: basics.division_count,
      availableMatchSlots: capacity.effective.availableMatchSlots,
      minimumMatchesPerEntry: preferences.minimum_matches.per_entry,
      rankAllEntries: preferences.ranking.rank_all_entries,
      knockoutRequired: preferences.knockout.required,
      placementRequired: preferences.placement.required,
      crossGroupQualificationAllowed: preferences.qualification.cross_group_allowed,
      organiserPriority: preferences.priority.value,
    },
  };
}
