import type {
  Phase4SetupAutosaveRequest,
  Phase4SetupAutosaveResponse,
  Phase4SetupDocument,
  Phase4SetupRecommendation,
  Phase4SetupRecommendationSelection,
  Phase4SetupStepValue,
} from "@matchday/contracts";
import {
  assistedSetupSteps,
  isAssistedSetupAutosaveRequest as legacyIsAssistedSetupAutosaveRequest,
  isAssistedSetupStepValue as legacyIsAssistedSetupStepValue,
  isPhase4SetupIdempotencyKey,
  parseAssistedSetupDocument as legacyParseAssistedSetupDocument,
} from "./phase4-assisted-setup";

export {
  assistedSetupSteps,
  isPhase4SetupIdempotencyKey,
  phase4SetupCopy,
  setupAutosaveBody,
  stepValue,
} from "./phase4-assisted-setup";
export type {
  AssistedSetupCreateResponse,
  AssistedSetupPageDocument,
  AssistedSetupSurfaceState,
} from "./phase4-assisted-setup";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function rankingCoverage(value: unknown): value is Phase4SetupRecommendation["ranking_coverage"] {
  return value === "all_entries" || value === "podium" || value === "champion";
}

function currentDivisionFormat(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
      exactKeys(item, [
        "division_id",
        "candidate_division_id",
        "format_revision_id",
        "format_definition_hash",
        "match_count",
        "guaranteed_matches",
        "ranking_coverage",
      ]) &&
      typeof item.division_id === "string" &&
      typeof item.candidate_division_id === "string" &&
      nullableString(item.format_revision_id) &&
      typeof item.format_definition_hash === "string" &&
      integer(item.match_count) &&
      integer(item.guaranteed_matches) &&
      rankingCoverage(item.ranking_coverage),
  );
}

function currentRecommendation(value: unknown): value is Phase4SetupRecommendation {
  const item = record(value);
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
      typeof item.id === "string" &&
      nullableString(item.format_revision_id) &&
      typeof item.format_definition_hash === "string" &&
      typeof item.name === "string" &&
      typeof item.structure === "string" &&
      typeof item.advantage === "string" &&
      integer(item.match_count) &&
      integer(item.minimum_matches_per_entry) &&
      integer(item.guaranteed_matches) &&
      rankingCoverage(item.ranking_coverage) &&
      integer(item.available_match_slots) &&
      Array.isArray(item.division_formats) &&
      item.division_formats.length > 0 &&
      item.division_formats.every(currentDivisionFormat) &&
      ["fits", "tight", "requires_changes"].includes(String(item.capacity_status)) &&
      ["feasible", "infeasible", "not_checked"].includes(String(item.scheduling_status)) &&
      Array.isArray(item.warning_codes) &&
      item.warning_codes.every((warning) => typeof warning === "string"),
  );
}

function currentRecommendations(value: unknown): value is Phase4SetupRecommendationSelection {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, [
      "recommendations",
      "requires_changes",
      "selected_recommendation_id",
      "acknowledged_capacity_shortfall",
      "recommendation_set_hash",
    ]) ||
    !Array.isArray(item.recommendations) ||
    item.recommendations.length < 1 ||
    item.recommendations.length > 3 ||
    !item.recommendations.every(currentRecommendation) ||
    (item.requires_changes !== null && !currentRecommendation(item.requires_changes)) ||
    !nullableString(item.selected_recommendation_id) ||
    typeof item.acknowledged_capacity_shortfall !== "boolean" ||
    typeof item.recommendation_set_hash !== "string"
  )
    return false;

  if (item.selected_recommendation_id === null) return true;
  const candidates = [
    ...item.recommendations,
    ...(item.requires_changes === null ? [] : [item.requires_changes]),
  ] as Phase4SetupRecommendation[];
  const selected = candidates.find((candidate) => candidate.id === item.selected_recommendation_id);
  return Boolean(
    selected &&
      selected.format_revision_id &&
      selected.division_formats.every((division) => division.format_revision_id !== null) &&
      (selected.capacity_status !== "requires_changes" || item.acknowledged_capacity_shortfall),
  );
}

