import type { Phase4SetupAutosaveResponse, Phase4SetupStepValue } from "./phase-4-setup.js";

export type Phase4PatchableSetupStepId = "basics" | "format_preferences";

export type Phase4PatchableSetupStep = Extract<Phase4SetupStepValue, { readonly step_id: Phase4PatchableSetupStepId }>;

/**
 * A patch persists the current editable step without changing current_step.
 * Save-and-advance remains a separate transition and a separate idempotency
 * operation.
 */
export type Phase4SetupPatchRequest = {
  readonly expected_revision: number;
  readonly idempotency_key: string;
  readonly step: Phase4PatchableSetupStep;
};

export type Phase4SetupPatchResponse = Extract<
  Phase4SetupAutosaveResponse,
  { readonly outcome: "saved" | "idempotent_replay" | "conflict" | "expired" | "read_only" | "idempotency_mismatch" }
>;
