import type {
  Phase4SetupAutosaveRequest,
  Phase4SetupAutosaveResponse,
  Phase4SetupDocument,
  Phase4SetupStepId,
  Phase4SetupStepValue,
} from "@matchday/contracts";

export type AssistedSetupSurfaceState =
  | "ready"
  | "loading"
  | "empty"
  | "error"
  | "offline"
  | "permission"
  | "read-only"
  | "conflict"
  | "expired"
  | "quota"
  | "plan";

export type AssistedSetupCreateResponse = Readonly<{
  document: Phase4SetupDocument;
  idempotent_replay: boolean;
}>;

export type AssistedSetupPageDocument = Readonly<{
  state: AssistedSetupSurfaceState;
  competitionId: string;
  competitionName: string;
  setup: Phase4SetupDocument | null;
  /** Live server-backed setup documents refresh canonical references on mount. */
  resumeRequired?: boolean;
}>;

export const assistedSetupSteps: ReadonlyArray<{ id: Phase4SetupStepId; label: string; short: string }> = [
  { id: "basics", label: "Basics", short: "Event identity" },
  { id: "capacity", label: "Capacity", short: "Areas and time" },
  { id: "settings", label: "Settings", short: "Pinned rules" },
  { id: "entries", label: "Entries", short: "Divisions and teams" },
  { id: "format_preferences", label: "Preferences", short: "Format priorities" },
  { id: "format_recommendations", label: "Recommendations", short: "Choose a format" },
  { id: "schedule_review", label: "Schedule", short: "Review an alternative" },
  { id: "review_publish", label: "Review", short: "Confirm and publish" },
];

export const phase4SetupCopy = {
  title: "Assisted setup",
  intro: "Build a competition from authoritative capacity, rules, entries and format evidence.",
  saved: "Draft saved",
  saving: "Saving draft",
  conflict: "A newer setup revision is available",
  offline: "Editing paused while offline",
  readOnly: "This setup is read only",
  permission: "You do not have permission to edit this setup",
  quota: "AI setup allowance is unavailable",
  plan: "This action is not included in the current plan",
} as const;

const stepIds = new Set<Phase4SetupStepId>(assistedSetupSteps.map((step) => step.id));
const ISO = /^\d{4}-\d{2}-\d{2}T/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function oneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === "string" && values.includes(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function integerFields(value: Record<string, unknown>, keys: readonly string[], minimum = 0): boolean {
  return keys.every((key) => integer(value[key], minimum));
}

function isBasics(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, [
      "name",
      "sport_code",
      "location",
      "starts_on",
      "ends_on",
      "time_zone",
      "locale",
      "entry_count",
      "division_count",
      "entry_count_status",
    ])
  )
    return false;
  const location = record(item.location);
  return Boolean(
    typeof item.name === "string" &&
    oneOf(item.sport_code, ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"]) &&
    location &&
    exactKeys(location, ["venue", "address", "locality", "country_code"]) &&
    typeof location.venue === "string" &&
    typeof location.address === "string" &&
    (location.locality === null || typeof location.locality === "string") &&
    typeof location.country_code === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(item.starts_on)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(item.ends_on)) &&
    typeof item.time_zone === "string" &&
    typeof item.locale === "string" &&
    integerFields(item, ["entry_count", "division_count"]) &&
    oneOf(item.entry_count_status, ["confirmed", "estimated"]),
  );
}

function isCapacity(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  const effective = item ? record(item.effective) : null;
  return Boolean(
    item &&
    exactKeys(item, ["kind", "competition_id", "revision", "time_zone", "area_ids", "source_hash", "effective"]) &&
    item.kind === "phase3_capacity_revision" &&
    typeof item.competition_id === "string" &&
    integer(item.revision, 1) &&
    typeof item.time_zone === "string" &&
    stringArray(item.area_ids) &&
    typeof item.source_hash === "string" &&
    effective &&
    exactKeys(effective, [
      "slotMinutes",
      "rawTotalSlots",
      "fixedReserveSlots",
      "availableMatchSlots",
      "requiredMatchSlots",
      "remainingMatchSlots",
      "status",
    ]) &&
    integerFields(effective, [
      "slotMinutes",
      "rawTotalSlots",
      "fixedReserveSlots",
      "availableMatchSlots",
      "requiredMatchSlots",
    ]) &&
    Number.isSafeInteger(effective.remainingMatchSlots) &&
    oneOf(effective.status, ["comfortable", "tight", "does_not_fit"]),
  );
}

