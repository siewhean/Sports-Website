/** Transport-safe Phase 4 scheduling contracts. All instants are epoch milliseconds. */
export type ScheduleConstraintMode = "required" | "preferred" | "ignored";

export type ScheduleObjective = "fastest" | "balanced" | "rest_focused";

/** These rules are intrinsic and intentionally have no configurable mode. */
export const intrinsicScheduleHardConstraints = [
  "entry_overlap",
  "playing_area_overlap",
  "dependency_order",
  "playing_area_availability",
  "fixed_match_immutability",
  "official_overlap",
  "full_slot_occupancy",
] as const;
export type IntrinsicScheduleHardConstraint = (typeof intrinsicScheduleHardConstraints)[number];

export type ScheduleConstraintSetting<T> = {
  mode: ScheduleConstraintMode;
  value: T;
  /** Positive integer used only when mode is preferred. */
  weight?: number;
};

export type ScheduleInterval = {
  start_epoch_ms: number;
  end_epoch_ms: number;
};

export type ScheduleConstraints = {
  minimum_rest: ScheduleConstraintSetting<{ minutes: number }>;
  maximum_matches_per_day: ScheduleConstraintSetting<{ matches: number }>;
  preferred_final_time: ScheduleConstraintSetting<{
    target_start_epoch_ms: number;
    tolerance_minutes: number;
  }>;
  entry_unavailable: ScheduleConstraintSetting<{
    by_entry_id: Record<string, readonly ScheduleInterval[]>;
  }>;
  official_availability: ScheduleConstraintSetting<{
    by_official_id: Record<string, readonly ScheduleInterval[]>;
  }>;
  featured_playing_area: ScheduleConstraintSetting<{
    area_id: string;
    match_ids: readonly string[];
  }>;
  avoid_consecutive_matches: ScheduleConstraintSetting<{ minutes: number }>;
  balance_early_matches: ScheduleConstraintSetting<{ before_local_time: string }>;
  balance_late_matches: ScheduleConstraintSetting<{ at_or_after_local_time: string }>;
  keep_division_together: ScheduleConstraintSetting<{ maximum_area_count: number }>;
  preserve_existing_schedule: ScheduleConstraintSetting<{
    maximum_shift_minutes: number;
    by_match_id: Record<
      string,
      {
        area_id: string;
        start_epoch_ms: number;
      }
    >;
  }>;
};

export type ScheduleWorkerMatch = {
  match_id: string;
  division_id: string;
  duration_minutes: number;
  dependency_match_ids: readonly string[];
  /** Conservative set propagated through every unresolved advancement path. */
  possible_entry_ids: readonly string[];
  official_ids: readonly string[];
  is_championship_final: boolean;
  fixed_assignment?: {
    reason: "locked" | "published_history";
    area_id: string;
    slot_id: string;
    start_epoch_ms: number;
    end_epoch_ms: number;
  };
};

export type ScheduleWorkerSlot = {
  slot_id: string;
  interval_id: string;
  area_id: string;
  start_epoch_ms: number;
  end_epoch_ms: number;
};

export type ScheduleAssignment = {
  match_id: string;
  division_id: string;
  area_id: string;
  interval_id: string;
  slot_id: string;
  start_epoch_ms: number;
  end_epoch_ms: number;
  fixed: boolean;
};

export type ScheduleViolationCode =
  | "unknown_match"
  | "missing_match"
  | "duplicate_assignment"
  | "assignment_mismatch"
  | "unknown_slot"
  | "slot_mismatch"
  | "slot_duration"
  | "area_overlap"
  | "possible_entry_overlap"
  | "official_overlap"
  | "dependency_order"
  | "fixed_match_moved"
  | "minimum_rest"
  | "maximum_matches_per_day"
  | "entry_unavailable"
  | "official_unavailable"
  | "preferred_final_time"
  | "featured_playing_area"
  | "consecutive_matches"
  | "early_match_balance"
  | "late_match_balance"
  | "division_area_spread"
  | "existing_schedule_moved";

export type ScheduleViolation = {
  code: ScheduleViolationCode;
  severity: "hard" | "required" | "preferred";
  match_ids: readonly string[];
  message: string;
  amount?: number;
};

export type ScheduleQualityComponent = {
  key:
    | "completion"
    | "rest"
    | "daily_balance"
    | "preferred_final"
    | "featured_area"
    | "consecutive"
    | "time_balance"
    | "division_cohesion"
    | "schedule_preservation"
    | "entry_availability"
    | "official_availability";
  score: number;
  weight: number;
  measured: number;
  unit: "minutes" | "matches" | "areas" | "percent";
  explanation: string;
};

export type ScheduleQuality = {
  score: number;
  objective: ScheduleObjective;
  valid: boolean;
  makespan_minutes: number;
  minimum_rest_minutes: number | null;
  maximum_matches_per_entry_day: number;
  preferred_final_delta_minutes: number | null;
  required_violation_count: number;
  preferred_penalty: number;
  components: readonly ScheduleQualityComponent[];
};

/** Immutable payload persisted with a schedule job and handed to a worker. */
export type ScheduleJobInput = {
  schema_version: 1;
  job_id: string;
  competition_id: string;
  source_revision: number;
  capacity_revision: number;
  capacity_hash: string;
  time_zone: string;
  objective: ScheduleObjective;
  matches: readonly ScheduleWorkerMatch[];
  slots: readonly ScheduleWorkerSlot[];
  constraints: ScheduleConstraints;
};

/** Current-best payload. Persistence uses (job_id, result_revision) as its key. */
export type ScheduleJobResult = {
  schema_version: 1;
  job_id: string;
  source_revision: number;
  result_revision: number;
  status: "valid" | "infeasible";
  assignments: readonly ScheduleAssignment[];
  violations: readonly ScheduleViolation[];
  quality: ScheduleQuality;
  /** Canonical SHA-256 of assignments only; PostgreSQL recomputes it. */
  assignment_hash: string;
};

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

/** Frontend-safe job projection. Worker leases, fences, and raw snapshots stay private. */
export type ScheduleJobView = {
  id: string;
  competition_id: string;
  revision: number;
  source_revision: number;
  capacity_revision: number;
  capacity_hash: string;
  status: ScheduleJobStatus;
  objective: ScheduleObjective;
  continued_from_job_id: string | null;
  current_best_option_id: string | null;
  current_best: ScheduleOptionView | null;
  cancellation_requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  failure_class: "invalid_input" | "no_solution" | "timeout" | "transient" | "permanent" | null;
  created_at: string;
  updated_at: string;
};

export type ScheduleOptionView = {
  id: string;
  job_id: string;
  result_revision: number;
  solver_iteration: number;
  result_status: "valid" | "infeasible";
  quality: ScheduleQuality;
  assignments: readonly ScheduleAssignment[];
  violations: readonly ScheduleViolation[];
  assignment_hash: string;
  created_at: string;
};

export type ScheduleRevisionView = {
  id: string;
  competition_id: string;
  revision: number;
  parent_revision_id: string | null;
  source_job_id: string | null;
  source_option_id: string | null;
  status: ScheduleRevisionStatus;
  editable_until: string | null;
  published_at: string | null;
  expired_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduleValidation = {
  valid: boolean;
  violations: readonly ScheduleViolation[];
};

export type ScheduleCandidate = {
  iteration: number;
  assignments: readonly ScheduleAssignment[];
};

export type ScheduleCandidateRequest = {
  start_iteration?: number;
  max_iterations?: number;
  seed_assignments?: readonly ScheduleAssignment[];
};
