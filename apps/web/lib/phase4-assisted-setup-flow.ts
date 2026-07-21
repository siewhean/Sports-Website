import type {
  Phase4PatchableSetupStep,
  Phase4SetupAutosaveResponse,
  Phase4SetupBasics,
  Phase4SetupDocument,
  Phase4SetupFormatPreferences,
  Phase4SetupStepId,
  Phase4SetupStepValue,
} from "@matchday/contracts";

export const editableSetupSteps = new Set<Phase4SetupStepId>(["basics", "format_preferences"]);

export const launchSportLabels = {
  canoe_polo: "Canoe Polo",
  badminton: "Badminton",
  table_tennis: "Table Tennis",
  volleyball: "Volleyball",
  basketball: "Basketball",
} as const;

export function setupSportLabel(sportCode: string): string {
  return launchSportLabels[sportCode as keyof typeof launchSportLabels] ?? sportCode.replaceAll("_", " ");
}

export function setupMutationDocument(response: Phase4SetupAutosaveResponse): Phase4SetupDocument {
  return response.outcome === "conflict" ? response.current : response.document;
}

export function setupMutationSucceeded(response: Phase4SetupAutosaveResponse): boolean {
  return response.outcome === "saved" || response.outcome === "idempotent_replay";
}

export function setupValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function basicsReadyToPersist(value: Phase4SetupBasics): boolean {
  return Boolean(
    value.name.trim() &&
      value.location.venue.trim() &&
      value.location.address.trim() &&
      /^[A-Z]{2}$/.test(value.location.country_code) &&
      value.starts_on &&
      value.ends_on &&
      value.ends_on >= value.starts_on &&
      value.time_zone.trim() &&
      value.locale.trim() &&
      Number.isSafeInteger(value.entry_count) &&
      value.entry_count >= 1 &&
      Number.isSafeInteger(value.division_count) &&
      value.division_count >= 1,
  );
}

export function preferencesReadyToPersist(value: Phase4SetupFormatPreferences): boolean {
  return Number.isSafeInteger(value.minimum_matches.per_entry) && value.minimum_matches.per_entry >= 1;
}

export function patchableSetupStep(
  stepId: Phase4SetupStepId,
  basics: Phase4SetupBasics | null,
  preferences: Phase4SetupFormatPreferences | null,
): Phase4PatchableSetupStep | null {
  if (stepId === "basics" && basics && basicsReadyToPersist(basics)) {
    return { step_id: "basics", value: basics };
  }
  if (stepId === "format_preferences" && preferences && preferencesReadyToPersist(preferences)) {
    return { step_id: "format_preferences", value: preferences };
  }
  return null;
}

export function setupStepForSave(
  setup: Phase4SetupDocument,
  basics: Phase4SetupBasics | null,
  preferences: Phase4SetupFormatPreferences | null,
): Phase4SetupStepValue | null {
  const editable = patchableSetupStep(setup.current_step, basics, preferences);
  if (editable) return editable;
  const value = setup.values[setup.current_step];
  return value ? ({ step_id: setup.current_step, value } as Phase4SetupStepValue) : null;
}