function isSettingsReference(value: unknown, reduced = false): boolean {
  const item = record(value);
  if (!item) return false;
  const keys = reduced
    ? ["scope", "division_id", "settings_revision", "pack_definition_hash"]
    : [
        "competition_id",
        "scope",
        "division_id",
        "settings_revision",
        "mode",
        "pack_schema_version",
        "pack_version",
        "pack_definition_hash",
      ];
  return Boolean(
    exactKeys(item, keys) &&
    (reduced || typeof item.competition_id === "string") &&
    oneOf(item.scope, ["competition", "division"]) &&
    (item.division_id === null || typeof item.division_id === "string") &&
    integer(item.settings_revision, 1) &&
    (reduced || oneOf(item.mode, ["recommended", "customised"])) &&
    (reduced || integer(item.pack_schema_version, 1)) &&
    (reduced || typeof item.pack_version === "string") &&
    typeof item.pack_definition_hash === "string",
  );
}

function isSettings(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.every((item) => isSettingsReference(item)));
}

function isEntries(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  if (!item || !exactKeys(item, ["competition_id", "divisions", "imports", "total_entry_count"])) return false;
  return Boolean(
    typeof item.competition_id === "string" &&
    Array.isArray(item.divisions) &&
    item.divisions.every((raw) => {
      const division = record(raw);
      return Boolean(
        division &&
        exactKeys(division, [
          "division_id",
          "division_revision",
          "entry_ids",
          "confirmed_count",
          "placeholder_count",
        ]) &&
        typeof division.division_id === "string" &&
        integer(division.division_revision, 1) &&
        stringArray(division.entry_ids) &&
        integerFields(division, ["confirmed_count", "placeholder_count"]),
      );
    }) &&
    Array.isArray(item.imports) &&
    item.imports.every((raw) => {
      const importRef = record(raw);
      return Boolean(
        importRef &&
        exactKeys(importRef, ["import_id", "status", "accepted_row_count", "rejected_row_count"]) &&
        typeof importRef.import_id === "string" &&
        oneOf(importRef.status, ["validated", "applied", "rolled_back"]) &&
        integerFields(importRef, ["accepted_row_count", "rejected_row_count"]),
      );
    }) &&
    integer(item.total_entry_count),
  );
}

function isFormatPreferences(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  if (!item || !exactKeys(item, ["minimum_matches", "ranking", "knockout", "placement", "qualification", "priority"]))
    return false;
  const minimum = record(item.minimum_matches);
  const ranking = record(item.ranking);
  const knockout = record(item.knockout);
  const placement = record(item.placement);
  const qualification = record(item.qualification);
  const priority = record(item.priority);
  return Boolean(
    minimum &&
    exactKeys(minimum, ["per_entry"]) &&
    integer(minimum.per_entry, 1) &&
    ranking &&
    exactKeys(ranking, ["rank_all_entries"]) &&
    typeof ranking.rank_all_entries === "boolean" &&
    knockout &&
    exactKeys(knockout, ["required"]) &&
    typeof knockout.required === "boolean" &&
    placement &&
    exactKeys(placement, ["required"]) &&
    typeof placement.required === "boolean" &&
    qualification &&
    exactKeys(qualification, ["cross_group_allowed"]) &&
    typeof qualification.cross_group_allowed === "boolean" &&
    priority &&
    exactKeys(priority, ["value"]) &&
    oneOf(priority.value, ["speed", "simplicity", "participation"]),
  );
}

