import type { Phase4PatchableSetupStep, Phase4SetupPatchRequest } from "@matchday/contracts";
import { isAssistedSetupStepValue, isPhase4SetupIdempotencyKey } from "./phase4-assisted-setup";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function isAssistedSetupPatchRequest(value: unknown): value is Phase4SetupPatchRequest {
  const item = record(value);
  if (
    !item ||
    !exact(item, ["expected_revision", "idempotency_key", "step"]) ||
    !Number.isSafeInteger(item.expected_revision) ||
    Number(item.expected_revision) < 1 ||
    !isPhase4SetupIdempotencyKey(item.idempotency_key)
  )
    return false;
  return Boolean(
    isAssistedSetupStepValue(item.step) &&
    (item.step.step_id === "basics" || item.step.step_id === "format_preferences"),
  );
}

export function setupPatchBody(
  revision: number,
  step: Phase4PatchableSetupStep,
  idempotencyKey = crypto.randomUUID(),
): Phase4SetupPatchRequest {
  return { expected_revision: revision, idempotency_key: idempotencyKey, step };
}
