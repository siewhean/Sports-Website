import { SUPPORTED_SPORTS } from "./competition.js";

export const assistedSetupStepIds = [
  "basics",
  "capacity",
  "settings",
  "entries",
  "format_preferences",
  "format_recommendations",
  "schedule_review",
  "review_publish",
] as const;
export type AssistedSetupStepId = (typeof assistedSetupStepIds)[number];

export type AssistedSetupIssue = Readonly<{ code: string; path: string; message: string }>;

export type AssistedSetupStepValues = Readonly<{
  basics: Readonly<{
    name: string;
    sportCode: string;
    venue: string;
    address: string;
    locality: string | null;
    countryCode: string;
    startsOn: string;
    endsOn: string;
    timeZone: string;
    locale: string;
    entryCount: number;
    divisionCount: number;
    entryCountStatus: "confirmed" | "estimated";
  }> | null;
  capacity: Readonly<{
    kind: "phase3_capacity_revision";
    competitionId: string;
    revision: number;
    timeZone: string;
    areaIds: readonly string[];
    sourceHash: string;
    availableMatchSlots: number;
  }> | null;
  settings:
    | readonly Readonly<{
        scope: "competition" | "division";
        competitionId: string;
        divisionId: string | null;
        revision: number;
        mode: "recommended" | "customised";
        packSchemaVersion: number;
        packVersion: string;
        definitionHash: string;
      }>[]
    | null;
  entries: Readonly<{
    competitionId: string;
    totalEntryCount: number;
    divisions: readonly Readonly<{
      divisionId: string;
      divisionRevision: number;
      entryIds: readonly string[];
      confirmedCount: number;
      placeholderCount: number;
    }>[];
    imports: readonly Readonly<{
      importId: string;
      status: "validated" | "applied" | "rolled_back";
      acceptedRowCount: number;
      rejectedRowCount: number;
    }>[];
  }> | null;
  format_preferences: Readonly<{
    minimumMatchesPerEntry: number;
    rankAllEntries: boolean;
    knockoutRequired: boolean;
    placementRequired: boolean;
    crossGroupAllowed: boolean;
    priority: "speed" | "simplicity" | "participation";
  }> | null;
  format_recommendations: Readonly<{
    recommendations: readonly Readonly<{
      id: string;
      formatRevisionId: string;
      definitionHash: string;
      name: string;
      structure: string;
      advantage: string;
      matchCount: number;
      minimumMatchesPerEntry: number;
      capacityStatus: "fits" | "tight" | "requires_changes";
      schedulingStatus: "feasible" | "infeasible" | "not_checked";
      warningCodes: readonly string[];
    }>[];
    requiresChanges: Readonly<{
      id: string;
      formatRevisionId: string;
      definitionHash: string;
      name: string;
      structure: string;
      advantage: string;
      matchCount: number;
      minimumMatchesPerEntry: number;
      capacityStatus: "fits" | "tight" | "requires_changes";
      schedulingStatus: "feasible" | "infeasible" | "not_checked";
      warningCodes: readonly string[];
    }> | null;
    selectedRecommendationId: string | null;
    acknowledgedCapacityShortfall: boolean;
    recommendationSetHash: string;
  }> | null;
  schedule_review: Readonly<{
    scheduleJobId: string;
    sourceRevision: number;
    selectedRecommendationId: string;
    formatRevisionId: string;
    formatDefinitionHash: string;
    capacityRevision: number;
    settingsReferences: readonly Readonly<{
      scope: "competition" | "division";
      divisionId: string | null;
      revision: number;
      definitionHash: string;
    }>[];
    selectedResultRevision: number;
    selectedResultHash: string;
    objective: "fastest" | "balanced" | "rest_focused";
    scheduleRevisionId: string;
    feasibility: "valid" | "infeasible";
  }> | null;
  review_publish: Readonly<{
    selectedFormatRevisionId: string;
    selectedScheduleResultHash: string;
    capacityRevision: number;
    settingsReferences: readonly Readonly<{
      scope: "competition" | "division";
      divisionId: string | null;
      revision: number;
      definitionHash: string;
    }>[];
    acknowledgedWarningCodes: readonly string[];
    publicationStatus: "not_requested" | "publishing" | "published" | "failed";
    publishedScheduleRevisionId: string | null;
  }> | null;
}>;

