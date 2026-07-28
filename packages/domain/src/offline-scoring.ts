const gateCOfflineQueueWarningCount = 1_800;
const gateCOfflineQueueLimit = 2_000;
const gateCOfflineRecordingDurationMs = 4 * 60 * 60 * 1_000;
const gateCOfflineReplayGraceMs = 15 * 60 * 1_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OfflineCanonicalEventCommand = Readonly<{
  kind: "event";
  client_event_id: string;
  expected_sequence: number;
  type: string;
  occurred_at: string;
  reversal_target_event_id?: string;
  reversal_target_client_event_id?: string;
  readonly [key: string]: unknown;
}>;

export type OfflineCanonicalCommand =
  | OfflineCanonicalEventCommand
  | Readonly<{
      kind: "finalisation";
      client_event_id: string;
      expected_sequence: number;
      occurred_at: string;
    }>;

export type OfflineMatchAuthorization = Readonly<{
  authorization_id: string;
  match_id: string;
  writer_generation: number;
  last_acknowledged_sequence: number;
  last_acknowledged_aggregate_version: number;
  authorized_at: string;
  recording_expires_at: string;
  replay_expires_at: string;
  pass_expires_at: string;
  status: "active" | "expired" | "revoked" | "transferred" | "completed";
  readonly [key: string]: unknown;
}>;

export type OfflineQueuedCommand = Readonly<{
  authorization_id: string;
  match_id: string;
  local_sequence: number;
  writer_generation: number;
  command: OfflineCanonicalCommand;
  readonly [key: string]: unknown;
}>;

export type OfflineAcknowledgement = Readonly<{
  authorization_id: string;
  match_id: string;
  local_sequence: number;
  client_event_id: string;
  event_id?: string;
  sequence: number;
  aggregate_version: number;
  readonly [key: string]: unknown;
}>;

export type OfflineRecordingAvailability =
  | "available"
  | "queue_warning"
  | "queue_full"
  | "recording_expired"
  | "replay_expired"
  | "pass_expired"
  | "expired"
  | "revoked"
  | "transferred"
  | "completed";

export function assertOfflineMatchAuthorization(matchPackage: OfflineMatchAuthorization): void {
  const schemaVersion = matchPackage["schema_version"];
  const competitionId = matchPackage["competition_id"];
  if (
    (schemaVersion !== undefined && schemaVersion !== 1) ||
    !UUID_PATTERN.test(matchPackage.authorization_id) ||
    (competitionId !== undefined && (typeof competitionId !== "string" || !UUID_PATTERN.test(competitionId))) ||
    !UUID_PATTERN.test(matchPackage.match_id) ||
    !Number.isSafeInteger(matchPackage.writer_generation) ||
    matchPackage.writer_generation < 1 ||
    !Number.isSafeInteger(matchPackage.last_acknowledged_sequence) ||
    matchPackage.last_acknowledged_sequence < 0 ||
    !Number.isSafeInteger(matchPackage.last_acknowledged_aggregate_version) ||
    matchPackage.last_acknowledged_aggregate_version < matchPackage.last_acknowledged_sequence
  ) {
    throw new Error("Offline authorization identity, generation, or sequence is invalid");
  }
  const authorizedAt = Date.parse(matchPackage.authorized_at);
  const recordingExpiresAt = Date.parse(matchPackage.recording_expires_at);
  const replayExpiresAt = Date.parse(matchPackage.replay_expires_at);
  const passExpiresAt = Date.parse(matchPackage.pass_expires_at);
  if (
    ![authorizedAt, recordingExpiresAt, replayExpiresAt, passExpiresAt].every(Number.isFinite) ||
    recordingExpiresAt <= authorizedAt ||
    recordingExpiresAt - authorizedAt > gateCOfflineRecordingDurationMs ||
    replayExpiresAt < recordingExpiresAt ||
    replayExpiresAt - recordingExpiresAt > gateCOfflineReplayGraceMs ||
    replayExpiresAt > passExpiresAt
  ) {
    throw new Error("Offline authorization recording and replay windows are invalid");
  }
}

export function canTransitionOfflineAuthorizationStatus(
  from: OfflineMatchAuthorization["status"],
  to: OfflineMatchAuthorization["status"],
): boolean {
  return from === to || (from === "active" && ["expired", "revoked", "transferred", "completed"].includes(to));
}

export function offlineRecordingAvailability(
  matchPackage: OfflineMatchAuthorization,
  pendingCount: number,
  now: number,
): OfflineRecordingAvailability {
  assertOfflineMatchAuthorization(matchPackage);
  if (matchPackage.status !== "active") return matchPackage.status;
  if (now >= Date.parse(matchPackage.pass_expires_at)) return "pass_expired";
  if (now >= Date.parse(matchPackage.replay_expires_at)) return "replay_expired";
  if (now >= Date.parse(matchPackage.recording_expires_at)) return "recording_expired";
  if (pendingCount >= gateCOfflineQueueLimit) return "queue_full";
  if (pendingCount >= gateCOfflineQueueWarningCount) return "queue_warning";
  return "available";
}

export function canReplayOfflineCommand(matchPackage: OfflineMatchAuthorization, now: number): boolean {
  assertOfflineMatchAuthorization(matchPackage);
  return (
    matchPackage.status === "active" &&
    now < Date.parse(matchPackage.pass_expires_at) &&
    now < Date.parse(matchPackage.replay_expires_at)
  );
}