function legacyRecommendation(value: Phase4SetupRecommendation) {
  return {
    id: value.id,
    format_revision_id: value.format_revision_id ?? "unselected",
    format_definition_hash: value.format_definition_hash,
    name: value.name,
    structure: value.structure,
    advantage: value.advantage,
    match_count: value.match_count,
    minimum_matches_per_entry: value.minimum_matches_per_entry,
    capacity_status: value.capacity_status,
    scheduling_status: value.scheduling_status,
    warning_codes: value.warning_codes,
  };
}

function normalizedDocument(payload: unknown): unknown | null {
  const item = record(payload);
  const values = item ? record(item.values) : null;
  if (!item || !values) return null;
  if (values.format_recommendations === null) return payload;
  if (!currentRecommendations(values.format_recommendations)) return null;
  const selection = values.format_recommendations;
  return {
    ...item,
    values: {
      ...values,
      format_recommendations: {
        recommendations: selection.recommendations.map(legacyRecommendation),
        requires_changes: selection.requires_changes ? legacyRecommendation(selection.requires_changes) : null,
        selected_recommendation_id: selection.selected_recommendation_id,
        acknowledged_capacity_shortfall: selection.acknowledged_capacity_shortfall,
        recommendation_set_hash: selection.recommendation_set_hash,
      },
    },
  };
}

export function parseAssistedSetupDocument(payload: unknown, competitionId: string): Phase4SetupDocument | null {
  const normalized = normalizedDocument(payload);
  if (!normalized || !legacyParseAssistedSetupDocument(normalized, competitionId)) return null;
  return payload as Phase4SetupDocument;
}

export function isAssistedSetupStepValue(value: unknown): value is Phase4SetupStepValue {
  const item = record(value);
  if (item?.step_id !== "format_recommendations") return legacyIsAssistedSetupStepValue(value);
  return exactKeys(item, ["step_id", "value"]) && currentRecommendations(item.value);
}

export function isAssistedSetupAutosaveRequest(value: unknown): value is Phase4SetupAutosaveRequest {
  const item = record(value);
  const transition = item ? record(item.transition) : null;
  if (transition?.kind !== "save_step") return legacyIsAssistedSetupAutosaveRequest(value);
  const step = record(transition.step);
  if (step?.step_id !== "format_recommendations") return legacyIsAssistedSetupAutosaveRequest(value);
  return Boolean(
    item &&
      exactKeys(item, ["expected_revision", "idempotency_key", "transition"]) &&
      integer(item.expected_revision, 1) &&
      isPhase4SetupIdempotencyKey(item.idempotency_key) &&
      exactKeys(transition, ["kind", "step"]) &&
      isAssistedSetupStepValue(transition.step),
  );
}

export function parseAssistedSetupAutosaveResponse(
  payload: unknown,
  competitionId: string,
): Phase4SetupAutosaveResponse | null {
  const item = record(payload);
  if (!item || typeof item.outcome !== "string") return null;
  const conflict = item.outcome === "conflict";
  if (!exactKeys(item, conflict ? ["outcome", "current"] : ["outcome", "document"])) return null;
  const document = parseAssistedSetupDocument(conflict ? item.current : item.document, competitionId);
  if (!document) return null;
  if (conflict) return { outcome: "conflict", current: document };
  if (!["saved", "idempotent_replay", "expired", "read_only", "idempotency_mismatch"].includes(item.outcome)) {
    return null;
  }
  return { outcome: item.outcome, document } as Phase4SetupAutosaveResponse;
}

export function parseAssistedSetupCreateResponse(
  payload: unknown,
  competitionId: string,
): Readonly<{ document: Phase4SetupDocument; idempotent_replay: boolean }> | null {
  const item = record(payload);
  if (!item || !exactKeys(item, ["document", "idempotent_replay"]) || typeof item.idempotent_replay !== "boolean") {
    return null;
  }
  const document = parseAssistedSetupDocument(item.document, competitionId);
  return document ? { document, idempotent_replay: item.idempotent_replay } : null;
}

export const currentAssistedSetupSteps = assistedSetupSteps;
