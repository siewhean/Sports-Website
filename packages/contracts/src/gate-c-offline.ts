import type { Phase3SportCode } from "./phase-3.js";

export const gateCOfflineSchemaVersion = 1 as const;
export const gateCOfflineRecordingDurationMs = 4 * 60 * 60 * 1_000;
export const gateCOfflineReplayGraceMs = 15 * 60 * 1_000;
export const gateCOfflineQueueWarningCount = 1_800;
export const gateCOfflineQueueLimit = 2_000;

export type GateCOfflineAuthorizationStatus = "active" | "expired" | "revoked" | "transferred" | "completed";

export type GateCOfflineParticipant = Readonly<{
  id: string;
  name: string;
  side: "home" | "away";
}>;

export type GateCOfflineMatchPackage = Readonly<{
  schema_version: typeof gateCOfflineSchemaVersion;
  principal_id: string;
  authorization_id: string;
  competition_id: string;
  competition_slug: string;
  match_id: string;
  match_code: string;
  match_stage: string;
  writer_generation: number;
  sport_code: Phase3SportCode;
  sport_pack_version: string;
  settings: Readonly<Record<string, unknown>>;
  participants: readonly GateCOfflineParticipant[];
  authoritative_events: readonly Readonly<{
    event_id: string;
    sequence: number;
    command: GateCOfflineCanonicalCommand;
  }>[];
  last_acknowledged_sequence: number;
  last_acknowledged_aggregate_version: number;
  authorized_at: string;
  recording_expires_at: string;
  replay_expires_at: string;
  pass_expires_at: string;
  status: GateCOfflineAuthorizationStatus;
}>;

export type GateCOfflineCanonicalEventCommand = Readonly<{
  kind: "event";
  client_event_id: string;
  expected_sequence: number;
  type: string;
  occurred_at: string;
  team_slot?: "home" | "away";
  participant_id?: string | null;
  unknown_participant?: boolean;
  segment_number?: number;
  manual_time_seconds?: number | null;
  reversal_target_event_id?: string;
  reversal_target_client_event_id?: string;
  reason?: string;
}>;

export type GateCOfflineFinalisationCommand = Readonly<{
  kind: "finalisation";
  client_event_id: string;
  expected_sequence: number;
  occurred_at: string;
}>;

export type GateCOfflineCanonicalCommand = GateCOfflineCanonicalEventCommand | GateCOfflineFinalisationCommand;

export type GateCOfflineQueuedCommand = Readonly<{
  authorization_id: string;
  match_id: string;
  local_sequence: number;
  writer_generation: number;
  enqueued_at: string;
  command: GateCOfflineCanonicalCommand;
}>;

export type GateCOfflineAcknowledgement = Readonly<{
  authorization_id: string;
  match_id: string;
  local_sequence: number;
  client_event_id: string;
  command_fingerprint: string;
  outcome: "accepted" | "duplicate";
  event_id?: string;
  sequence: number;
  aggregate_version: number;
  result_version?: number;
  publication_version?: number;
  server_received_at: string;
  acknowledged_at: string;
}>;

export type GateCOfflineConflictCode =
  | "aggregate_version_conflict"
  | "authority_expired"
  | "authority_revoked"
  | "authority_transferred"
  | "idempotency_key_reused"
  | "invalid_command"
  | "missing_reversal_target"
  | "pass_expired"
  | "storage_corrupt"
  | "stale_writer_generation";

export type GateCOfflineReplayError = Readonly<{
  code: GateCOfflineConflictCode | "network_unavailable" | "rate_limited" | "server_unavailable";
  category: "conflict" | "permission" | "retryable" | "storage" | "validation";
  request_id?: string;
  retry_after_seconds?: number;
}>;

export type GateCOfflineReplayReceipt =
  | Readonly<{ status: "acknowledged"; acknowledgement: GateCOfflineAcknowledgement }>
  | Readonly<{ status: "retry"; error: GateCOfflineReplayError }>
  | Readonly<{ status: "blocked"; error: GateCOfflineReplayError }>;

export type GateCOfflineQueueSummary = Readonly<{
  authorization_id: string;
  pending_count: number;
  last_local_sequence: number;
  last_acknowledged_sequence: number;
  queue_fingerprint: string;
}>;