function isRecommendation(value: unknown): boolean {
  const item = record(value);
  const divisionFormats = item?.division_formats;
  return Boolean(
    item &&
    exactKeys(item, [
      "id",
      "format_revision_id",
      "format_definition_hash",
      "name",
      "structure",
      "advantage",
      "match_count",
      "minimum_matches_per_entry",
      "guaranteed_matches",
      "ranking_coverage",
      "available_match_slots",
      "division_formats",
      "capacity_status",
      "scheduling_status",
      "warning_codes",
    ]) &&
    ["id", "format_definition_hash", "name", "structure", "advantage"].every((key) => typeof item[key] === "string") &&
    (item.format_revision_id === null || typeof item.format_revision_id === "string") &&
    integerFields(item, ["match_count", "minimum_matches_per_entry", "guaranteed_matches"], 1) &&
    integer(item.available_match_slots) &&
    oneOf(item.ranking_coverage, ["all_entries", "podium", "champion"]) &&
    Array.isArray(divisionFormats) &&
    divisionFormats.length > 0 &&
    divisionFormats.every((raw) => {
      const division = record(raw);
      return Boolean(
        division &&
        exactKeys(division, [
          "division_id",
          "candidate_division_id",
          "format_revision_id",
          "format_definition_hash",
          "match_count",
          "guaranteed_matches",
          "ranking_coverage",
        ]) &&
        typeof division.division_id === "string" &&
        typeof division.candidate_division_id === "string" &&
        (division.format_revision_id === null || typeof division.format_revision_id === "string") &&
        typeof division.format_definition_hash === "string" &&
        integerFields(division, ["match_count", "guaranteed_matches"], 1) &&
        oneOf(division.ranking_coverage, ["all_entries", "podium", "champion"]),
      );
    }) &&
    oneOf(item.capacity_status, ["fits", "tight", "requires_changes"]) &&
    oneOf(item.scheduling_status, ["feasible", "infeasible", "not_checked"]) &&
    stringArray(item.warning_codes),
  );
}

function isRecommendations(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  return Boolean(
    item &&
    exactKeys(item, [
      "recommendations",
      "requires_changes",
      "selected_recommendation_id",
      "acknowledged_capacity_shortfall",
      "recommendation_set_hash",
    ]) &&
    Array.isArray(item.recommendations) &&
    item.recommendations.length <= 3 &&
    item.recommendations.every(isRecommendation) &&
    (item.requires_changes === null || isRecommendation(item.requires_changes)) &&
    (item.selected_recommendation_id === null || typeof item.selected_recommendation_id === "string") &&
    typeof item.acknowledged_capacity_shortfall === "boolean" &&
    typeof item.recommendation_set_hash === "string",
  );
}

function isScheduleReview(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  return Boolean(
    item &&
    exactKeys(item, [
      "schedule_job_id",
      "source_revision",
      "selected_recommendation_id",
      "format_revision_id",
      "format_definition_hash",
      "capacity_revision",
      "settings_references",
      "selected_result_revision",
      "selected_result_hash",
      "objective",
      "schedule_revision_id",
      "feasibility",
    ]) &&
    [
      "schedule_job_id",
      "selected_recommendation_id",
      "format_revision_id",
      "format_definition_hash",
      "selected_result_hash",
      "schedule_revision_id",
    ].every((key) => typeof item[key] === "string") &&
    integerFields(item, ["source_revision", "capacity_revision", "selected_result_revision"], 1) &&
    Array.isArray(item.settings_references) &&
    item.settings_references.every((reference) => isSettingsReference(reference, true)) &&
    oneOf(item.objective, ["fastest", "balanced", "rest_focused"]) &&
    oneOf(item.feasibility, ["valid", "infeasible"]),
  );
}

