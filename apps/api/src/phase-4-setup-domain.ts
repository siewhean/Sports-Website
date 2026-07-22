import type { Phase4SetupDocument, Phase4SetupStepId, Phase4SetupValues } from "@matchday/contracts";
import { deriveAssistedSetupProgress, type AssistedSetupStepValues } from "@matchday/domain";

type JsonObject = Record<string, unknown>;

export type Phase4SetupStorageRow = {
  id: string;
  schema_version: 1;
  organisation_id: string;
  competition_id: string;
  revision: number;
  status: "active" | "completed" | "expired";
  current_step: Phase4SetupStepId;
  completed_steps: Phase4SetupStepId[] | string;
  steps: JsonObject | string;
  validation: JsonObject | string;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
  completed_at: Date | string | null;
  competition_status: string;
};

export function decodePhase4Json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function instant(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function emptyPhase4SetupValues(): Phase4SetupValues {
  return {
    basics: null,
    capacity: null,
    settings: null,
    entries: null,
    format_preferences: null,
    format_recommendations: null,
    schedule_review: null,
    review_publish: null,
  };
}

export function phase4SetupValuesFromStorage(row: Pick<Phase4SetupStorageRow, "steps">): Phase4SetupValues {
  return { ...emptyPhase4SetupValues(), ...decodePhase4Json<JsonObject>(row.steps) } as Phase4SetupValues;
}

export function phase4SetupDomainValues(values: Phase4SetupValues): AssistedSetupStepValues {
  return {
    basics: values.basics
      ? {
          name: values.basics.name,
          sportCode: values.basics.sport_code,
          venue: values.basics.location.venue,
          address: values.basics.location.address,
          locality: values.basics.location.locality,
          countryCode: values.basics.location.country_code,
          startsOn: values.basics.starts_on,
          endsOn: values.basics.ends_on,
          timeZone: values.basics.time_zone,
          locale: values.basics.locale,
          entryCount: values.basics.entry_count,
          divisionCount: values.basics.division_count,
          entryCountStatus: values.basics.entry_count_status,
        }
      : null,
    capacity: values.capacity
      ? {
          kind: values.capacity.kind,
          competitionId: values.capacity.competition_id,
          revision: values.capacity.revision,
          timeZone: values.capacity.time_zone,
          areaIds: values.capacity.area_ids,
          sourceHash: values.capacity.source_hash,
          availableMatchSlots: values.capacity.effective.availableMatchSlots,
        }
      : null,
    settings:
      values.settings?.map((value) => ({
        scope: value.scope,
        competitionId: value.competition_id,
        divisionId: value.division_id,
        revision: value.settings_revision,
        mode: value.mode,
        packSchemaVersion: value.pack_schema_version,
        packVersion: value.pack_version,
        definitionHash: value.pack_definition_hash,
      })) ?? null,
    entries: values.entries
      ? {
          competitionId: values.entries.competition_id,
          totalEntryCount: values.entries.total_entry_count,
          divisions: values.entries.divisions.map((value) => ({
            divisionId: value.division_id,
            divisionRevision: value.division_revision,
            entryIds: value.entry_ids,
            confirmedCount: value.confirmed_count,
            placeholderCount: value.placeholder_count,
          })),
          imports: values.entries.imports.map((value) => ({
            importId: value.import_id,
            status: value.status,
            acceptedRowCount: value.accepted_row_count,
            rejectedRowCount: value.rejected_row_count,
          })),
        }
      : null,
    format_preferences: values.format_preferences
      ? {
          minimumMatchesPerEntry: values.format_preferences.minimum_matches.per_entry,
          rankAllEntries: values.format_preferences.ranking.rank_all_entries,
          knockoutRequired: values.format_preferences.knockout.required,
          placementRequired: values.format_preferences.placement.required,
          crossGroupAllowed: values.format_preferences.qualification.cross_group_allowed,
          priority: values.format_preferences.priority.value,
        }
      : null,
    format_recommendations: values.format_recommendations
      ? {
          recommendations: values.format_recommendations.recommendations.map((value) => ({
            id: value.id,
            formatRevisionId: value.format_revision_id,
            definitionHash: value.format_definition_hash,
            name: value.name,
            structure: value.structure,
            advantage: value.advantage,
            matchCount: value.match_count,
            minimumMatchesPerEntry: value.minimum_matches_per_entry,
            capacityStatus: value.capacity_status,
            schedulingStatus: value.scheduling_status,
            warningCodes: value.warning_codes,
          })),
          requiresChanges: values.format_recommendations.requires_changes
            ? {
                id: values.format_recommendations.requires_changes.id,
                formatRevisionId: values.format_recommendations.requires_changes.format_revision_id,
                definitionHash: values.format_recommendations.requires_changes.format_definition_hash,
                name: values.format_recommendations.requires_changes.name,
                structure: values.format_recommendations.requires_changes.structure,
                advantage: values.format_recommendations.requires_changes.advantage,
                matchCount: values.format_recommendations.requires_changes.match_count,
                minimumMatchesPerEntry: values.format_recommendations.requires_changes.minimum_matches_per_entry,
                capacityStatus: values.format_recommendations.requires_changes.capacity_status,
                schedulingStatus: values.format_recommendations.requires_changes.scheduling_status,
                warningCodes: values.format_recommendations.requires_changes.warning_codes,
              }
            : null,
          selectedRecommendationId: values.format_recommendations.selected_recommendation_id,
          acknowledgedCapacityShortfall: values.format_recommendations.acknowledged_capacity_shortfall,
          recommendationSetHash: values.format_recommendations.recommendation_set_hash,
        }
      : null,
    schedule_review: values.schedule_review
      ? {
          scheduleJobId: values.schedule_review.schedule_job_id,
          sourceRevision: values.schedule_review.source_revision,
          selectedRecommendationId: values.schedule_review.selected_recommendation_id,
          formatRevisionId: values.schedule_review.format_revision_id,
          formatDefinitionHash: values.schedule_review.format_definition_hash,
          capacityRevision: values.schedule_review.capacity_revision,
          settingsReferences: values.schedule_review.settings_references.map((value) => ({
            scope: value.scope,
            divisionId: value.division_id,
            revision: value.settings_revision,
            definitionHash: value.pack_definition_hash,
          })),
          selectedResultRevision: values.schedule_review.selected_result_revision,
          selectedResultHash: values.schedule_review.selected_result_hash,
          objective: values.schedule_review.objective,
          scheduleRevisionId: values.schedule_review.schedule_revision_id,
          feasibility: values.schedule_review.feasibility,
        }
      : null,
    review_publish: values.review_publish
      ? {
          selectedFormatRevisionId: values.review_publish.selected_format_revision_id,
          selectedScheduleResultHash: values.review_publish.selected_schedule_result_hash,
          capacityRevision: values.review_publish.capacity_revision,
          settingsReferences: values.review_publish.settings_references.map((value) => ({
            scope: value.scope,
            divisionId: value.division_id,
            revision: value.settings_revision,
            definitionHash: value.pack_definition_hash,
          })),
          acknowledgedWarningCodes: values.review_publish.acknowledged_warning_codes,
          publicationStatus: values.review_publish.publication_status,
          publishedScheduleRevisionId: values.review_publish.published_schedule_revision_id,
        }
      : null,
  };
}

export function phase4SetupDocumentFromStorage(row: Phase4SetupStorageRow): Phase4SetupDocument {
  const values = phase4SetupValuesFromStorage(row);
  const progress = deriveAssistedSetupProgress(phase4SetupDomainValues(values));
  const validation = decodePhase4Json<JsonObject>(row.validation);
  const completedAt = (validation.completed_at_by_step ?? {}) as Record<string, string>;
  const readOnly = row.status !== "active" || row.competition_status === "archived";
  return {
    schema_version: 1,
    id: row.id,
    organisation_id: row.organisation_id,
    competition_id: row.competition_id,
    competition_status: (row.competition_status === "active"
      ? "live"
      : row.competition_status) as Phase4SetupDocument["competition_status"],
    revision: row.revision,
    status: row.status,
    current_step: row.current_step,
    completed_steps: decodePhase4Json<Phase4SetupStepId[]>(row.completed_steps),
    steps: progress.steps.map((step) => ({
      id: step.id,
      status: step.id === row.current_step && step.status === "not_started" ? "current" : step.status,
      prerequisite_step_ids: step.prerequisiteStepIds,
      errors: step.errors,
      completed_at: completedAt[step.id] ?? null,
    })),
    values,
    permission: readOnly ? "read" : "write",
    read_only: readOnly,
    autosave: {
      status: readOnly ? (row.status === "expired" ? "expired" : "read_only") : "saved",
      last_saved_at: instant(row.updated_at),
      expires_at: instant(row.expires_at)!,
    },
    created_at: instant(row.created_at)!,
    updated_at: instant(row.updated_at)!,
    completed_at: instant(row.completed_at),
  };
}
