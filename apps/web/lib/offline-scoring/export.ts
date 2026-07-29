"use client";

import type {
  GateCOfflineAcknowledgement,
  GateCOfflineMatchPackage,
  GateCOfflineQueuedCommand,
} from "@matchday/contracts";
import { canonicalOfflineJson } from "@matchday/domain";
import type { OfflineConflict, OfflineScoringRepository } from "./types";

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
    schema_version: number;
    authorized_at: string;
    recording_expires_at: string;
    replay_expires_at: string;
    status: string;
  };
  queue: {
    command_count: number;
    acknowledged_count: number;
    pending_count: number;
    first_local_sequence: number | null;
    last_local_sequence: number | null;
    first_enqueued_at: string | null;
    last_enqueued_at: string | null;
    writer_generations: readonly number[];
  };
  acknowledgements: readonly Readonly<{
    local_sequence: number;
    command_fingerprint: string;
    outcome: GateCOfflineAcknowledgement["outcome"];
    sequence: number;
    aggregate_version: number;
    result_version?: number;
    publication_version?: number;
    server_received_at: string;
    acknowledged_at: string;
  }>[];
  conflicts: readonly Readonly<{
    local_sequence: number;
    code: OfflineConflict["code"];
    command_fingerprint?: string;
    writer_generation: number;
    recorded_at: string;
    acknowledged_at?: string;
  }>[];
}>;

export async function buildOfflineDiagnosticDocument(
  matchPackage: GateCOfflineMatchPackage,
  commands: readonly GateCOfflineQueuedCommand[],
  acknowledgements: readonly GateCOfflineAcknowledgement[],
  conflicts: readonly OfflineConflict[],
  generatedAt: string,
): Promise<OfflineDiagnosticDocument> {
  const sortedCommands = commands.toSorted((left, right) => left.local_sequence - right.local_sequence);
  const acknowledgedSequences = new Set(acknowledgements.map(({ local_sequence }) => local_sequence));
  const firstCommand = sortedCommands.at(0);
  const lastCommand = sortedCommands.at(-1);

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
      schema_version: matchPackage.schema_version,
      authorized_at: matchPackage.authorized_at,
      recording_expires_at: matchPackage.recording_expires_at,
      replay_expires_at: matchPackage.replay_expires_at,
      status: matchPackage.status,
    },
    queue: {
      command_count: sortedCommands.length,
      acknowledged_count: acknowledgedSequences.size,
      pending_count: sortedCommands.filter(({ local_sequence }) => !acknowledgedSequences.has(local_sequence)).length,
      first_local_sequence: firstCommand?.local_sequence ?? null,
      last_local_sequence: lastCommand?.local_sequence ?? null,
      first_enqueued_at: firstCommand?.enqueued_at ?? null,
      last_enqueued_at: lastCommand?.enqueued_at ?? null,
      writer_generations: [...new Set(sortedCommands.map(({ writer_generation }) => writer_generation))].toSorted(
        (left, right) => left - right,
      ),
    },
    acknowledgements: acknowledgements
      .toSorted((left, right) => left.local_sequence - right.local_sequence)
      .map(
        ({
          local_sequence,
          command_fingerprint,
          outcome,
          sequence,
          aggregate_version,
          result_version,
          publication_version,
          server_received_at,
          acknowledged_at,
        }) => ({
          local_sequence,
          command_fingerprint,
          outcome,
          sequence,
          aggregate_version,
          ...(result_version === undefined ? {} : { result_version }),
          ...(publication_version === undefined ? {} : { publication_version }),
          server_received_at,
          acknowledged_at,
        }),
      ),
    conflicts: conflicts
      .toSorted((left, right) => left.local_sequence - right.local_sequence)
      .map(({ local_sequence, code, command_fingerprint, writer_generation, recorded_at, acknowledged_at }) => ({
        local_sequence,
        code,
        ...(command_fingerprint === undefined ? {} : { command_fingerprint }),
        writer_generation,
        recorded_at,
        ...(acknowledged_at === undefined ? {} : { acknowledged_at }),
      })),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const privateIntegrityNonce = randomHex(32);
  const privateIntegrityDigest = await sha256(
    `${privateIntegrityNonce}:${canonicalOfflineJson({ matchPackage, commands, acknowledgements, conflicts })}`,
  );
  await repository.recordDiagnosticExport(
    authorizationId,
    checksum,
    json,
    document.generated_at,
    privateIntegrityNonce,
    privateIntegrityDigest,
  );
  return { document, json, sha256: checksum };
}
