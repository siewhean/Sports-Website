export type AccessPhase = "access" | "confirm" | "scoring";
export type ScorekeeperTeam = "blue" | "gold";
export type WriterState = "active" | "read_only";
export type SyncState = "offline" | "replaying" | "synced";
export type FinalState = "open" | "pending_sync" | "published";
export type EventKind = "goal" | "neutral" | "reversal" | "finalisation" | "correction";
export type EventSync = "pending" | "acknowledged" | "conflict";
export type ConflictResolution = "discarded" | "converted";

export type ScoreEvent = {
  id: string;
  sequence: number;
  generation: number;
  kind: EventKind;
  label: string;
  occurredAt: string;
  sync: EventSync;
  team?: ScorekeeperTeam;
  scoreDelta?: number;
  reason?: string;
  reversedEventId?: string;
  resolution?: ConflictResolution;
};

export type NewScoreEvent = Omit<ScoreEvent, "id" | "sequence" | "generation" | "sync"> & {
  sync?: EventSync;
};
