"use client";

import type {
  GateCOfflineAcknowledgement,
  GateCOfflineConflictCode,
  GateCOfflineMatchPackage,
  GateCOfflineQueuedCommand,
  GateCOfflineReplayError,
  GateCOfflineReplayReceipt,
} from "@matchday/contracts";

export type OfflineReplayAttempt = Readonly<{
  id?: number;
  authorization_id: string;
  local_sequence: number;
  attempt: number;
  started_at: string;
  completed_at: string;
  outcome: "acknowledged" | "blocked" | "retry";
  error?: GateCOfflineReplayError;
}>;

export type OfflineReplayState = Readonly<{
  authorization_id: string;
  owner_id: string;
  epoch: number;
  lease_expires_at: string;
  updated_at: string;
}>;

export type OfflineConflict = Readonly<{
  id?: number;
  authorization_id: string;
  match_id: string;
  local_sequence: number;
  client_event_id: string;
  code: GateCOfflineConflictCode;
  command_fingerprint?: string;
  writer_generation: number;
  recorded_at: string;
  acknowledged_at?: string;
}>;

export type OfflineScoringRepository = {
  saveMatchPackage(matchPackage: GateCOfflineMatchPackage): Promise<void>;
  transitionMatchPackageStatus(
    authorizationId: string,
    status: Exclude<GateCOfflineMatchPackage["status"], "active">,
  ): Promise<void>;
  getMatchPackage(authorizationId: string): Promise<GateCOfflineMatchPackage | null>;
  getActiveMatchPackage(): Promise<GateCOfflineMatchPackage | null>;
  getRecoverableMatchPackage(): Promise<GateCOfflineMatchPackage | null>;
  enqueue(command: GateCOfflineQueuedCommand, now?: number): Promise<void>;
  listCommands(authorizationId: string): Promise<GateCOfflineQueuedCommand[]>;
  listAcknowledgements(authorizationId: string): Promise<GateCOfflineAcknowledgement[]>;
  listPendingCommands(authorizationId: string): Promise<GateCOfflineQueuedCommand[]>;
  appendAcknowledgement(acknowledgement: GateCOfflineAcknowledgement): Promise<void>;
  appendReplayAttempt(attempt: OfflineReplayAttempt): Promise<void>;
  listReplayAttempts(authorizationId: string): Promise<OfflineReplayAttempt[]>;
  appendConflict(conflict: OfflineConflict): Promise<void>;
  listConflicts(authorizationId: string): Promise<OfflineConflict[]>;
  getReplayState?(authorizationId: string): Promise<OfflineReplayState | null>;
  recordDiagnosticExport(
    authorizationId: string,
    sha256: string,
    canonicalJson: string,
    recordedAt: string,
  ): Promise<void>;
  acquireReplayLease(authorizationId: string, ownerId: string, now: number, ttlMs: number): Promise<number | null>;
  renewReplayLease(
    authorizationId: string,
    ownerId: string,
    epoch: number,
    now: number,
    ttlMs: number,
  ): Promise<boolean>;
  releaseReplayLease(authorizationId: string, ownerId: string, epoch: number): Promise<void>;
  pruneTerminalQueue(authorizationId: string, now: number): Promise<boolean>;
  discardResolvedAuthorization(authorizationId: string): Promise<void>;
  discardAfterExport(authorizationId: string, expectedExportSha256: string, confirmedSha256: string): Promise<void>;
};

export type OfflineReplayPort = {
  submit(
    queued: GateCOfflineQueuedCommand,
    resolvedCommand: GateCOfflineQueuedCommand["command"],
    signal?: AbortSignal,
  ): Promise<GateCOfflineReplayReceipt>;
  refreshAuthority?(authorizationId: string): Promise<boolean>;
};