function isReviewPublish(value: unknown): boolean {
  if (value === null) return true;
  const item = record(value);
  return Boolean(
    item &&
    exactKeys(item, [
      "selected_format_revision_id",
      "selected_schedule_result_hash",
      "capacity_revision",
      "settings_references",
      "acknowledged_warning_codes",
      "publication_status",
      "published_schedule_revision_id",
    ]) &&
    typeof item.selected_format_revision_id === "string" &&
    typeof item.selected_schedule_result_hash === "string" &&
    integer(item.capacity_revision, 1) &&
    Array.isArray(item.settings_references) &&
    item.settings_references.every((reference) => isSettingsReference(reference, true)) &&
    stringArray(item.acknowledged_warning_codes) &&
    oneOf(item.publication_status, ["not_requested", "publishing", "failed", "published"]) &&
    (item.publication_status === "published"
      ? typeof item.published_schedule_revision_id === "string"
      : item.published_schedule_revision_id === null),
  );
}

function hasSetupValues(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
    exactKeys(item, [
      "basics",
      "capacity",
      "settings",
      "entries",
      "format_preferences",
      "format_recommendations",
      "schedule_review",
      "review_publish",
    ]) &&
    isBasics(item.basics) &&
    isCapacity(item.capacity) &&
    isSettings(item.settings) &&
    isEntries(item.entries) &&
    isFormatPreferences(item.format_preferences) &&
    isRecommendations(item.format_recommendations) &&
    isScheduleReview(item.schedule_review) &&
    isReviewPublish(item.review_publish),
  );
}

export function isPhase4SetupIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,200}$/.test(value);
}

export function isAssistedSetupStepValue(value: unknown): value is Phase4SetupStepValue {
  const item = record(value);
  if (!item || !exactKeys(item, ["step_id", "value"]) || item.value === null) return false;
  switch (item.step_id) {
    case "basics":
      return isBasics(item.value);
    case "capacity":
      return isCapacity(item.value);
    case "settings":
      return isSettings(item.value);
    case "entries":
      return isEntries(item.value);
    case "format_preferences":
      return isFormatPreferences(item.value);
    case "format_recommendations":
      return isRecommendations(item.value);
    case "schedule_review":
      return isScheduleReview(item.value);
    case "review_publish":
      return isReviewPublish(item.value);
    default:
      return false;
  }
}

export function parseAssistedSetupDocument(payload: unknown, competitionId: string): Phase4SetupDocument | null {
  const item = record(payload);
  if (!item || item.competition_id !== competitionId) return null;
  const required = [
    "schema_version",
    "id",
    "organisation_id",
    "competition_id",
    "competition_status",
    "revision",
    "status",
    "current_step",
    "completed_steps",
    "steps",
    "values",
    "permission",
    "read_only",
    "autosave",
    "created_at",
    "updated_at",
    "completed_at",
  ];
  if (Object.keys(item).sort().join(",") !== required.sort().join(",")) return null;
  if (
    item.schema_version !== 1 ||
    typeof item.id !== "string" ||
    typeof item.organisation_id !== "string" ||
    !oneOf(item.competition_status, ["draft", "ready", "published", "live", "completed", "archived"]) ||
    !integer(item.revision, 1) ||
    !["active", "completed", "expired"].includes(String(item.status)) ||
    !stepIds.has(item.current_step as Phase4SetupStepId) ||
    !strings(item.completed_steps) ||
    !item.completed_steps.every((id) => stepIds.has(id as Phase4SetupStepId)) ||
    !Array.isArray(item.steps) ||
    item.steps.length !== assistedSetupSteps.length ||
    !hasSetupValues(item.values) ||
    !["read", "write"].includes(String(item.permission)) ||
    typeof item.read_only !== "boolean" ||
    (item.permission === "read") !== item.read_only ||
    !isIso(item.created_at) ||
    !isIso(item.updated_at) ||
    (item.completed_at !== null && !isIso(item.completed_at))
  )
    return null;
  const autosave = record(item.autosave);
  if (
    !autosave ||
    !exactKeys(autosave, ["status", "last_saved_at", "expires_at"]) ||
    !["idle", "saving", "saved", "replaying", "conflict", "expired", "read_only", "error"].includes(
      String(autosave.status),
    ) ||
    (autosave.last_saved_at !== null && !isIso(autosave.last_saved_at)) ||
    !isIso(autosave.expires_at)
  )
    return null;
  const seen = new Set<string>();
  for (const rawStep of item.steps) {
    const step = record(rawStep);
    if (
      !step ||
      !exactKeys(step, ["id", "status", "prerequisite_step_ids", "errors", "completed_at"]) ||
      !stepIds.has(step.id as Phase4SetupStepId) ||
      seen.has(String(step.id)) ||
      !["not_started", "current", "completed", "error"].includes(String(step.status)) ||
      !strings(step.prerequisite_step_ids) ||
      !step.prerequisite_step_ids.every((id) => stepIds.has(id as Phase4SetupStepId)) ||
      !Array.isArray(step.errors) ||
      !step.errors.every((rawIssue) => {
        const issue = record(rawIssue);
        return Boolean(
          issue &&
          exactKeys(issue, ["code", "path", "message"]) &&
          typeof issue.code === "string" &&
          typeof issue.path === "string" &&
          typeof issue.message === "string",
        );
      }) ||
      (step.completed_at !== null && !isIso(step.completed_at))
    )
      return null;
    seen.add(String(step.id));
  }
  return item as unknown as Phase4SetupDocument;
}

