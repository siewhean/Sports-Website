export const phase4ScheduleMachine = {
  section: "schedule",
  get: "GET",
  post: "POST",
  delete: "DELETE",
  ready: "ready",
  readOnly: "read-only",
  permission: "permission",
  offline: "offline",
  error: "error",
  loading: "loading",
  saved: "saved",
  unavailable: "unavailable",
  draft: "draft",
  readyForReview: "ready_for_review",
  expired: "expired",
  noStore: "no-store",
  json: "application/json",
  generateAction: "generate",
  continueAction: "continue",
  cancelAction: "cancel",
  acceptAction: "accept",
  publishAction: "publish",
  lockAction: "lock",
  generateKey: "schedule-generate",
  continueKey: "schedule-continue",
  cancelKey: "schedule-cancel",
  acceptKey: "schedule-accept",
  publishKey: "schedule-publish",
  lockKey: "schedule-lock",
  unlockKey: "schedule-unlock",
  moveKey: "schedule-move",
  queued: "queued",
  running: "running",
  best: "valid_best_found",
  cancelling: "cancelling",
  fastest: "fastest",
  balanced: "balanced",
  restFocused: "rest_focused",
  timeBalance: "time_balance",
  neutral: "neutral",
  locale: "en-CA",
  numeric: "numeric",
  twoDigit: "2-digit",
  year: "year",
  month: "month",
  day: "day",
  affectedMatchIds: "affected_match_ids",
  lockedMatchIds: "locked_match_ids",
  dependencyMatchIds: "dependency_match_ids",
  messages: "messages",
  validationError: "VALIDATION_ERROR",
  idempotencyKeyField: "idempotency_key",
  expectedRevisionField: "expected_revision",
  expectedJobRevisionField: "expected_job_revision",
  expectedSourceRevisionField: "expected_source_revision",
  expectedCapacityRevisionField: "expected_capacity_revision",
  objectiveField: "objective",
  constraintsField: "constraints",
  matchIdField: "match_id",
  playingAreaIdField: "playing_area_id",
  slotIdField: "slot_id",
  startEpochField: "start_epoch_ms",
  endEpochField: "end_epoch_ms",
} as const;

export type ScheduleSurfaceState =
  | "ready"
  | "read-only"
  | "permission"
  | "offline"
  | "error"
  | "loading"
  | "empty";

export type ScheduleObjective = "fastest" | "balanced" | "rest_focused";
export type ScheduleJobStatus =
  | "queued"
  | "running"
  | "valid_best_found"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "no_solution"
  | "stale";
export type ScheduleRevisionStatus = "draft" | "ready_for_review" | "published" | "superseded" | "expired";

export type QualityComponent = Readonly<{
  key: string;
  score: number;
  weight: number;
  measured: number;
  unit: "minutes" | "matches" | "areas" | "percent";
  explanation: string;
}>;

export type ScheduleQuality = Readonly<{
  score: number;
  objective: ScheduleObjective;
  valid: boolean;
  makespanMinutes: number;
  minimumRestMinutes: number | null;
  maximumMatchesPerEntryDay: number;
  preferredFinalDeltaMinutes: number | null;
  requiredViolationCount: number;
  preferredPenalty: number;
  components: readonly QualityComponent[];
}>;

export type ScheduleAssignment = Readonly<{
  matchId: string;
  divisionId: string;
  areaId: string;
  intervalId: string;
  slotId: string;
  startsAt: string;
  endsAt: string;
  fixed: boolean;
}>;

export type ScheduleViolation = Readonly<{
  code: string;
  severity: "hard" | "required" | "preferred";
  matchIds: readonly string[];
  message: string;
  amount: number | null;
}>;

export type ScheduleOption = Readonly<{
  id: string;
  jobId: string;
  resultRevision: number;
  objective: ScheduleObjective;
  quality: ScheduleQuality;
  assignments: readonly ScheduleAssignment[];
  violations: readonly ScheduleViolation[];
  assignmentHash: string;
  createdAt: string;
}>;

