"use client";

import type {
  GateCOfflineAcknowledgement,
  GateCOfflineCanonicalCommand,
  GateCOfflineMatchPackage,
  GateCOfflineQueuedCommand,
} from "@matchday/contracts";
import {
  assertOfflineQueueIntegrity,
  reduceFiveSportScoreEvents,
  type FiveSportScoreEvent,
  type SportPackSettings,
} from "@matchday/domain";
import type { OfflineScoringRepository } from "./offline-scoring";
import type { OfflineAuthorityMetadata } from "./offline-scoring-port";
import type { FinalizeResultCommand, ScoringEventCommand, ScoringSessionView } from "./phase2";

const LOCAL_ACTOR_ID = "00000000-0000-4000-8000-000000000301";
const LOCAL_SESSION_ID = "00000000-0000-4000-8000-000000000302";

export class OfflineReconnectSingleFlight {
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private trailingOperation: (() => Promise<void>) | null = null;

  run(operation: () => Promise<void>): Promise<void> {
    if (this.inFlight) {
      this.rerunRequested = true;
      this.trailingOperation = operation;
      return this.inFlight;
    }
    const pending = Promise.resolve().then(() => this.runUntilSettled(operation));
    this.inFlight = pending;
    return pending;
  }

  waitForIdle(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  private async runUntilSettled(initialOperation: () => Promise<void>): Promise<void> {
    let operation = initialOperation;
    while (true) {
      let failure: unknown;
      let failed = false;
      try {
        await operation();
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (!this.rerunRequested) {
        this.inFlight = null;
        if (failed) throw failure;
        return;
      }
      operation = this.trailingOperation ?? operation;
      this.rerunRequested = false;
      this.trailingOperation = null;
    }
  }
}

function eventFromCommand(
  matchId: string,
  eventId: string,
  sequence: number,
  command: GateCOfflineCanonicalCommand,
  localEventIds: ReadonlyMap<string, string>,
): FiveSportScoreEvent {
  if (command.kind === "finalisation") {
    return {
      eventId,
      clientEventId: command.client_event_id,
      matchId,
      sequence,
      actorId: LOCAL_ACTOR_ID,
      scoringSessionId: LOCAL_SESSION_ID,
      occurredAt: command.occurred_at,
      type: "finalisation",
    };
  }
  const reversalTargetEventId =
    command.reversal_target_event_id ??
    (command.reversal_target_client_event_id ? localEventIds.get(command.reversal_target_client_event_id) : undefined);
  return {
    eventId,
    clientEventId: command.client_event_id,
    matchId,
    sequence,
    actorId: LOCAL_ACTOR_ID,
    scoringSessionId: LOCAL_SESSION_ID,
    occurredAt: command.occurred_at,
    type: command.type,
    ...(command.team_slot ? { side: command.team_slot } : {}),
    ...(command.participant_id !== undefined ? { participantId: command.participant_id } : {}),
    ...(command.unknown_participant !== undefined ? { unknownParticipant: command.unknown_participant } : {}),
    ...(command.segment_number !== undefined ? { segmentNumber: command.segment_number } : {}),
    ...(command.manual_time_seconds !== undefined ? { manualTimeSeconds: command.manual_time_seconds } : {}),
    ...(reversalTargetEventId ? { reversalTargetEventId } : {}),
    ...(command.reason ? { reason: command.reason } : {}),
  };
}

function projectedSession(
  matchPackage: GateCOfflineMatchPackage,
  queuedCommands: readonly GateCOfflineQueuedCommand[],
  acknowledgements: readonly GateCOfflineAcknowledgement[] = [],
): ScoringSessionView {
  const localEventIds = new Map<string, string>();
  const acknowledgementByLocalSequence = new Map(
    acknowledgements.map((acknowledgement) => [acknowledgement.local_sequence, acknowledgement]),
  );
  const events: FiveSportScoreEvent[] = [];
  for (const authoritative of matchPackage.authoritative_events) {
    localEventIds.set(authoritative.command.client_event_id, authoritative.event_id);
    events.push(
      eventFromCommand(
        matchPackage.match_id,
        authoritative.event_id,
        authoritative.sequence,
        authoritative.command,
        localEventIds,
      ),
    );
  }
  for (const queued of queuedCommands) {
    const acknowledgement = acknowledgementByLocalSequence.get(queued.local_sequence);
    const localEventId = acknowledgement?.event_id ?? queued.command.client_event_id;
    localEventIds.set(queued.command.client_event_id, localEventId);
    events.push(
      eventFromCommand(
        matchPackage.match_id,
        localEventId,
        queued.command.expected_sequence + 1,
        queued.command,
        localEventIds,
      ),
    );
  }
  const settings = matchPackage.settings as SportPackSettings;
  const reduced = reduceFiveSportScoreEvents(matchPackage.sport_code, events, settings);
  const home = matchPackage.participants.find(({ side }) => side === "home");
  const away = matchPackage.participants.find(({ side }) => side === "away");
  return {
    competitionSlug: matchPackage.competition_slug,
    sportId: matchPackage.sport_code,
    sportPackVersion: matchPackage.sport_pack_version,
    sportSettings: settings,
    matchId: matchPackage.match_id,
    matchLabel: matchPackage.match_code,
    stage: matchPackage.match_stage,
    home: home?.name ?? "Home",
    away: away?.name ?? "Away",
    homeScore: reduced.score.home,
    awayScore: reduced.score.away,
    scoreState: {
      home: reduced.score.home,
      away: reduced.score.away,
      lifecycle: reduced.lifecycle,
      currentSegment: reduced.currentSegment,
      totalPoints: reduced.totalPoints,
      segmentWins: reduced.segmentWins,
      segments: reduced.segments.map((segment) => ({
        number: segment.number,
        home: segment.home,
        away: segment.away,
        completed: segment.completed,
        winner: segment.winner,
      })),
      actions: reduced.actions.map((action) => ({
        eventId: action.eventId,
        clientEventId: action.clientEventId,
        eventType: action.eventType,
        label: action.label,
        side: action.side,
        participantId: action.participantId,
        segmentNumber: action.segmentNumber,
        scoreDelta: action.scoreDelta,
        occurredAt: action.occurredAt,
        reversed: action.reversed,
        reversible: !["finalisation", "match_started", "reversal"].includes(action.eventType),
      })),
      conflicts: reduced.conflicts.map((conflict) => ({
        code: conflict.code,
        segmentNumber: conflict.segmentNumber,
        targetEventId: conflict.targetEventId,
      })),
    },
    events: [],
    canonicalEvents: [
      ...matchPackage.authoritative_events.map(({ event_id, sequence, command }) => ({
        eventId: event_id,
        sequence,
        command,
      })),
      ...queuedCommands.map((queued) => ({
        eventId: acknowledgementByLocalSequence.get(queued.local_sequence)?.event_id ?? queued.command.client_event_id,
        sequence: queued.command.expected_sequence + 1,
        command: queued.command,
      })),
    ],
    throughSequence: (matchPackage.authoritative_events.at(-1)?.sequence ?? 0) + queuedCommands.length,
    mode: "writer",
    permissions: ["score:read", "score:write", "score:reverse", "score:finalise"],
    generation: matchPackage.writer_generation,
    leaseExpiresAt: matchPackage.recording_expires_at,
    expiresAt: matchPackage.pass_expires_at,
    takeoverStatus: "none",
    readOnly:
      matchPackage.status !== "active" ||
      Date.now() >= Date.parse(matchPackage.recording_expires_at) ||
      Date.now() >= Date.parse(matchPackage.pass_expires_at),
  };
}

export async function saveOfflineMatchPackage(
  repository: OfflineScoringRepository,
  session: ScoringSessionView,
  authority: OfflineAuthorityMetadata,
  now: number = Date.now(),
): Promise<GateCOfflineMatchPackage> {
  if (
    authority.match_id !== session.matchId ||
    authority.generation !== session.generation ||
    session.mode !== "writer" ||
    session.readOnly
  ) {
    throw new Error("Offline authority does not match the active scoring session.");
  }
  if (session.canonicalEvents.length !== session.throughSequence) {
    throw new Error("Offline preparation requires the complete authoritative scoring stream.");
  }
  const matchPackage: GateCOfflineMatchPackage = {
    schema_version: 1,
    authorization_id: authority.authorization_id,
    competition_id: authority.competition_id,
    competition_slug: session.competitionSlug,
    match_id: session.matchId,
    match_code: session.matchLabel,
    match_stage: session.stage,
    writer_generation: authority.generation,
    sport_code: session.sportId,
    sport_pack_version: session.sportPackVersion,
    settings: session.sportSettings,
    participants: [
      { id: "home", name: session.home, side: "home" },
      { id: "away", name: session.away, side: "away" },
    ],
    authoritative_events: session.canonicalEvents.map(({ eventId, sequence, command }) => ({
      event_id: eventId,
      sequence,
      command,
    })),
    last_acknowledged_sequence: session.throughSequence,
    last_acknowledged_aggregate_version: session.throughSequence,
    authorized_at: new Date(now).toISOString(),
    recording_expires_at: authority.recording_expires_at,
    replay_expires_at: authority.replay_expires_at,
    pass_expires_at: authority.pass_expires_at,
    status: "active",
  };
  await repository.saveMatchPackage(matchPackage);
  return matchPackage;
}

export async function reconcileOfflineReplayRecovery(
  repository: OfflineScoringRepository,
  session: ScoringSessionView,
  authority: OfflineAuthorityMetadata,
): Promise<{ receiptId: string; publishedAt: string } | null> {
  if (session.scoreState.lifecycle === "finalised") {
    const acknowledgements = await repository.listAcknowledgements(authority.authorization_id);
    const finalAcknowledgement = acknowledgements.findLast(
      ({ result_version: resultVersion }) => resultVersion !== undefined,
    );
    if (finalAcknowledgement?.result_version === undefined) {
      throw new Error("Finalised authoritative state has no durable finalisation acknowledgement.");
    }
    return {
      receiptId: `${session.matchId}:v${finalAcknowledgement.result_version}`,
      publishedAt: finalAcknowledgement.server_received_at,
    };
  }
  await saveOfflineMatchPackage(repository, session, authority);
  return null;
}

function eventCommand(command: ScoringEventCommand, expectedSequence: number): GateCOfflineCanonicalCommand {
  return {
    kind: "event",
    client_event_id: command.clientEventId,
    expected_sequence: expectedSequence,
    type: command.eventType,
    occurred_at: command.occurredAt ?? new Date().toISOString(),
    ...(command.team ? { team_slot: command.team } : {}),
    ...(command.participantId !== undefined ? { participant_id: command.participantId } : {}),
    ...(command.unknownParticipant !== undefined ? { unknown_participant: command.unknownParticipant } : {}),
    ...(command.segmentNumber !== undefined ? { segment_number: command.segmentNumber } : {}),
    ...(command.manualTimeSeconds !== undefined ? { manual_time_seconds: command.manualTimeSeconds } : {}),
    ...(command.reversalTargetEventId ? { reversal_target_event_id: command.reversalTargetEventId } : {}),
    ...(command.reversalTargetClientEventId
      ? { reversal_target_client_event_id: command.reversalTargetClientEventId }
      : {}),
    ...(command.reason ? { reason: command.reason } : {}),
  };
}

export async function enqueueOfflineEvent(
  repository: OfflineScoringRepository,
  matchPackage: GateCOfflineMatchPackage,
  command: ScoringEventCommand,
  now: number = Date.now(),
): Promise<ScoringSessionView> {
  const [commands, pendingCommands] = await Promise.all([
    repository.listCommands(matchPackage.authorization_id),
    repository.listPendingCommands(matchPackage.authorization_id),
  ]);
  const queued: GateCOfflineQueuedCommand = {
    authorization_id: matchPackage.authorization_id,
    match_id: matchPackage.match_id,
    local_sequence: commands.length + 1,
    writer_generation: matchPackage.writer_generation,
    enqueued_at: new Date(now).toISOString(),
    command: eventCommand(command, matchPackage.last_acknowledged_sequence + pendingCommands.length),
  };
  await repository.enqueue(queued, now);
  return projectedSession(matchPackage, [...pendingCommands, queued]);
}

export async function enqueueOfflineFinalisation(
  repository: OfflineScoringRepository,
  matchPackage: GateCOfflineMatchPackage,
  command: FinalizeResultCommand,
  now: number = Date.now(),
): Promise<ScoringSessionView> {
  const [commands, pendingCommands] = await Promise.all([
    repository.listCommands(matchPackage.authorization_id),
    repository.listPendingCommands(matchPackage.authorization_id),
  ]);
  const queued: GateCOfflineQueuedCommand = {
    authorization_id: matchPackage.authorization_id,
    match_id: matchPackage.match_id,
    local_sequence: commands.length + 1,
    writer_generation: matchPackage.writer_generation,
    enqueued_at: new Date(now).toISOString(),
    command: {
      kind: "finalisation",
      client_event_id: command.clientEventId,
      expected_sequence: matchPackage.last_acknowledged_sequence + pendingCommands.length,
      occurred_at: command.occurredAt,
    },
  };
  await repository.enqueue(queued, now);
  return projectedSession(matchPackage, [...pendingCommands, queued]);
}

export async function recoverOfflineScoringSession(
  repository: OfflineScoringRepository,
): Promise<{ matchPackage: GateCOfflineMatchPackage; session: ScoringSessionView; pendingCount: number } | null> {
  const matchPackage = await repository.getRecoverableMatchPackage();
  if (!matchPackage) return null;
  const [commands, acknowledgements, pending] = await Promise.all([
    repository.listCommands(matchPackage.authorization_id),
    repository.listAcknowledgements(matchPackage.authorization_id),
    repository.listPendingCommands(matchPackage.authorization_id),
  ]);
  assertOfflineQueueIntegrity(matchPackage, commands, acknowledgements);
  const acknowledgementByLocalSequence = new Map(
    acknowledgements.map((acknowledgement) => [acknowledgement.local_sequence, acknowledgement]),
  );
  const authoritativeThroughSequence = matchPackage.authoritative_events.at(-1)?.sequence ?? 0;
  const unpromotedCommands = commands.filter((command) => {
    const acknowledgement = acknowledgementByLocalSequence.get(command.local_sequence);
    return !acknowledgement || acknowledgement.aggregate_version > authoritativeThroughSequence;
  });
  return {
    matchPackage,
    session: projectedSession(matchPackage, unpromotedCommands, acknowledgements),
    pendingCount: pending.length,
  };
}
