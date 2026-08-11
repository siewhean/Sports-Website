import type { Phase4SetupDocument } from "@matchday/contracts";
import { parseAssistedSetupDocument } from "./phase4-assisted-setup";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

export function parseV1FormatRecommendations(value: unknown, competitionId: string): Phase4SetupDocument | null {
  return parseAssistedSetupDocument(value, competitionId);
}

export function parseV1FormatApplication(
  value: unknown,
  competitionId: string,
): {
  document: Phase4SetupDocument;
  materialised: readonly { revision: { revision_id: string }; materialised: true }[];
} | null {
  const item = record(value);
  const document = parseAssistedSetupDocument(item?.document, competitionId);
  if (!document || !Array.isArray(item?.materialised)) return null;
  const materialised = item.materialised.map((raw) => {
    const entry = record(raw);
    const revision = record(entry?.revision);
    return entry?.materialised === true && typeof revision?.revision_id === "string"
      ? { revision: { revision_id: revision.revision_id }, materialised: true as const }
      : null;
  });
  return materialised.every((entry): entry is NonNullable<typeof entry> => entry !== null)
    ? { document, materialised }
    : null;
}

export function fittingV1Recommendations(document: Phase4SetupDocument) {
  const recommendations = document.values.format_recommendations;
  if (!recommendations) return [];
  return recommendations.recommendations.filter(
    (candidate) =>
      candidate.capacity_status !== "requires_changes" &&
      candidate.match_count <= candidate.available_match_slots &&
      candidate.scheduling_status !== "infeasible",
  );
}

export function hasAppliedV1Format(document: Phase4SetupDocument | null | undefined): boolean {
  const selectedId = document?.values.format_recommendations?.selected_recommendation_id;
  if (!selectedId) return false;
  const selected = document.values.format_recommendations?.recommendations.find(
    (candidate) => candidate.id === selectedId,
  );
  return Boolean(
    selected &&
    selected.division_formats.length > 0 &&
    selected.division_formats.every((format) => format.format_revision_id),
  );
}

export function hasMaterialisedV1Format(
  document: Phase4SetupDocument | null | undefined,
  divisions: readonly {
    divisionId: string;
    revisions: readonly { revisionId: string; materialised: boolean }[];
  }[],
): boolean {
  const selectedId = document?.values.format_recommendations?.selected_recommendation_id;
  const selected = selectedId
    ? document.values.format_recommendations?.recommendations.find((candidate) => candidate.id === selectedId)
    : null;
  if (!selected || selected.division_formats.length !== divisions.length) return false;
  const statusByDivision = new Map(divisions.map((division) => [division.divisionId, division]));
  return selected.division_formats.every((format) => {
    const status = statusByDivision.get(format.division_id);
    return Boolean(
      status?.revisions.some((revision) => revision.revisionId === format.format_revision_id && revision.materialised),
    );
  });
}

export function v1FormatScreenState(advancedRequested: boolean, hasAppliedFormat: boolean) {
  if (advancedRequested) return "advanced" as const;
  return hasAppliedFormat ? ("selected" as const) : ("picker" as const);
}