export type AssistedSetupProgress = Readonly<{
  currentStep: AssistedSetupStepId;
  completedSteps: readonly AssistedSetupStepId[];
  steps: readonly Readonly<{
    id: AssistedSetupStepId;
    status: "not_started" | "current" | "completed" | "error";
    prerequisiteStepIds: readonly AssistedSetupStepId[];
    errors: readonly AssistedSetupIssue[];
  }>[];
}>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

function issue(code: string, path: string, message: string): AssistedSetupIssue {
  return { code, path, message };
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isCivilDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

type SettingsVersionReference = Readonly<{
  scope: "competition" | "division";
  divisionId: string | null;
  revision: number;
  definitionHash: string;
}>;

function equalSettingsReferences(
  left: readonly SettingsVersionReference[],
  right: readonly SettingsVersionReference[],
): boolean {
  const key = (reference: SettingsVersionReference) =>
    `${reference.scope}:${reference.divisionId ?? "competition"}:${reference.revision}:${reference.definitionHash}`;
  const orderedLeft = left.map(key).sort();
  const orderedRight = right.map(key).sort();
  return (
    orderedLeft.length === orderedRight.length && orderedLeft.every((value, index) => value === orderedRight[index])
  );
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

export function validateAssistedSetupStep(
  stepId: AssistedSetupStepId,
  values: AssistedSetupStepValues,
): readonly AssistedSetupIssue[] {
  const result: AssistedSetupIssue[] = [];
  if (stepId === "basics") {
    const value = values.basics;
    if (!value) return [issue("required", "basics", "Basics are required")];
    if (!nonEmpty(value.name)) result.push(issue("required", "basics.name", "Competition name is required"));
    if (!(SUPPORTED_SPORTS as readonly string[]).includes(value.sportCode))
      result.push(issue("invalid_sport", "basics.sport_code", "Sport is unsupported"));
    if (!nonEmpty(value.venue)) result.push(issue("required", "basics.location.venue", "Venue is required"));
    if (!nonEmpty(value.address)) result.push(issue("required", "basics.location.address", "Address is required"));
    if (!COUNTRY_PATTERN.test(value.countryCode))
      result.push(issue("invalid_country", "basics.location.country_code", "Country code must be ISO alpha-2"));
    if (!isCivilDate(value.startsOn) || !isCivilDate(value.endsOn) || value.endsOn < value.startsOn)
      result.push(issue("invalid_dates", "basics.dates", "Dates must be valid and ordered"));
    if (!isTimeZone(value.timeZone))
      result.push(issue("invalid_time_zone", "basics.time_zone", "Time zone is invalid"));
    if (!nonEmpty(value.locale)) result.push(issue("required", "basics.locale", "Locale is required"));
    if (!positiveInteger(value.entryCount))
      result.push(issue("invalid_count", "basics.entry_count", "Entry count must be positive"));
    if (!positiveInteger(value.divisionCount) || value.divisionCount > value.entryCount)
      result.push(issue("invalid_count", "basics.division_count", "Division count must fit the entry count"));
    if (value.entryCountStatus !== "confirmed" && value.entryCountStatus !== "estimated")
      result.push(issue("invalid_entry_count_status", "basics.entry_count_status", "Entry count status is invalid"));
  } else if (stepId === "capacity") {
    const value = values.capacity;
    if (!value) return [issue("required", "capacity", "Capacity is required")];
    if (
      value.kind !== "phase3_capacity_revision" ||
      !nonEmpty(value.competitionId) ||
      !positiveInteger(value.revision) ||
      !nonEmpty(value.sourceHash) ||
      !nonNegativeInteger(value.availableMatchSlots)
    )
      result.push(issue("invalid_reference", "capacity", "Capacity must reference an exact persisted revision"));
    if (
      value.areaIds.length === 0 ||
      value.areaIds.some((areaId) => !nonEmpty(areaId)) ||
      duplicateValues(value.areaIds).length > 0
    )
      result.push(issue("invalid_areas", "capacity.area_ids", "Capacity must reference distinct playing areas"));
    if (values.basics && value.timeZone !== values.basics.timeZone)
      result.push(issue("timezone_mismatch", "capacity.time_zone", "Capacity time zone must match Basics"));
  } else if (stepId === "settings") {
    const value = values.settings;
    if (!value?.length) return [issue("required", "settings", "Pinned settings are required")];
    if (!value.some((reference) => reference.scope === "competition" && reference.divisionId === null))
      result.push(issue("missing_competition_settings", "settings", "Competition settings are required"));
    const settingScopes = value.map((reference) => `${reference.scope}:${reference.divisionId ?? "competition"}`);
    if (duplicateValues(settingScopes).length > 0)
      result.push(issue("duplicate_settings", "settings", "Each settings scope may be pinned only once"));
    for (const [index, reference] of value.entries()) {
      if (
        !nonEmpty(reference.competitionId) ||
        !positiveInteger(reference.revision) ||
        !positiveInteger(reference.packSchemaVersion) ||
        !nonEmpty(reference.packVersion) ||
        !nonEmpty(reference.definitionHash)
      )
        result.push(issue("invalid_reference", `settings.${index}`, "Settings must reference a pinned pack revision"));
      if (reference.mode !== "recommended" && reference.mode !== "customised")
        result.push(issue("invalid_mode", `settings.${index}.mode`, "Settings mode is invalid"));
      if ((reference.scope === "competition") !== (reference.divisionId === null))
        result.push(issue("invalid_scope", `settings.${index}.division_id`, "Settings scope and division must agree"));
      if (values.capacity && reference.competitionId !== values.capacity.competitionId)
        result.push(
          issue("competition_mismatch", `settings.${index}.competition_id`, "Settings belong to another competition"),
        );
      if (
        reference.scope === "division" &&
        values.entries &&
        !values.entries.divisions.some((division) => division.divisionId === reference.divisionId)
      )
        result.push(
          issue("unknown_division", `settings.${index}.division_id`, "Settings reference an unknown division"),
        );
    }
  } else if (stepId === "entries") {
    const value = values.entries;
    if (!value) return [issue("required", "entries", "Entries are required")];
    if (!hasOnlyKeys(value, ["competitionId", "totalEntryCount", "divisions", "imports"]))
      result.push(issue("sensitive_payload", "entries", "Entry drafts may contain aggregate references only"));
    if (value.divisions.length !== values.basics?.divisionCount)
      result.push(issue("division_count_mismatch", "entries.divisions", "Division count must match Basics"));
    const entryIds = value.divisions.flatMap((division) => division.entryIds);
    const divisionIds = value.divisions.map((division) => division.divisionId);
    if (divisionIds.some((divisionId) => !nonEmpty(divisionId)) || duplicateValues(divisionIds).length > 0)
      result.push(issue("invalid_division", "entries.divisions", "Division IDs must be non-empty and distinct"));
    if (duplicateValues(entryIds).length > 0)
      result.push(issue("duplicate_entry", "entries.divisions", "An entry may belong to only one division"));
    if (entryIds.some((entryId) => !nonEmpty(entryId)))
      result.push(issue("invalid_entry", "entries.divisions", "Entry IDs must be non-empty"));
    if (entryIds.length !== value.totalEntryCount || value.totalEntryCount !== values.basics?.entryCount)
      result.push(issue("entry_count_mismatch", "entries.total_entry_count", "Entry count must match Basics"));
    if (
      value.divisions.some(
        (division) =>
          !hasOnlyKeys(division, [
            "divisionId",
            "divisionRevision",
            "entryIds",
            "confirmedCount",
            "placeholderCount",
          ]) ||
          division.entryIds.length === 0 ||
          !positiveInteger(division.divisionRevision) ||
          !nonNegativeInteger(division.confirmedCount) ||
          !nonNegativeInteger(division.placeholderCount) ||
          division.confirmedCount + division.placeholderCount !== division.entryIds.length,
      )
    )
      result.push(issue("invalid_reference", "entries.divisions", "Every division requires a persisted revision"));
    const importIds = value.imports.map((reference) => reference.importId);
    if (duplicateValues(importIds).length > 0)
      result.push(issue("invalid_import_reference", "entries.imports", "Import IDs must be distinct"));
    if (
      value.imports.some(
        (reference) =>
          !hasOnlyKeys(reference, ["importId", "status", "acceptedRowCount", "rejectedRowCount"]) ||
          !nonEmpty(reference.importId) ||
          !["validated", "applied", "rolled_back"].includes(reference.status) ||
          !Number.isSafeInteger(reference.acceptedRowCount) ||
          reference.acceptedRowCount < 0 ||
          !Number.isSafeInteger(reference.rejectedRowCount) ||
          reference.rejectedRowCount < 0,
      )
    )
      result.push(issue("invalid_import_reference", "entries.imports", "Import references must be aggregate-only"));
    if (values.capacity && value.competitionId !== values.capacity.competitionId)
      result.push(issue("competition_mismatch", "entries.competition_id", "Entries belong to another competition"));
  } else if (stepId === "format_preferences") {
    const value = values.format_preferences;
    if (!value) return [issue("required", "format_preferences", "Format preferences are required")];
    if (!positiveInteger(value.minimumMatchesPerEntry))
      result.push(
        issue(
          "invalid_minimum_matches",
          "format_preferences.minimum_matches.per_entry",
          "Minimum matches must be positive",
        ),
      );
    if (typeof value.rankAllEntries !== "boolean")
      result.push(issue("invalid_boolean", "format_preferences.ranking", "Ranking preference must be boolean"));
    if (typeof value.knockoutRequired !== "boolean")
      result.push(issue("invalid_boolean", "format_preferences.knockout", "Knockout preference must be boolean"));
    if (typeof value.placementRequired !== "boolean")
      result.push(issue("invalid_boolean", "format_preferences.placement", "Placement preference must be boolean"));
    if (typeof value.crossGroupAllowed !== "boolean")
      result.push(
        issue("invalid_boolean", "format_preferences.qualification", "Qualification preference must be boolean"),
      );
    if (!(["speed", "simplicity", "participation"] as readonly unknown[]).includes(value.priority))
      result.push(issue("invalid_priority", "format_preferences.priority", "Format priority is invalid"));
  } else if (stepId === "format_recommendations") {
    const value = values.format_recommendations;
    if (!value) return [issue("required", "format_recommendations", "Format recommendations are required")];
    if (value.recommendations.length === 0 || value.recommendations.length > 3)
      result.push(
        issue("invalid_count", "format_recommendations.recommendations", "Provide one to three recommendations"),
      );
    const candidates = [...value.recommendations, ...(value.requiresChanges ? [value.requiresChanges] : [])];
    const hashes = candidates.map((recommendation) => recommendation.definitionHash);
    const ids = candidates.map((recommendation) => recommendation.id);
    const revisionIds = candidates.map((recommendation) => recommendation.formatRevisionId);
    if (
      duplicateValues(hashes).length > 0 ||
      duplicateValues(ids).length > 0 ||
      duplicateValues(revisionIds).length > 0
    )
      result.push(issue("not_meaningfully_different", "format_recommendations", "Recommendations must be distinct"));
    if (value.recommendations.some((recommendation) => recommendation.capacityStatus === "requires_changes"))
      result.push(
        issue(
          "invalid_category",
          "format_recommendations.recommendations",
          "Over-capacity recommendations belong under requires changes",
        ),
      );
    if (value.requiresChanges && value.requiresChanges.capacityStatus !== "requires_changes")
      result.push(
        issue(
          "invalid_category",
          "format_recommendations.requires_changes",
          "The requires-changes alternative must exceed current capacity",
        ),
      );
    if (
      candidates.some(
        (recommendation) =>
          !nonEmpty(recommendation.id) ||
          !nonEmpty(recommendation.formatRevisionId) ||
          !nonEmpty(recommendation.definitionHash) ||
          !nonEmpty(recommendation.name) ||
          !nonEmpty(recommendation.structure) ||
          !nonEmpty(recommendation.advantage) ||
          !positiveInteger(recommendation.matchCount) ||
          !positiveInteger(recommendation.minimumMatchesPerEntry) ||
          !(["fits", "tight", "requires_changes"] as readonly unknown[]).includes(recommendation.capacityStatus) ||
          !(["feasible", "infeasible", "not_checked"] as readonly unknown[]).includes(
            recommendation.schedulingStatus,
          ) ||
          duplicateValues(recommendation.warningCodes).length > 0,
      )
    )
      result.push(issue("invalid_reference", "format_recommendations", "Every recommendation must pin a format"));
    if (
      values.capacity &&
      value.recommendations.some((recommendation) => recommendation.matchCount > values.capacity!.availableMatchSlots)
    )
      result.push(
        issue(
          "capacity_mismatch",
          "format_recommendations.recommendations",
          "A fitting recommendation cannot require more than the available slots",
        ),
      );
    if (
      values.capacity &&
      value.requiresChanges &&
      value.requiresChanges.matchCount <= values.capacity.availableMatchSlots
    )
      result.push(
        issue(
          "capacity_mismatch",
          "format_recommendations.requires_changes",
          "A requires-changes alternative must exceed the available slots",
        ),
      );
    const selected = candidates.find((recommendation) => recommendation.id === value.selectedRecommendationId);
    if (!selected)
      result.push(issue("selection_required", "format_recommendations.selected", "Select a recommendation"));
    if (selected?.capacityStatus === "requires_changes" && !value.acknowledgedCapacityShortfall)
      result.push(
        issue("capacity_acknowledgement", "format_recommendations.selected", "Acknowledge the capacity shortfall"),
      );
    if (selected?.schedulingStatus !== "feasible")
      result.push(
        issue("schedule_infeasible", "format_recommendations.selected", "Select a schedulable recommendation"),
      );
    if (!nonEmpty(value.recommendationSetHash))
      result.push(issue("invalid_reference", "format_recommendations.set_hash", "Recommendation set hash is required"));
  } else if (stepId === "schedule_review") {
    const value = values.schedule_review;
    if (!value) return [issue("required", "schedule_review", "A schedule selection is required")];
    if (
      !nonEmpty(value.scheduleJobId) ||
      !positiveInteger(value.sourceRevision) ||
      !nonEmpty(value.selectedRecommendationId) ||
      !nonEmpty(value.formatRevisionId) ||
      !nonEmpty(value.formatDefinitionHash) ||
      !positiveInteger(value.capacityRevision) ||
      value.settingsReferences.length === 0 ||
      value.settingsReferences.some(
        (reference) =>
          !positiveInteger(reference.revision) ||
          !nonEmpty(reference.definitionHash) ||
          (reference.scope === "competition") !== (reference.divisionId === null),
      ) ||
      !positiveInteger(value.selectedResultRevision) ||
      !nonEmpty(value.selectedResultHash) ||
      !nonEmpty(value.scheduleRevisionId)
    )
      result.push(issue("invalid_reference", "schedule_review", "Select an exact persisted schedule result"));
    if (value.feasibility !== "valid")
      result.push(issue("schedule_infeasible", "schedule_review", "An infeasible schedule cannot be reviewed"));
    if (!(["fastest", "balanced", "rest_focused"] as readonly unknown[]).includes(value.objective))
      result.push(issue("invalid_objective", "schedule_review.objective", "Schedule objective is invalid"));
    const recommendations = values.format_recommendations;
    const candidates = recommendations
      ? [
          ...recommendations.recommendations,
          ...(recommendations.requiresChanges ? [recommendations.requiresChanges] : []),
        ]
      : [];
    const selected = candidates.find(
      (recommendation) => recommendation.id === recommendations?.selectedRecommendationId,
    );
    if (
      !selected ||
      value.selectedRecommendationId !== selected.id ||
      value.formatRevisionId !== selected.formatRevisionId ||
      value.formatDefinitionHash !== selected.definitionHash
    )
      result.push(issue("stale_format", "schedule_review.format", "Schedule source must match the selected format"));
    if (values.capacity && value.capacityRevision !== values.capacity.revision)
      result.push(issue("stale_capacity", "schedule_review.capacity_revision", "Capacity changed before scheduling"));
    const settingsReferences =
      values.settings?.map((reference) => ({
        scope: reference.scope,
        divisionId: reference.divisionId,
        revision: reference.revision,
        definitionHash: reference.definitionHash,
      })) ?? [];
    if (!equalSettingsReferences(value.settingsReferences, settingsReferences))
      result.push(issue("stale_settings", "schedule_review.settings_references", "Settings changed before scheduling"));
  } else {
    const value = values.review_publish;
    if (!value) return [issue("required", "review_publish", "Final review is required")];
    if (
      !nonEmpty(value.selectedFormatRevisionId) ||
      !nonEmpty(value.selectedScheduleResultHash) ||
      !positiveInteger(value.capacityRevision) ||
      value.settingsReferences.length === 0 ||
      value.settingsReferences.some(
        (reference) =>
          !positiveInteger(reference.revision) ||
          !nonEmpty(reference.definitionHash) ||
          (reference.scope === "competition") !== (reference.divisionId === null),
      )
    )
      result.push(issue("invalid_reference", "review_publish", "Final review must pin every selected revision"));
    if (values.capacity && value.capacityRevision !== values.capacity.revision)
      result.push(issue("stale_capacity", "review_publish.capacity_revision", "Capacity changed after review"));
    if (values.schedule_review && value.selectedScheduleResultHash !== values.schedule_review.selectedResultHash)
      result.push(issue("stale_schedule", "review_publish.schedule_result", "Schedule changed after review"));
    if (
      values.schedule_review &&
      value.publishedScheduleRevisionId !== null &&
      value.publishedScheduleRevisionId !== values.schedule_review.scheduleRevisionId
    )
      result.push(issue("stale_schedule", "review_publish.schedule_revision", "A different schedule was published"));
    if (values.schedule_review && value.selectedFormatRevisionId !== values.schedule_review.formatRevisionId)
      result.push(issue("stale_format", "review_publish.format_revision", "Format changed after schedule review"));
    const settingsReferences =
      values.settings?.map((reference) => ({
        scope: reference.scope,
        divisionId: reference.divisionId,
        revision: reference.revision,
        definitionHash: reference.definitionHash,
      })) ?? [];
    if (!equalSettingsReferences(value.settingsReferences, settingsReferences))
      result.push(issue("stale_settings", "review_publish.settings_references", "Settings changed after review"));
    if (value.publicationStatus !== "published" || !value.publishedScheduleRevisionId)
      result.push(issue("publication_required", "review_publish.publication_status", "Publish the reviewed schedule"));
  }
  return result;
}

/** Derives progress from values; stored progress is never trusted as input. */
export function deriveAssistedSetupProgress(values: AssistedSetupStepValues): AssistedSetupProgress {
  const validations = new Map(
    assistedSetupStepIds.map((stepId) => [stepId, validateAssistedSetupStep(stepId, values)] as const),
  );
  const firstIncomplete = assistedSetupStepIds.findIndex((stepId) => (validations.get(stepId)?.length ?? 0) > 0);
  const allCompleted = firstIncomplete < 0;
  const completedSteps = allCompleted ? assistedSetupStepIds : assistedSetupStepIds.slice(0, firstIncomplete);
  const currentStep = allCompleted ? "review_publish" : (assistedSetupStepIds[firstIncomplete] ?? "basics");
  return {
    currentStep,
    completedSteps,
    steps: assistedSetupStepIds.map((stepId, index) => {
      const errors = validations.get(stepId) ?? [];
      const prerequisites = assistedSetupStepIds.slice(0, index);
      const unlocked = prerequisites.every((candidate) => completedSteps.includes(candidate));
      return {
        id: stepId,
        status:
          allCompleted || index < firstIncomplete
            ? "completed"
            : stepId === currentStep
              ? errors.length
                ? "error"
                : "current"
              : "not_started",
        prerequisiteStepIds: prerequisites,
        errors: unlocked ? errors : [],
      };
    }),
  };
}

export type AssistedSetupTransition =
  | Readonly<{ kind: "resume" }>
  | Readonly<{ kind: "go_to_step"; stepId: AssistedSetupStepId }>
  | Readonly<{ kind: "advance" }>;

export type AssistedSetupTransitionResult =
  | Readonly<{ ok: true; currentStep: AssistedSetupStepId; progress: AssistedSetupProgress }>
  | Readonly<{ ok: false; code: "prerequisite" | "invalid_step"; issues: readonly AssistedSetupIssue[] }>;

export type AssistedSetupAutosaveDecision =
  "save" | "idempotent_replay" | "idempotency_mismatch" | "conflict" | "expired" | "read_only";

/**
 * Server-side ordering for autosave guards. A stored idempotency receipt wins
 * even if its original expected revision is now stale.
 */
export function decideAssistedSetupAutosave(
  input: Readonly<{
    currentRevision: number;
    expectedRevision: number;
    status: "active" | "completed" | "expired";
    readOnly: boolean;
    expiresAtEpochMs: number;
    nowEpochMs: number;
    requestFingerprint: string;
    storedIdempotencyFingerprint: string | null;
  }>,
): AssistedSetupAutosaveDecision {
  if (input.storedIdempotencyFingerprint !== null) {
    return input.storedIdempotencyFingerprint === input.requestFingerprint
      ? "idempotent_replay"
      : "idempotency_mismatch";
  }
  if (input.readOnly || input.status === "completed") return "read_only";
  if (input.status === "expired" || input.nowEpochMs >= input.expiresAtEpochMs) return "expired";
  if (input.expectedRevision !== input.currentRevision) return "conflict";
  return "save";
}

export function transitionAssistedSetup(
  values: AssistedSetupStepValues,
  fromStep: AssistedSetupStepId,
  transition: AssistedSetupTransition,
): AssistedSetupTransitionResult {
  const progress = deriveAssistedSetupProgress(values);
  if (transition.kind === "resume") return { ok: true, currentStep: progress.currentStep, progress };
  const fromIndex = assistedSetupStepIds.indexOf(fromStep);
  const target = transition.kind === "advance" ? assistedSetupStepIds[fromIndex + 1] : transition.stepId;
  if (!target) return { ok: false, code: "invalid_step", issues: [] };
  const targetIndex = assistedSetupStepIds.indexOf(target);
  const missingPrerequisites = assistedSetupStepIds
    .slice(0, targetIndex)
    .filter((stepId) => !progress.completedSteps.includes(stepId));
  if (missingPrerequisites.length > 0) {
    return {
      ok: false,
      code: "prerequisite",
      issues: missingPrerequisites.flatMap((stepId) => validateAssistedSetupStep(stepId, values)),
    };
  }
  if (transition.kind === "advance") {
    const issues = validateAssistedSetupStep(fromStep, values);
    if (issues.length > 0) return { ok: false, code: "prerequisite", issues };
  }
  return { ok: true, currentStep: target, progress };
}