export type ScheduleJob = Readonly<{
  id: string;
  revision: number;
  status: ScheduleJobStatus;
  objective: ScheduleObjective;
  currentBest: ScheduleOption | null;
  cancellationRequestedAt: string | null;
  failureClass: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ScheduleArea = Readonly<{
  id: string;
  name: string;
  kind: string;
}>;

export type ScheduleSlot = Readonly<{
  id: string;
  intervalId: string;
  areaId: string;
  startsAt: string;
  endsAt: string;
  available: boolean;
  disabledReason: string | null;
}>;

export type ScheduleMatch = Readonly<{
  id: string;
  divisionId: string;
  divisionName: string;
  roundLabel: string;
  code: string;
  homeLabel: string;
  awayLabel: string;
  durationMinutes: number;
  dependencyMatchIds: readonly string[];
  status: "unscheduled" | "scheduled" | "conflict" | "complete";
}>;

export type ScheduleLock = Readonly<{
  matchId: string;
  areaId: string;
  startsAt: string;
  endsAt: string;
}>;

export type ScheduleWarning = Readonly<{
  code: "expires_soon" | "expires_tomorrow" | "expired" | "conflict" | "stale";
  message: string;
  daysRemaining: number | null;
}>;

export type ScheduleRevision = Readonly<{
  id: string;
  revision: number;
  parentRevisionId: string | null;
  status: ScheduleRevisionStatus;
  editableUntil: string | null;
  publishedAt: string | null;
  expiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  quality: ScheduleQuality | null;
  assignments: readonly ScheduleAssignment[];
  violations: readonly ScheduleViolation[];
}>;

export type ScheduleDocument = Readonly<{
  state: ScheduleSurfaceState;
  competitionId: string;
  competitionName: string;
  timeZone: string;
  publicationRevision: string;
  sourceRevision: number;
  capacityRevision: number;
  constraints: Readonly<Record<string, unknown>>;
  canEdit: boolean;
  canPublish: boolean;
  activeJob: ScheduleJob | null;
  currentRevision: ScheduleRevision | null;
  revisions: readonly ScheduleRevision[];
  alternatives: readonly ScheduleOption[];
  areas: readonly ScheduleArea[];
  slots: readonly ScheduleSlot[];
  matches: readonly ScheduleMatch[];
  locks: readonly ScheduleLock[];
  warnings: readonly ScheduleWarning[];
}>;

export type MoveSlot = Readonly<{
  slotId: string;
  areaId: string;
  startsAt: string;
  endsAt: string;
  available: boolean;
  disabledReason: string | null;
}>;

export type MoveConsequence = Readonly<{
  affectedMatchIds: readonly string[];
  lockedMatchIds: readonly string[];
  dependencyMatchIds: readonly string[];
  messages: readonly string[];
}>;

export type ScheduleMoveValidation = Readonly<{
  valid: boolean;
  violations: readonly ScheduleViolation[];
  consequences: MoveConsequence;
}>;

export const phase4ScheduleCopy = messages.phase4Schedule;

export function objectiveLabel(objective: ScheduleObjective): string {
  return objective === "rest_focused"
    ? phase4ScheduleCopy.restFocused
    : objective === "fastest"
      ? phase4ScheduleCopy.fastest
      : phase4ScheduleCopy.balanced;
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${String(remainder).padStart(2, "0")}m` : `${remainder} min`;
}

export function formatScheduleTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function formatScheduleDay(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

export function assignmentForMatch(
  revision: ScheduleRevision | null,
  matchId: string,
): ScheduleAssignment | null {
  return revision?.assignments.find((assignment) => assignment.matchId === matchId) ?? null;
}

export function lockForMatch(locks: readonly ScheduleLock[], matchId: string): ScheduleLock | null {
  return locks.find((lock) => lock.matchId === matchId) ?? null;
}

export function matchesForArea(
  document: ScheduleDocument,
  areaId: string,
): readonly Readonly<{ match: ScheduleMatch; assignment: ScheduleAssignment }>[] {
  if (!document.currentRevision) return [];
  return document.currentRevision.assignments
    .filter((assignment) => assignment.areaId === areaId)
    .map((assignment) => ({
      assignment,
      match: document.matches.find((match) => match.id === assignment.matchId),
    }))
    .filter(
      (value): value is Readonly<{ match: ScheduleMatch; assignment: ScheduleAssignment }> => Boolean(value.match),
    )
    .sort((left, right) => Date.parse(left.assignment.startsAt) - Date.parse(right.assignment.startsAt));
}

export function surfaceStateFromStatus(status: number): ScheduleSurfaceState {
  if (status === 401 || status === 403) return "permission";
  return status >= 500 ? "offline" : "error";
}

export function commandErrorMessage(status: number, code: string | null): string {
  if (status === 409 && code === "STALE_SCHEDULE_INPUT") return phase4ScheduleCopy.stale;
  if (status === 409) return phase4ScheduleCopy.conflict;
  if (status === 503 && code === "SCHEDULE_QUEUE_UNAVAILABLE") return phase4ScheduleCopy.queueUnavailable;
  if (status === 401 || status === 403) return phase4ScheduleCopy.permissionBody;
  return phase4ScheduleCopy.errorBody;
}

export function createIdempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function finite(value: unknown, minimum?: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && (minimum === undefined || value >= minimum);
}

function iso(value: unknown): value is string {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function nullableIso(value: unknown): value is string | null {
  return value === null || iso(value);
}

const jobStatuses = new Set<ScheduleJobStatus>([
  "queued", "running", "valid_best_found", "cancelling", "cancelled", "completed", "failed", "no_solution", "stale",
]);
const objectives = new Set<ScheduleObjective>(["fastest", "balanced", "rest_focused"]);
const revisionStatuses = new Set<ScheduleRevisionStatus>(["draft", "ready_for_review", "published", "superseded", "expired"]);

function parseQualityComponent(value: unknown): QualityComponent | null {
  const item = record(value);
  if (!item || !exact(item, ["key", "score", "weight", "measured", "unit", "explanation"]) || !nonEmpty(item.key) || !finite(item.score, 0) || item.score > 100 || !finite(item.weight, 0) || !finite(item.measured) || !["minutes", "matches", "areas", "percent"].includes(String(item.unit)) || !nonEmpty(item.explanation)) return null;
  return item as QualityComponent;
}

function parseQuality(value: unknown): ScheduleQuality | null {
  const item = record(value);
  if (!item || !exact(item, ["score", "objective", "valid", "makespan_minutes", "minimum_rest_minutes", "maximum_matches_per_entry_day", "preferred_final_delta_minutes", "required_violation_count", "preferred_penalty", "components"]) || !finite(item.score, 0) || item.score > 100 || !nonEmpty(item.objective) || !objectives.has(item.objective as ScheduleObjective) || typeof item.valid !== "boolean" || !finite(item.makespan_minutes, 0) || (item.minimum_rest_minutes !== null && !finite(item.minimum_rest_minutes, 0)) || !finite(item.maximum_matches_per_entry_day, 0) || (item.preferred_final_delta_minutes !== null && !finite(item.preferred_final_delta_minutes, 0)) || !finite(item.required_violation_count, 0) || !finite(item.preferred_penalty, 0) || !Array.isArray(item.components)) return null;
  const components = item.components.map(parseQualityComponent);
  if (components.some((component) => !component)) return null;
  return {
    score: item.score,
    objective: item.objective as ScheduleObjective,
    valid: item.valid,
    makespanMinutes: item.makespan_minutes,
    minimumRestMinutes: item.minimum_rest_minutes as number | null,
    maximumMatchesPerEntryDay: item.maximum_matches_per_entry_day,
    preferredFinalDeltaMinutes: item.preferred_final_delta_minutes as number | null,
    requiredViolationCount: item.required_violation_count,
    preferredPenalty: item.preferred_penalty,
    components: components as QualityComponent[],
  };
}

function parseAssignment(value: unknown): ScheduleAssignment | null {
  const item = record(value);
  if (!item || !exact(item, ["match_id", "division_id", "area_id", "interval_id", "slot_id", "start_epoch_ms", "end_epoch_ms", "fixed"]) || !nonEmpty(item.match_id) || !nonEmpty(item.division_id) || !nonEmpty(item.area_id) || !nonEmpty(item.interval_id) || !nonEmpty(item.slot_id) || !integer(item.start_epoch_ms, 1) || !integer(item.end_epoch_ms, 1) || item.end_epoch_ms <= item.start_epoch_ms || typeof item.fixed !== "boolean") return null;
  return { matchId: item.match_id, divisionId: item.division_id, areaId: item.area_id, intervalId: item.interval_id, slotId: item.slot_id, startsAt: new Date(item.start_epoch_ms).toISOString(), endsAt: new Date(item.end_epoch_ms).toISOString(), fixed: item.fixed };
}

function parseViolation(value: unknown): ScheduleViolation | null {
  const item = record(value);
  const keys = item && Object.prototype.hasOwnProperty.call(item, "amount") ? ["code", "severity", "match_ids", "message", "amount"] : ["code", "severity", "match_ids", "message"];
  if (!item || !exact(item, keys) || !nonEmpty(item.code) || !["hard", "required", "preferred"].includes(String(item.severity)) || !Array.isArray(item.match_ids) || !item.match_ids.every(nonEmpty) || !nonEmpty(item.message) || (item.amount !== undefined && !finite(item.amount))) return null;
  return { code: item.code, severity: item.severity as ScheduleViolation["severity"], matchIds: item.match_ids, message: item.message, amount: item.amount === undefined ? null : item.amount as number };
}

export function parseScheduleOptionView(value: unknown): ScheduleOption | null {
  const item = record(value);
  if (!item || !exact(item, ["id", "job_id", "result_revision", "solver_iteration", "result_status", "quality", "assignments", "violations", "assignment_hash", "created_at"]) || !nonEmpty(item.id) || !nonEmpty(item.job_id) || !integer(item.result_revision, 1) || !integer(item.solver_iteration) || !["valid", "infeasible"].includes(String(item.result_status)) || !nonEmpty(item.assignment_hash) || !iso(item.created_at) || !Array.isArray(item.assignments) || !Array.isArray(item.violations)) return null;
  const quality = parseQuality(item.quality);
  const assignments = item.assignments.map(parseAssignment);
  const violations = item.violations.map(parseViolation);
  if (!quality || assignments.some((assignment) => !assignment) || violations.some((violation) => !violation)) return null;
  return { id: item.id, jobId: item.job_id, resultRevision: item.result_revision, objective: quality.objective, quality, assignments: assignments as ScheduleAssignment[], violations: violations as ScheduleViolation[], assignmentHash: item.assignment_hash, createdAt: item.created_at };
}

export function parseScheduleJobView(value: unknown, allowReplay = false): ScheduleJob | null {
  const item = record(value);
  if (!item) return null;
  const keys = ["id", "competition_id", "revision", "source_revision", "capacity_revision", "capacity_hash", "status", "objective", "continued_from_job_id", "current_best_option_id", "current_best", "cancellation_requested_at", "started_at", "completed_at", "failure_class", "created_at", "updated_at", ...(allowReplay ? ["idempotent_replay"] : [])];
  if (!exact(item, keys) || !nonEmpty(item.id) || !nonEmpty(item.competition_id) || !integer(item.revision, 1) || !integer(item.source_revision, 1) || !integer(item.capacity_revision, 1) || !nonEmpty(item.capacity_hash) || !nonEmpty(item.status) || !jobStatuses.has(item.status as ScheduleJobStatus) || !nonEmpty(item.objective) || !objectives.has(item.objective as ScheduleObjective) || (item.continued_from_job_id !== null && !nonEmpty(item.continued_from_job_id)) || (item.current_best_option_id !== null && !nonEmpty(item.current_best_option_id)) || !nullableIso(item.cancellation_requested_at) || !nullableIso(item.started_at) || !nullableIso(item.completed_at) || (item.failure_class !== null && !nonEmpty(item.failure_class)) || !iso(item.created_at) || !iso(item.updated_at) || (allowReplay && typeof item.idempotent_replay !== "boolean")) return null;
  const currentBest = item.current_best === null ? null : parseScheduleOptionView(item.current_best);
  if (item.current_best !== null && !currentBest) return null;
  return { id: item.id, revision: item.revision, status: item.status as ScheduleJobStatus, objective: item.objective as ScheduleObjective, currentBest, cancellationRequestedAt: item.cancellation_requested_at, failureClass: item.failure_class as string | null, startedAt: item.started_at, completedAt: item.completed_at, createdAt: item.created_at, updatedAt: item.updated_at };
}

export function parseScheduleJobEnvelope(value: unknown): ScheduleJob | null {
  const item = record(value);
  if (!item || !exact(item, ["job", "enqueued", "recoverable", "idempotent_replay"]) || typeof item.enqueued !== "boolean" || typeof item.recoverable !== "boolean" || typeof item.idempotent_replay !== "boolean") return null;
  return parseScheduleJobView(item.job);
}

export function parseScheduleRevisionView(value: unknown, detail = false, allowReplay = false): ScheduleRevision | null {
  const item = record(value);
  if (!item) return null;
  const baseKeys = ["id", "competition_id", "revision", "parent_revision_id", "source_job_id", "source_option_id", "status", "editable_until", "published_at", "expired_at", "created_at", "updated_at"];
  const keys = detail ? [...baseKeys, "assignment_hash", "quality", "assignments", ...(allowReplay ? ["idempotent_replay"] : [])] : baseKeys;
  if (!exact(item, keys) || !nonEmpty(item.id) || !nonEmpty(item.competition_id) || !integer(item.revision, 1) || (item.parent_revision_id !== null && !nonEmpty(item.parent_revision_id)) || (item.source_job_id !== null && !nonEmpty(item.source_job_id)) || (item.source_option_id !== null && !nonEmpty(item.source_option_id)) || !nonEmpty(item.status) || !revisionStatuses.has(item.status as ScheduleRevisionStatus) || !nullableIso(item.editable_until) || !nullableIso(item.published_at) || !nullableIso(item.expired_at) || !iso(item.created_at) || !iso(item.updated_at) || (allowReplay && typeof item.idempotent_replay !== "boolean")) return null;
  let quality: ScheduleQuality | null = null;
  let assignments: ScheduleAssignment[] = [];
  if (detail) {
    if ((item.assignment_hash !== null && !nonEmpty(item.assignment_hash)) || !Array.isArray(item.assignments)) return null;
    quality = item.quality === null ? null : parseQuality(item.quality);
    assignments = item.assignments.map(parseAssignment).filter((assignment): assignment is ScheduleAssignment => Boolean(assignment));
    if ((item.quality !== null && !quality) || assignments.length !== item.assignments.length) return null;
  }
  return { id: item.id, revision: item.revision, parentRevisionId: item.parent_revision_id as string | null, status: item.status as ScheduleRevisionStatus, editableUntil: item.editable_until, publishedAt: item.published_at, expiredAt: item.expired_at, createdAt: item.created_at, updatedAt: item.updated_at, quality, assignments, violations: [] };
}

function isMoveSource(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
      exact(item, ["area_id", "slot_id", "start_epoch_ms", "end_epoch_ms"]) &&
      nonEmpty(item.area_id) &&
      nonEmpty(item.slot_id) &&
      integer(item.start_epoch_ms) &&
      integer(item.end_epoch_ms, 1) &&
      item.end_epoch_ms > item.start_epoch_ms,
  );
}

function isMoveTarget(value: unknown, movedMatchId: string): boolean {
  const item = record(value);
  return Boolean(
    item &&
      exact(item, ["match_id", "playing_area_id", "slot_id", "start_epoch_ms", "end_epoch_ms"]) &&
      item.match_id === movedMatchId &&
      nonEmpty(item.playing_area_id) &&
      nonEmpty(item.slot_id) &&
      integer(item.start_epoch_ms) &&
      integer(item.end_epoch_ms, 1) &&
      item.end_epoch_ms > item.start_epoch_ms,
  );
}

function parseMoveConsequences(value: unknown): MoveConsequence | null {
  const consequences = record(value);
  if (!consequences || !exact(consequences, ["moved_match_id", "from", "to", "affected_match_ids", "dependency_match_ids", "locked_match_ids", "messages", "quality"]) || !nonEmpty(consequences.moved_match_id) || !isMoveSource(consequences.from) || !isMoveTarget(consequences.to, consequences.moved_match_id)) return null;
  for (const key of ["affected_match_ids", "dependency_match_ids", "locked_match_ids", "messages"] as const) if (!Array.isArray(consequences[key]) || !(consequences[key] as unknown[]).every(nonEmpty)) return null;
  if (consequences.quality !== null && !parseQuality(consequences.quality)) return null;
  return {
    affectedMatchIds: consequences.affected_match_ids as string[],
    dependencyMatchIds: consequences.dependency_match_ids as string[],
    lockedMatchIds: consequences.locked_match_ids as string[],
    messages: consequences.messages as string[],
  };
}

export function parseScheduleMoveValidation(value: unknown): ScheduleMoveValidation | null {
  const item = record(value);
  if (!item || !exact(item, ["validation", "consequences", "assignments"]) || !Array.isArray(item.assignments) || item.assignments.some((assignment) => !parseAssignment(assignment))) return null;
  const validation = record(item.validation);
  if (!validation || !exact(validation, ["valid", "violations"]) || typeof validation.valid !== "boolean" || !Array.isArray(validation.violations)) return null;
  const violations = validation.violations.map(parseViolation);
  const consequences = parseMoveConsequences(item.consequences);
  if (!consequences || violations.some((violation) => !violation)) return null;
  return { valid: validation.valid, violations: violations as ScheduleViolation[], consequences };
}

export function isScheduleMoveValidation(value: unknown): boolean {
  return parseScheduleMoveValidation(value) !== null;
}

export function isScheduleMoveResponse(value: unknown): boolean {
  const item = record(value);
  if (!item || !Object.prototype.hasOwnProperty.call(item, "consequences")) return false;
  const { consequences, ...revision } = item;
  return parseScheduleRevisionView(revision, true, true) !== null && parseMoveConsequences(consequences) !== null;
}

export function isScheduleLockResponse(value: unknown): boolean {
  const item = record(value);
  return Boolean(item && exact(item, ["id", "match_id", "source_schedule_revision_id", "playing_area_id", "start_epoch_ms", "end_epoch_ms", "locked_by", "created_at", "idempotent_replay"]) && nonEmpty(item.id) && nonEmpty(item.match_id) && (item.source_schedule_revision_id === null || nonEmpty(item.source_schedule_revision_id)) && nonEmpty(item.playing_area_id) && integer(item.start_epoch_ms, 1) && integer(item.end_epoch_ms, 1) && item.end_epoch_ms > item.start_epoch_ms && nonEmpty(item.locked_by) && iso(item.created_at) && typeof item.idempotent_replay === "boolean");
}

export function isScheduleUnlockResponse(value: unknown): boolean {
  const item = record(value);
  return Boolean(item && exact(item, ["match_id", "unlocked", "idempotent_replay"]) && nonEmpty(item.match_id) && item.unlocked === true && typeof item.idempotent_replay === "boolean");
}
import { messages } from "@matchday/ui";
