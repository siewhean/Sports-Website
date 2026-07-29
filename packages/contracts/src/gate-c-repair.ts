export const gateCRepairActionKinds = [
  "no_change",
  "automatic_update",
  "protected_started_match",
  "protected_finalised_match",
  "protected_manual_slot",
  "requires_organiser_decision",
] as const;

export type GateCRepairActionKind = (typeof gateCRepairActionKinds)[number];

export type GateCRepairMatchState = "pending" | "ready" | "in_progress" | "final" | "corrected";

export type GateCRepairSlot = "home" | "away";

export type GateCRepairSlotControl = "automatic" | "manual";

export type GateCRepairOutcomeKind = "winner" | "loser";

export type GateCRepairDependency = Readonly<{
  source_match_id: string;
  downstream_match_id: string;
  slot: GateCRepairSlot;
  outcome: GateCRepairOutcomeKind;
}>;

export type GateCRepairMatchSnapshot = Readonly<{
  match_id: string;
  division_id: string;
  state: GateCRepairMatchState;
  home_entry_id: string | null;
  away_entry_id: string | null;
  home_control: GateCRepairSlotControl;
  away_control: GateCRepairSlotControl;
  operationally_locked?: boolean;
}>;

export type GateCRepairOutcomeSnapshot = Readonly<{
  match_id: string;
  winner_entry_id: string | null;
  loser_entry_id: string | null;
}>;

export type GateCRepairDependencyPathStep = Readonly<{
  source_match_id: string;
  downstream_match_id: string;
  slot: GateCRepairSlot;
  outcome: GateCRepairOutcomeKind;
}>;

export type GateCRepairAction = Readonly<{
  match_id: string;
  division_id: string;
  slot: GateCRepairSlot;
  current_entry_id: string | null;
  proposed_entry_id: string | null;
  match_state: GateCRepairMatchState;
  control: GateCRepairSlotControl;
  action: GateCRepairActionKind;
  reason: string;
  dependency_path: readonly GateCRepairDependencyPathStep[];
}>;

export type GateCRepairAnalysis = Readonly<{
  schema_version: 1;
  competition_id: string;
  corrected_match_id: string;
  source_result_version: number;
  source_schedule_version: number;
  affected_division_ids: readonly string[];
  actions: readonly GateCRepairAction[];
  analysis_fingerprint_input: string;
}>;

export type GateCRepairCaseStatus = "open" | "drafted" | "published" | "abandoned";

export type GateCRepairCaseView = Readonly<{
  repair_id: string;
  competition_id: string;
  corrected_match_id: string;
  source_result_version: number;
  source_schedule_version: number;
  status: GateCRepairCaseStatus;
  analysis: GateCRepairAnalysis;
  created_at: string;
  created_by_account_id: string;
}>;

export type GateCRepairRevisionStatus = "draft" | "ready" | "published" | "abandoned";

export type GateCRepairRevisionView = Readonly<{
  repair_revision_id: string;
  repair_id: string;
  revision: number;
  status: GateCRepairRevisionStatus;
  source_result_version: number;
  source_schedule_version: number;
  analysis_fingerprint: string;
  analysis_fingerprint_input: string;
  created_at: string;
  created_by_account_id: string;
}>;

export type GateCRepairDecision = Readonly<{
  match_id: string;
  slot: GateCRepairSlot;
  decision: "accept_proposed" | "keep_current" | "set_manual_entry" | "leave_protected";
  selected_entry_id?: string | null;
  reason: string;
}>;

export type GateCRepairActionRecord = Readonly<{
  repair_action_id: string;
  repair_revision_id: string;
  ordinal: number;
  match_id: string;
  division_id: string;
  slot: GateCRepairSlot;
  source_action: GateCRepairActionKind;
  decision: GateCRepairDecision["decision"];
  current_entry_id: string | null;
  proposed_entry_id: string | null;
  resolved_entry_id: string | null;
  reason: string;
  dependency_path: readonly GateCRepairDependencyPathStep[];
  created_at: string;
}>;

export type GateCRepairPublicationRequest = Readonly<{
  competition_id: string;
  repair_id: string;
  repair_revision_id: string;
  expected_schedule_version: number;
  expected_result_version: number;
  expected_analysis_fingerprint: string;
  publication_idempotency_key: string;
}>;

export type GateCRepairPublicationReceipt = Readonly<{
  competition_id: string;
  repair_id: string;
  repair_revision_id: string;
  schedule_version: number;
  result_version: number;
  projection_version: number;
  schedule_revision_id: string;
  analysis_fingerprint: string;
  duplicate: boolean;
  published_at: string;
}>;

export type PublicProjectionFreshness = Readonly<{
  division_id: string;
  schedule_version: number;
  result_version: number;
  projection_version: number;
  generated_at: string;
  source_updated_at: string;
  etag: string;
}>;