export function isAssistedSetupAutosaveRequest(value: unknown): value is Phase4SetupAutosaveRequest {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, ["expected_revision", "idempotency_key", "transition"]) ||
    !integer(item.expected_revision, 1) ||
    !isPhase4SetupIdempotencyKey(item.idempotency_key)
  )
    return false;
  const transition = record(item.transition);
  if (!transition || typeof transition.kind !== "string") return false;
  if (transition.kind === "go_to_step")
    return exactKeys(transition, ["kind", "step_id"]) && stepIds.has(transition.step_id as Phase4SetupStepId);
  if (transition.kind === "save_step")
    return exactKeys(transition, ["kind", "step"]) && isAssistedSetupStepValue(transition.step);
  return (
    transition.kind === "complete" &&
    exactKeys(transition, ["kind", "review"]) &&
    transition.review !== null &&
    isReviewPublish(transition.review)
  );
}

export function parseAssistedSetupAutosaveResponse(
  payload: unknown,
  competitionId: string,
): Phase4SetupAutosaveResponse | null {
  const item = record(payload);
  if (!item || typeof item.outcome !== "string") return null;
  if (!exactKeys(item, item.outcome === "conflict" ? ["outcome", "current"] : ["outcome", "document"])) return null;
  const documentValue = item.outcome === "conflict" ? item.current : item.document;
  const document = parseAssistedSetupDocument(documentValue, competitionId);
  if (!document) return null;
  if (item.outcome === "conflict") return { outcome: "conflict", current: document };
  if (!["saved", "idempotent_replay", "expired", "read_only", "idempotency_mismatch"].includes(item.outcome))
    return null;
  return { outcome: item.outcome, document } as Phase4SetupAutosaveResponse;
}

export function parseAssistedSetupCreateResponse(
  payload: unknown,
  competitionId: string,
): AssistedSetupCreateResponse | null {
  const item = record(payload);
  if (!item || !exactKeys(item, ["document", "idempotent_replay"]) || typeof item.idempotent_replay !== "boolean")
    return null;
  const document = parseAssistedSetupDocument(item.document, competitionId);
  return document ? { document, idempotent_replay: item.idempotent_replay } : null;
}

export function setupAutosaveBody(
  revision: number,
  transition: Phase4SetupAutosaveRequest["transition"],
): Phase4SetupAutosaveRequest {
  return { expected_revision: revision, idempotency_key: crypto.randomUUID(), transition };
}

export function stepValue<Step extends Phase4SetupStepId>(
  stepId: Step,
  value: NonNullable<Phase4SetupDocument["values"][Step]>,
): Phase4SetupStepValue {
  return { step_id: stepId, value } as Phase4SetupStepValue;
}
