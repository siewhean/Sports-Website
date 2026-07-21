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
  | "quota"
  | "plan";

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

function hasSetupValues(value: unknown): boolean {
  const item = record(value);
  const keys = [
    "basics",
    "capacity",
    "settings",
    "entries",
    "format_preferences",
    "format_recommendations",
    "schedule_review",
    "review_publish",
  ];
  return Boolean(item && Object.keys(item).sort().join(",") === keys.sort().join(","));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function isPhase4SetupIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,200}$/.test(value);
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
      !Array.isArray(step.errors) ||
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
  if (transition.kind === "save_step") {
    const step = record(transition.step);
    return Boolean(
      exactKeys(transition, ["kind", "step"]) &&
        step &&
        exactKeys(step, ["step_id", "value"]) &&
        stepIds.has(step.step_id as Phase4SetupStepId),
    );
  }
  return (
    transition.kind === "complete" &&
    exactKeys(transition, ["kind", "review"]) &&
    record(transition.review) !== null
  );
}

export function parseAssistedSetupAutosaveResponse(
  payload: unknown,
  competitionId: string,
): Phase4SetupAutosaveResponse | null {
  const item = record(payload);
  if (!item || typeof item.outcome !== "string") return null;
  if (!exactKeys(item, item.outcome === "conflict" ? ["outcome", "current"] : ["outcome", "document"]))
    return null;
  const documentValue = item.outcome === "conflict" ? item.current : item.document;
  const document = parseAssistedSetupDocument(documentValue, competitionId);
  if (!document) return null;
  if (item.outcome === "conflict") return { outcome: "conflict", current: document };
  if (!["saved", "idempotent_replay", "expired", "read_only", "idempotency_mismatch"].includes(item.outcome))
    return null;
  return { outcome: item.outcome, document } as Phase4SetupAutosaveResponse;
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
