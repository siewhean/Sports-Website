"use client";

import type {
  GateCOfflineAcknowledgement,
  GateCOfflineCanonicalCommand,
  GateCOfflineMatchPackage,
  GateCOfflineQueuedCommand,
} from "@matchday/contracts";
import { canonicalOfflineJson } from "@matchday/domain";
import type { OfflineConflict, OfflineReplayAttempt, OfflineReplayState, OfflineScoringRepository } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_WORKER_VERSION = "gate-c-c3-v4";

export type OfflineDiagnosticDocument = Readonly<{
  export_version: 2;
  generated_at: string;
  authorization: {
    authorization_id: string;
    competition_id: string;
    match_id: string;
    sport_code: string;
    sport_pack_version: string;
    writer_generation: number;
    indexeddb_schema_version: number;
    service_worker_version: string;
    settings_fingerprint: string;
    queue_fingerprint: string;
    last_server_confirmed_sequence: number;
    last_server_confirmed_aggregate_version: number;
    authorized_at: string;
    recording_expires_at: string;
    replay_expires_at: string;
    status: string;
  };
  canonical_commands: readonly Readonly<{
    local_sequence: number;
    writer_generation: number;
    enqueued_at: string;
    command_fingerprint: string;
    command: GateCOfflineCanonicalCommand;
  }>[];
  acknowledgements: readonly GateCOfflineAcknowledgement[];
  replay_attempts: readonly Omit<OfflineReplayAttempt, "id">[];
  replay_state: Omit<OfflineReplayState, "owner_id"> | null;
  conflicts: readonly Omit<OfflineConflict, "id">[];
}>;

async function redactedReference(kind: "participant" | "reason", value: string): Promise<string> {
  return `[redacted-${kind}:${(await sha256(value)).slice(0, 16)}]`;
}

async function sanitizedCommand(command: GateCOfflineCanonicalCommand): Promise<GateCOfflineCanonicalCommand> {
  if (command.kind === "finalisation") return { ...command };
  return {
    kind: "event",
    client_event_id: command.client_event_id,
    expected_sequence: command.expected_sequence,
    type: command.type,
    occurred_at: command.occurred_at,
    ...(command.team_slot ? { team_slot: command.team_slot } : {}),
    ...(command.participant_id !== undefined
      ? {
          participant_id:
            command.participant_id === null || UUID_PATTERN.test(command.participant_id)
              ? command.participant_id
              : await redactedReference("participant", command.participant_id),
        }
      : {}),
    ...(command.unknown_participant !== undefined ? { unknown_participant: command.unknown_participant } : {}),
    ...(command.segment_number !== undefined ? { segment_number: command.segment_number } : {}),
    ...(command.manual_time_seconds !== undefined ? { manual_time_seconds: command.manual_time_seconds } : {}),
    ...(command.reversal_target_event_id ? { reversal_target_event_id: command.reversal_target_event_id } : {}),
    ...(command.reversal_target_client_event_id
      ? { reversal_target_client_event_id: command.reversal_target_client_event_id }
      : {}),
    ...(command.reason ? { reason: await redactedReference("reason", command.reason) } : {}),
  };
}