export function assertOfflineCommand(command: OfflineCanonicalCommand): void {
  if (!UUID_PATTERN.test(command.client_event_id)) throw new Error("Offline command requires a UUID client event ID");
  if (!Number.isSafeInteger(command.expected_sequence) || command.expected_sequence < 0) {
    throw new Error("Offline command requires a non-negative expected sequence");
  }
  if (!Number.isFinite(Date.parse(command.occurred_at))) throw new Error("Offline command requires an event timestamp");

  if (command.kind === "finalisation") return;
  if (!command.type || command.type.length > 80) throw new Error("Offline score event requires a supported event type");
  if (command.reversal_target_event_id && command.reversal_target_client_event_id) {
    throw new Error("Offline reversal cannot identify both a server and local target");
  }
  if (command.type === "reversal" && !command.reversal_target_event_id && !command.reversal_target_client_event_id) {
    throw new Error("Offline reversal requires a server or local target");
  }
  if (command.type !== "reversal" && (command.reversal_target_event_id || command.reversal_target_client_event_id)) {
    throw new Error("Only reversal events may identify a reversal target");
  }
}

export function expectedSequenceForOfflineCommand(
  authoritativeSequence: number,
  retainedCommands: readonly OfflineQueuedCommand[],
): number {
  return Math.max(
    authoritativeSequence,
    retainedCommands[0]
      ? retainedCommands[0].command.expected_sequence + retainedCommands.length
      : authoritativeSequence,
  );
}

export function resolveOfflineCommandForReplay(
  queued: OfflineQueuedCommand,
  acknowledgements: readonly OfflineAcknowledgement[],
): OfflineCanonicalCommand {
  const command = queued.command;
  if (command.kind !== "event" || !command.reversal_target_client_event_id) return command;

  const target = acknowledgements.find(
    (acknowledgement) =>
      acknowledgement.authorization_id === queued.authorization_id &&
      acknowledgement.match_id === queued.match_id &&
      acknowledgement.client_event_id === command.reversal_target_client_event_id,
  );
  if (!target?.event_id) throw new Error("Offline reversal target has not received a server acknowledgement");

  const resolved = Object.fromEntries(
    Object.entries(command).filter(([key]) => key !== "reversal_target_client_event_id"),
  ) as unknown as OfflineCanonicalEventCommand;
  return Object.freeze({ ...resolved, reversal_target_event_id: target.event_id });
}

function sortedRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedRecord);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortedRecord(child)]),
  );
}

export function canonicalOfflineJson(value: unknown): string {
  return JSON.stringify(sortedRecord(value));
}

export function assertOfflineQueueIntegrity(
  matchPackage: OfflineMatchAuthorization,
  commands: readonly OfflineQueuedCommand[],
  acknowledgements: readonly OfflineAcknowledgement[],
): void {
  if (commands.length > gateCOfflineQueueLimit) throw new Error("Offline queue exceeds its hard command limit");
  const clientIds = new Set<string>();
  let previousLocalSequence = 0;
  let finalisationSeen = false;
  const queueBaseSequence = commands[0]?.command.expected_sequence ?? matchPackage.last_acknowledged_sequence;
  if (queueBaseSequence > matchPackage.last_acknowledged_sequence) {
    throw new Error("Offline queue cannot begin after the authoritative server sequence");
  }

  for (const queued of commands) {
    assertOfflineCommand(queued.command);
    if (
      queued.authorization_id !== matchPackage.authorization_id ||
      queued.match_id !== matchPackage.match_id ||
      queued.writer_generation !== matchPackage.writer_generation
    ) {
      throw new Error("Offline command is outside its authorised match generation");
    }
    if (queued.local_sequence !== previousLocalSequence + 1) {
      throw new Error("Offline local sequences must be contiguous");
    }
    if (queued.command.expected_sequence !== queueBaseSequence + queued.local_sequence - 1) {
      throw new Error("Offline expected sequences must be contiguous from the immutable queue base");
    }
    if (clientIds.has(queued.command.client_event_id)) throw new Error("Offline client event IDs must be unique");
    if (finalisationSeen) throw new Error("No command may follow offline finalisation");
    const command = queued.command;
    if (
      isLocalReversal(command) &&
      !commands
        .slice(0, previousLocalSequence)
        .some((candidate) => candidate.command.client_event_id === command.reversal_target_client_event_id)
    ) {
      throw new Error("Offline reversal must target an earlier command in the same queue");
    }
    clientIds.add(queued.command.client_event_id);
    previousLocalSequence = queued.local_sequence;
    finalisationSeen = queued.command.kind === "finalisation";
  }

  for (const [index, acknowledgement] of acknowledgements
    .toSorted((left, right) => left.local_sequence - right.local_sequence)
    .entries()) {
    if (acknowledgement.local_sequence !== index + 1) {
      throw new Error("Offline acknowledgements must form a contiguous prefix");
    }
    const queued = commands.find((candidate) => candidate.local_sequence === acknowledgement.local_sequence);
    if (
      !queued ||
      acknowledgement.authorization_id !== matchPackage.authorization_id ||
      acknowledgement.match_id !== matchPackage.match_id ||
      acknowledgement.client_event_id !== queued.command.client_event_id
    ) {
      throw new Error("Offline acknowledgement does not match an immutable queued command");
    }
    if (
      acknowledgement.sequence !== queueBaseSequence + acknowledgement.local_sequence ||
      acknowledgement.aggregate_version !== queueBaseSequence + acknowledgement.local_sequence
    ) {
      throw new Error("Offline acknowledgement versions must align with the immutable queue");
    }
  }
}

export function queuedCommandFingerprintInput(command: OfflineCanonicalCommand): string {
  return canonicalOfflineJson(command);
}

export function isLocalReversal(command: OfflineCanonicalCommand): command is OfflineCanonicalEventCommand & {
  reversal_target_client_event_id: string;
} {
  return command.kind === "event" && typeof command.reversal_target_client_event_id === "string";
}
