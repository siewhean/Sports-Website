import type {
  GateCRepairActionRecord,
  GateCRepairCaseView,
  GateCRepairDecision,
  GateCRepairRevisionStatus,
  GateCRepairRevisionView,
  GateCRepairSlot,
} from "./gate-c-repair.js";

export type GateCRepairScheduleAdjustment = Readonly<{
  match_id: string;
  division_id: string;
  starts_at?: string | null;
  ends_at?: string | null;
  playing_area_id?: string | null;
  reason: string;
}>;

export type GateCRepairDecisionCommand = Readonly<{
  client_event_id: string;
  match_id: string;
  slot: GateCRepairSlot;
  decision: GateCRepairDecision["decision"];
  selected_entry_id?: string | null;
  reason: string;
}>;

export type GateCRepairRevisionCreateRequest = Readonly<{
  parent_revision_id: string | null;
  expected_result_version: number;
  expected_schedule_version: number;
  expected_analysis_fingerprint: string;
  status: Exclude<GateCRepairRevisionStatus, "published">;
  decisions: readonly GateCRepairDecisionCommand[];
  schedule_adjustments: readonly GateCRepairScheduleAdjustment[];
}>;

export type GateCRepairRevisionCreateResponse = Readonly<{
  revision: GateCRepairRevisionView;
  actions: readonly GateCRepairActionRecord[];
  unresolved_action_keys: readonly string[];
  publication_ready: boolean;
}>;

export type GateCRepairActionView = GateCRepairActionRecord &
  Readonly<{
    match_code: string | null;
    current_entry_name: string | null;
    proposed_entry_name: string | null;
    resolved_entry_name: string | null;
    adjustment: GateCRepairScheduleAdjustment | null;
  }>;

export type GateCRepairAuditEntry = Readonly<{
  occurred_at: string;
  actor_account_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
}>;

export type GateCRepairWorkspaceView = Readonly<{
  repair: GateCRepairCaseView;
  latest_revision: GateCRepairRevisionView | null;
  actions: readonly GateCRepairActionView[];
  unresolved_action_keys: readonly string[];
  publication_ready: boolean;
  current_result_version: number;
  published_schedule_version: number;
  public_projection_versions: Readonly<Record<string, number>>;
  audit: readonly GateCRepairAuditEntry[];
}>;

export type GateCRepairAbandonRequest = Readonly<{
  expected_revision: number;
  reason: string;
}>;
