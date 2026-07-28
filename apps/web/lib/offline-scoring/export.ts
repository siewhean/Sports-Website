"use client";

import type {
  GateCOfflineAcknowledgement,
  GateCOfflineCanonicalCommand,
  GateCOfflineMatchPackage,
  GateCOfflineQueuedCommand,
} from "@matchday/contracts";
import { canonicalOfflineJson } from "@matchday/domain";
import type { OfflineConflict, OfflineScoringRepository } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OfflineDiagnosticDocument = Readonly<{
  export_version: 1;
  generated_at: string;
  authorization: {
    authorization_id: string;
    competition_id: string;
    match_id: string;
    sport_code: string;
    sport_pack_version: string;
    writer_generation: number;
    schema_version: number;
    authorized_at: string;
    recording_expires_at: string;
    replay_expires_at: string;
    status: string;
  };
  canonical_commands: readonly Readonly<{
    local_sequence: number;
    writer_generation: number;
    enqueued_at: string;
    command: GateCOfflineCanonicalCommand;
  }>[];
  acknowledgements: readonly GateCOfflineAcknowledgement[];
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

export async function buildOfflineDiagnosticDocument(
  matchPackage: GateCOfflineMatchPackage,
  commands: readonly GateCOfflineQueuedCommand[],
  acknowledgements: readonly GateCOfflineAcknowledgement[],
  conflicts: readonly OfflineConflict[],
  generatedAt: string,
): Promise<OfflineDiagnosticDocument> {
  return {
    export_version: 1,
    generated_at: generatedAt,
    authorization: {
      authorization_id: matchPackage.authorization_id,
      competition_id: matchPackage.competition_id,
      match_id: matchPackage.match_id,
      sport_code: matchPackage.sport_code,
      sport_pack_version: matchPackage.sport_pack_version,
      writer_generation: matchPackage.writer_generation,
      schema_version: matchPackage.schema_version,
      authorized_at: matchPackage.authorized_at,
      recording_expires_at: matchPackage.recording_expires_at,
      replay_expires_at: matchPackage.replay_expires_at,
      status: matchPackage.status,
    },
    canonical_commands: await Promise.all(
      commands
        .toSorted((left, right) => left.local_sequence - right.local_sequence)
        .map(async ({ local_sequence, writer_generation, enqueued_at, command }) => ({
          local_sequence,
          writer_generation,
          enqueued_at,
          command: await sanitizedCommand(command),
        })),
    ),
    acknowledgements: acknowledgements
      .toSorted((left, right) => left.local_sequence - right.local_sequence)
      .map(({ ...acknowledgement }) => acknowledgement),
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
  const [matchPackage, commands, acknowledgements, conflicts] = await Promise.all([
    repository.getMatchPackage(authorizationId),
    repository.listCommands(authorizationId),
    repository.listAcknowledgements(authorizationId),
    repository.listConflicts(authorizationId),
  ]);
  if (!matchPackage) throw new Error("Offline match authorization is unavailable.");
  const document = await buildOfflineDiagnosticDocument(
    matchPackage,
    commands,
    acknowledgements,
    conflicts,
    new Date(now).toISOString(),
  );
  const json = canonicalOfflineJson(document);
  const checksum = await sha256(json);
  await repository.recordDiagnosticExport(authorizationId, checksum, json, document.generated_at);
  return { document, json, sha256: checksum };
}