/** @deprecated Use the replay-attempt-aware overload for production export and deletion. */
export function buildOfflineDiagnosticDocument(
  matchPackage: GateCOfflineMatchPackage,
  commands: readonly GateCOfflineQueuedCommand[],
  acknowledgements: readonly GateCOfflineAcknowledgement[],
  conflicts: readonly OfflineConflict[],
  generatedAt: string,
): Promise<OfflineDiagnosticDocument>;
export function buildOfflineDiagnosticDocument(
  matchPackage: GateCOfflineMatchPackage,
  commands: readonly GateCOfflineQueuedCommand[],
  acknowledgements: readonly GateCOfflineAcknowledgement[],
  replayAttempts: readonly OfflineReplayAttempt[],
  conflicts: readonly OfflineConflict[],
  generatedAt: string,
  replayState?: OfflineReplayState | null,
): Promise<OfflineDiagnosticDocument>;
export async function buildOfflineDiagnosticDocument(
  matchPackage: GateCOfflineMatchPackage,
  commands: readonly GateCOfflineQueuedCommand[],
  acknowledgements: readonly GateCOfflineAcknowledgement[],
  replayAttemptsOrConflicts: readonly OfflineReplayAttempt[] | readonly OfflineConflict[],
  conflictsOrGeneratedAt: readonly OfflineConflict[] | string,
  generatedAtOrReplayState?: string | OfflineReplayState | null,
  optionalReplayState: OfflineReplayState | null = null,
): Promise<OfflineDiagnosticDocument> {
  const legacyCall = typeof conflictsOrGeneratedAt === "string";
  const replayAttempts = legacyCall ? [] : (replayAttemptsOrConflicts as readonly OfflineReplayAttempt[]);
  const conflicts = legacyCall
    ? (replayAttemptsOrConflicts as readonly OfflineConflict[])
    : conflictsOrGeneratedAt;
  const generatedAt = legacyCall ? conflictsOrGeneratedAt : generatedAtOrReplayState;
  const replayState = legacyCall ? null : optionalReplayState;
  if (typeof generatedAt !== "string" || !Array.isArray(conflicts)) {
    throw new Error("Offline diagnostic export arguments are invalid.");
  }

  const sortedCommands = commands.toSorted((left, right) => left.local_sequence - right.local_sequence);
  const sortedAcknowledgements = acknowledgements.toSorted(
    (left, right) => left.local_sequence - right.local_sequence,
  );
  const queueFingerprint = await sha256(
    canonicalOfflineJson({ commands: sortedCommands, acknowledgements: sortedAcknowledgements }),
  );
  const settingsFingerprint = await sha256(canonicalOfflineJson(matchPackage.settings));
  return {
    export_version: 2,
    generated_at: generatedAt,
    authorization: {
      authorization_id: matchPackage.authorization_id,
      competition_id: matchPackage.competition_id,
      match_id: matchPackage.match_id,
      sport_code: matchPackage.sport_code,
      sport_pack_version: matchPackage.sport_pack_version,
      writer_generation: matchPackage.writer_generation,
      indexeddb_schema_version: matchPackage.schema_version,
      service_worker_version: SERVICE_WORKER_VERSION,
      settings_fingerprint: settingsFingerprint,
      queue_fingerprint: queueFingerprint,
      last_server_confirmed_sequence: matchPackage.last_acknowledged_sequence,
      last_server_confirmed_aggregate_version: matchPackage.last_acknowledged_aggregate_version,
      authorized_at: matchPackage.authorized_at,
      recording_expires_at: matchPackage.recording_expires_at,
      replay_expires_at: matchPackage.replay_expires_at,
      status: matchPackage.status,
    },
    canonical_commands: await Promise.all(
      sortedCommands.map(async ({ local_sequence, writer_generation, enqueued_at, command }) => ({
        local_sequence,
        writer_generation,
        enqueued_at,
        command_fingerprint: await sha256(canonicalOfflineJson(command)),
        command: await sanitizedCommand(command),
      })),
    ),
    acknowledgements: sortedAcknowledgements.map(({ ...acknowledgement }) => acknowledgement),
    replay_attempts: replayAttempts
      .toSorted((left, right) =>
        left.local_sequence === right.local_sequence
          ? left.attempt - right.attempt
          : left.local_sequence - right.local_sequence,
      )
      .map(({ id: _id, ...attempt }) => attempt),
    replay_state: replayState
      ? {
          authorization_id: replayState.authorization_id,
          epoch: replayState.epoch,
          lease_expires_at: replayState.lease_expires_at,
          updated_at: replayState.updated_at,
        }
      : null,
    conflicts: conflicts
      .toSorted((left, right) => left.local_sequence - right.local_sequence)
      .map(
        (conflict) =>
          Object.fromEntries(Object.entries(conflict).filter(([key]) => key !== "id")) as Omit<OfflineConflict, "id">,
      ),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createOfflineDiagnosticExport(
  repository: OfflineScoringRepository,
  authorizationId: string,
  now: number = Date.now(),
): Promise<{ document: OfflineDiagnosticDocument; json: string; sha256: string }> {
  const [matchPackage, commands, acknowledgements, replayAttempts, conflicts, replayState] = await Promise.all([
    repository.getMatchPackage(authorizationId),
    repository.listCommands(authorizationId),
    repository.listAcknowledgements(authorizationId),
    repository.listReplayAttempts(authorizationId),
    repository.listConflicts(authorizationId),
    repository.getReplayState?.(authorizationId) ?? Promise.resolve(null),
  ]);
  if (!matchPackage) throw new Error("Offline match authorization is unavailable.");
  const document = await buildOfflineDiagnosticDocument(
    matchPackage,
    commands,
    acknowledgements,
    replayAttempts,
    conflicts,
    new Date(now).toISOString(),
    replayState,
  );
  const json = canonicalOfflineJson(document);
  const checksum = await sha256(json);
  await repository.recordDiagnosticExport(authorizationId, checksum, json, document.generated_at);
  return { document, json, sha256: checksum };
}
