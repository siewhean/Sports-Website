"use client";

import {
  SPORT_PACKS,
  reduceFiveSportScoreEvents,
  type FiveSportScoreEvent,
  type SportId,
  type SportPackSettings,
} from "@matchday/domain";
import type { GateCOfflineCanonicalCommand } from "@matchday/contracts";
import {
  phase2Copy,
  phase2Machine,
  type ScoringAccessInput,
  type ScoringAppendReceipt,
  type ScoringCommandPort,
  type ScoringEventCommand,
  type ScoringSessionView,
} from "./phase2";

export type ApiSessionState = {
  competition: { slug: string; sport_code: SportId };
  sport: { pack_version: string; settings: SportPackSettings };
  match: {
    id: string;
    code: string;
    stage: string;
    home: { id: string | null; name: string | null };
    away: { id: string | null; name: string | null };
  };
  access: {
    principal_id: string;
    mode: "writer" | "candidate" | "viewer" | "transferred";
    permissions: string[];
    generation: number | null;
    lease_expires_at: string | null;
    expires_at: string;
    read_only: boolean;
    takeover_status: "none" | "pending" | "approved" | "denied";
  };
  score: {
    home: number;
    away: number;
    lifecycle: "not_started" | "in_progress" | "finalised";
    current_segment: number;
    total_points: { home: number; away: number };
    segment_wins: { home: number; away: number };
    segments: Array<{
      number: number;
      home: number;
      away: number;
      completed: boolean;
      winner: "home" | "away" | null;
    }>;
    actions: Array<{
      event_id: string;
      client_event_id: string;
      event_type: string;
      label: string;
      side: "home" | "away" | null;
      participant_id: string | null;
      segment_number: number;
      score_delta: number;
      occurred_at: string;
      reversed: boolean;
      reversible: boolean;
    }>;
    conflicts: Array<{ code: string; segment_number: number; target_event_id: string }>;
  };
  through_sequence: number;
  events: Array<{
    client_event_id: string;
    type: string;
    team_slot: "home" | "away" | null;
    scorer: string | null;
    manual_period: number | null;
    manual_event_seconds: number | null;
    payload: Record<string, unknown>;
  }>;
  canonical_events?: Array<{
    event_id: string;
    sequence: number;
    command: GateCOfflineCanonicalCommand;
  }>;
};

export class ScoringTransportError extends Error {
  constructor(
    public readonly state: "access" | "conflict" | "expired" | "invalid" | "rate_limited" | "revoked" | "unavailable",
    public readonly retryAfterSeconds: number | null = null,
    public readonly code: string | null = null,
    public readonly currentSequence: number | null = null,
    public readonly currentAggregateVersion: number | null = null,
  ) {
    super(state);
    this.name = "ScoringTransportError";
  }
}

export function scoringMutationIsLocked(input: {
  writerState: string;
  offlineState: string;
  hasOfflineAuthorization: boolean;
  pendingCount: number;
  queueLimit: number;
}): boolean {
  const offlineRecordingCanWrite =
    input.hasOfflineAuthorization &&
    (input.offlineState === "offline-recording" || input.offlineState === "pending-sync");
  const terminalOrTransitionState = new Set([
    "preparing",
    "reconnecting",
    "replaying",
    "pending-finalisation",
    "conflict",
    "expired",
    "revoked",
    "read-only",
    "storage-error",
  ]).has(input.offlineState);
  return (
    (!offlineRecordingCanWrite && input.writerState !== "active") ||
    terminalOrTransitionState ||
    input.pendingCount >= input.queueLimit
  );
}

export function terminalOfflineQueueState(detail: string): "expired" | "revoked" | "read-only" | null {
  const availability = /^Offline scoring cannot accept another command: ([a-z_]+)\.$/u.exec(detail)?.[1];
  if (["recording_expired", "replay_expired", "pass_expired", "expired"].includes(availability ?? "")) {
    return "expired";
  }
  if (availability === "revoked") return "revoked";
  if (availability === "transferred" || availability === "completed") return "read-only";
  return null;
}

export function recoveredOfflineState(input: {
  status: "active" | "expired" | "revoked" | "transferred" | "completed";
  recordingExpiresAt: string;
  replayExpiresAt: string;
  passExpiresAt: string;
  pendingCount: number;
  now?: number;
}): "offline-recording" | "pending-sync" | "expired" | "revoked" | "read-only" {
  if (input.status === "transferred" || input.status === "completed") return "read-only";
  if (input.status === "revoked") return "revoked";
  const now = input.now ?? Date.now();
  if (
    input.status === "expired" ||
    now >= Date.parse(input.recordingExpiresAt) ||
    now >= Date.parse(input.replayExpiresAt) ||
    now >= Date.parse(input.passExpiresAt)
  ) {
    return "expired";
  }
  return input.pendingCount > 0 ? "pending-sync" : "offline-recording";
}

async function responsePayload<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
      current_sequence?: number;
      current_aggregate_version?: number;
    } | null;
    const state =
      payload?.error === "conflict" ||
      payload?.error === "expired" ||
      payload?.error === "invalid" ||
      payload?.error === "rate_limited" ||
      payload?.error === "revoked"
        ? payload.error
        : response.status === 400 || response.status === 401 || response.status === 403
          ? "access"
          : "unavailable";
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    throw new ScoringTransportError(
      state,
      Number.isFinite(retryAfter) ? retryAfter : null,
      typeof payload?.code === "string" ? payload.code : null,
      Number.isSafeInteger(payload?.current_sequence) ? Number(payload?.current_sequence) : null,
      Number.isSafeInteger(payload?.current_aggregate_version) ? Number(payload?.current_aggregate_version) : null,
    );
  }
  return response.json() as Promise<T>;
}

async function scoringFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof ScoringTransportError) throw error;
    throw new ScoringTransportError("unavailable");
  }
}

function manualClock(value: number | null): string {
  const seconds = value ?? 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function eventType(event: ApiSessionState["events"][number]): string | null {
  if (event.type === "goal_added") return phase2Machine.goal;
  if (event.type === "timeout_added") return phase2Machine.timeout;
  if (event.type === "incident_added") return phase2Machine.incident;
  if (event.type === "card_added") {
    const colour = String(event.payload.colour ?? "");
    return colour === "green"
      ? phase2Machine.greenCard
      : colour === "yellow"
        ? phase2Machine.yellowCard
        : phase2Machine.redCard;
  }
  return null;
}

export function scoringSessionView(state: ApiSessionState): ScoringSessionView {
  if (state.sport.pack_version !== SPORT_PACKS[state.competition.sport_code].version) {
    throw new ScoringTransportError("unavailable");
  }
  const reversed = new Set(
    state.events
      .filter((event) => event.type === "goal_reversed" || event.type === "card_reversed")
      .map((event) => String(event.payload.reversal_target_event_id ?? "")),
  );
  const events = state.events.flatMap((event): ScoringEventCommand[] => {
    const type = eventType(event);
    if (!type || reversed.has(event.client_event_id)) return [];
    return [
      {
        clientEventId: event.client_event_id,
        expectedSequence: state.through_sequence,
        matchId: state.match.id,
        eventType: type,
        canonical: true,
        ...(event.team_slot ? { team: event.team_slot } : {}),
        scorer: event.scorer ?? "",
        period: event.manual_period ?? 1,
        manualTime: manualClock(event.manual_event_seconds),
      },
    ];
  });
  return {
    principalId: state.access.principal_id,
    competitionSlug: state.competition.slug,
    sportId: state.competition.sport_code,
    sportPackVersion: state.sport.pack_version,
    sportSettings: state.sport.settings,
    matchId: state.match.id,
    matchLabel: state.match.code,
    stage: state.match.stage,
    home: state.match.home.name ?? "TBD",
    away: state.match.away.name ?? "TBD",
    homeScore: state.score.home,
    awayScore: state.score.away,
    scoreState: {
      home: state.score.home,
      away: state.score.away,
      lifecycle: state.score.lifecycle,
      currentSegment: state.score.current_segment,
      totalPoints: state.score.total_points,
      segmentWins: state.score.segment_wins,
      segments: state.score.segments,
      actions: state.score.actions.map((action) => ({
        eventId: action.event_id,
        clientEventId: action.client_event_id,
        eventType: action.event_type,
        label: action.label,
        side: action.side,
        participantId: action.participant_id,
        segmentNumber: action.segment_number,
        scoreDelta: action.score_delta,
        occurredAt: action.occurred_at,
        reversed: action.reversed,
        reversible: action.reversible,
      })),
      conflicts: state.score.conflicts.map((conflict) => ({
        code: conflict.code,
        segmentNumber: conflict.segment_number,
        targetEventId: conflict.target_event_id,
      })),
    },
    events,
    canonicalEvents: (state.canonical_events ?? []).map((event) => ({
      eventId: event.event_id,
      sequence: event.sequence,
      command: event.command,
    })),
    throughSequence: state.through_sequence,
    mode: state.access.mode,
    permissions: state.access.permissions,
    generation: state.access.generation,
    leaseExpiresAt: state.access.lease_expires_at,
    expiresAt: state.access.expires_at,
    takeoverStatus: state.access.takeover_status,
    readOnly:
      state.access.read_only || state.access.mode !== "writer" || !state.access.permissions.includes("score:write"),
  };
}

export type ScoringWriterAvailability = "active" | "expiring" | "expired";

export function scoringWriterAvailability(
  session: Pick<ScoringSessionView, "expiresAt" | "leaseExpiresAt" | "mode" | "readOnly">,
  now: number = Date.now(),
): ScoringWriterAvailability {
  const sessionExpiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= now) return "expired";
  if (session.mode !== "writer") return "active";
  const leaseExpiresAt = session.leaseExpiresAt ? Date.parse(session.leaseExpiresAt) : Number.NaN;
  return session.readOnly || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now + 15_000 ? "expiring" : "active";
}

export function scoringSessionAnnouncement(session: ScoringSessionView, now: number = Date.now()): string {
  if (session.mode === phase2Machine.writer) {
    const availability = scoringWriterAvailability(session, now);
    return availability === phase2Machine.active
      ? phase2Copy.accessRestored
      : availability === phase2Machine.expiring
        ? phase2Copy.leaseExpiring
        : phase2Copy.sessionExpired;
  }
  if (session.mode === phase2Machine.candidate) return phase2Copy.candidate;
  if (session.mode === phase2Machine.transferred) return phase2Copy.transferred;
  return phase2Copy.readOnly;
}

export function canonicalSegmentNumber(eventType: string, currentSegment: number, selectedSegment: number): number {
  return eventType === phase2Machine.overtime ? currentSegment + 1 : selectedSegment;
}

function appendBody(command: ScoringEventCommand): Record<string, unknown> {
  if (!command.canonical || !Number.isSafeInteger(command.expectedSequence) || Number(command.expectedSequence) < 0) {
    throw new ScoringTransportError("unavailable");
  }
  return {
    client_event_id: command.clientEventId,
    expected_sequence: command.expectedSequence,
    type: command.eventType,
    occurred_at: command.occurredAt ?? new Date().toISOString(),
    ...(command.team ? { team_slot: command.team } : {}),
    ...(typeof command.participantId === "string" ? { participant_id: command.participantId } : {}),
    ...(command.unknownParticipant !== undefined ? { unknown_participant: command.unknownParticipant } : {}),
    ...(command.segmentNumber !== undefined ? { segment_number: command.segmentNumber } : {}),
    ...(command.manualTimeSeconds !== undefined ? { manual_time_seconds: command.manualTimeSeconds } : {}),
    ...(command.reversalTargetEventId ? { reversal_target_event_id: command.reversalTargetEventId } : {}),
    ...(command.reason ? { reason: command.reason } : {}),
  };
}

class ApiScoringCommandPort implements ScoringCommandPort {
  async exchangeAccess(input: ScoringAccessInput): Promise<ScoringSessionView> {
    const response = await scoringFetch("/api/scoring/access/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        input.token
          ? { token: input.token, deviceId: input.device.id, deviceLabel: input.device.label }
          : { shortCode: input.shortCode, deviceId: input.device.id, deviceLabel: input.device.label },
      ),
      credentials: "same-origin",
    });
    return scoringSessionView(await responsePayload<ApiSessionState>(response));
  }

  async recoverSession(signal?: AbortSignal): Promise<ScoringSessionView | null> {
    const response = await scoringFetch("/api/scoring/session", {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (response.status === 204 || response.status === 401) return null;
    return scoringSessionView(await responsePayload<ApiSessionState>(response));
  }

  async heartbeat(
    input: {
      lastAcknowledgedSequence: number;
      pendingEventCount: number;
      pendingThroughSequence: number | null;
    },
    signal?: AbortSignal,
  ): Promise<ScoringSessionView> {
    const response = await scoringFetch("/api/scoring/session/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastAcknowledgedSequence: input.lastAcknowledgedSequence,
        pendingEventCount: input.pendingEventCount,
        pendingThroughSequence: input.pendingThroughSequence,
      }),
      credentials: "same-origin",
      signal,
    });
    return scoringSessionView(await responsePayload<ApiSessionState>(response));
  }

  async requestTakeover(input: {
    pendingEventCount: number;
    pendingThroughSequence: number | null;
  }): Promise<{ status: "pending"; requestId: string }> {
    const response = await scoringFetch("/api/scoring/takeover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      credentials: "same-origin",
    });
    return responsePayload<{ status: "pending"; requestId: string }>(response);
  }

  async appendEvent(command: ScoringEventCommand): Promise<ScoringAppendReceipt> {
    const response = await scoringFetch("/api/scoring/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(appendBody(command)),
      credentials: "same-origin",
    });
    const receipt = await responsePayload<{
      client_event_id: string;
      event_id: string;
      command_fingerprint: string;
      duplicate: boolean;
      sequence: number;
      aggregate_version: number;
      server_received_at: string;
    }>(response);
    return {
      clientEventId: receipt.client_event_id,
      eventId: receipt.event_id,
      commandFingerprint: receipt.command_fingerprint,
      duplicate: receipt.duplicate,
      sequence: receipt.sequence,
      aggregateVersion: receipt.aggregate_version,
      serverReceivedAt: receipt.server_received_at,
      syncState: "acknowledged",
    };
  }

  async finalizeResult(command: {
    clientEventId: string;
    matchId: string;
    expectedSequence: number;
    occurredAt: string;
  }) {
    const response = await scoringFetch("/api/scoring/finalise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_event_id: command.clientEventId,
        expected_sequence: command.expectedSequence,
        occurred_at: command.occurredAt,
      }),
      credentials: "same-origin",
    });
    const receipt = await responsePayload<{
      client_event_id: string;
      event_id: string;
      command_fingerprint: string;
      duplicate: boolean;
      match_id: string;
      sequence: number;
      aggregate_version: number;
      result_version: number;
      publication_version: number;
      server_received_at: string;
      published_at: string;
    }>(response);
    return {
      clientEventId: receipt.client_event_id,
      eventId: receipt.event_id,
      commandFingerprint: receipt.command_fingerprint,
      duplicate: receipt.duplicate,
      sequence: receipt.sequence,
      aggregateVersion: receipt.aggregate_version,
      serverReceivedAt: receipt.server_received_at,
      syncState: "acknowledged" as const,
      receiptId: `${receipt.match_id}:v${receipt.result_version}`,
      matchId: receipt.match_id,
      resultVersion: receipt.result_version,
      publicationVersion: receipt.publication_version,
      publishedAt: receipt.published_at,
    };
  }
}

export async function refreshScoringSessionAccess(
  port: Pick<ScoringCommandPort, "heartbeat" | "recoverSession">,
  input: {
    lastAcknowledgedSequence: number;
    pendingEventCount: number;
    pendingThroughSequence: number | null;
  },
  recoverAuthoritatively: boolean,
  signal?: AbortSignal,
): Promise<ScoringSessionView | null> {
  if (recoverAuthoritatively) {
    const recovered = await port.recoverSession(signal);
    if (!recovered || recovered.mode !== "writer" || recovered.readOnly) return recovered;
  }
  return port.heartbeat(input, signal);
}

class DemoScoringCommandPort implements ScoringCommandPort {
  private active = false;
  private sequence = 0;
  private readonly canonicalEvents: FiveSportScoreEvent[] = [];

  constructor(private readonly sportId: SportId) {}

  private session(): ScoringSessionView {
    const pack = SPORT_PACKS[this.sportId];
    const reduced = reduceFiveSportScoreEvents(this.sportId, this.canonicalEvents, pack.recommendedSettings);
    return {
      principalId: "d".repeat(64),
      competitionSlug: phase2Machine.singaporeOpenSlug,
      sportId: this.sportId,
      sportPackVersion: pack.version,
      sportSettings: pack.recommendedSettings,
      matchId: phase2Machine.matchTwelveId,
      matchLabel: phase2Copy.matchTwelve,
      stage: phase2Copy.groupB,
      home: phase2Copy.marinaBlue,
      away: phase2Copy.harbourGold,
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
          reversible: pack.eventTypes.find((event) => event.id === action.eventType)?.reversable ?? false,
        })),
        conflicts: reduced.conflicts.map((conflict) => ({
          code: conflict.code,
          segmentNumber: conflict.segmentNumber,
          targetEventId: conflict.targetEventId,
        })),
      },
      events: [],
      canonicalEvents: [],
      throughSequence: this.sequence,
      mode: "writer",
      permissions: ["score:read", "score:write", "score:reverse", "score:finalise"],
      generation: 1,
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:30:00.000Z",
      takeoverStatus: "none",
      readOnly: false,
    };
  }

  async exchangeAccess(input: ScoringAccessInput): Promise<ScoringSessionView> {
    const accepted =
      input.shortCode?.trim().toUpperCase() === "POLO-12" ||
      input.token === "demo-phase2-scoring-access-token-000000000001";
    if (!accepted) throw new ScoringTransportError("access");
    this.active = true;
    return this.session();
  }

  async recoverSession(): Promise<ScoringSessionView | null> {
    return this.active ? this.session() : null;
  }

  async heartbeat(): Promise<ScoringSessionView> {
    return this.session();
  }

  async requestTakeover(): Promise<{ status: "pending"; requestId: string }> {
    return { status: "pending", requestId: crypto.randomUUID() };
  }

  async appendEvent(command: ScoringEventCommand): Promise<ScoringAppendReceipt> {
    this.sequence += 1;
    this.canonicalEvents.push({
      eventId: command.clientEventId,
      clientEventId: command.clientEventId,
      matchId: command.matchId,
      sequence: this.sequence,
      actorId: "00000000-0000-4000-8000-000000000201",
      scoringSessionId: "00000000-0000-4000-8000-000000000202",
      occurredAt: command.occurredAt ?? new Date().toISOString(),
      type: command.eventType,
      ...(command.team ? { side: command.team } : {}),
      ...(command.participantId !== undefined ? { participantId: command.participantId } : {}),
      ...(command.unknownParticipant !== undefined ? { unknownParticipant: command.unknownParticipant } : {}),
      ...(command.segmentNumber !== undefined ? { segmentNumber: command.segmentNumber } : {}),
      ...(command.manualTimeSeconds !== undefined ? { manualTimeSeconds: command.manualTimeSeconds } : {}),
      ...(command.reversalTargetEventId ? { reversalTargetEventId: command.reversalTargetEventId } : {}),
      ...(command.reason ? { reason: command.reason } : {}),
    });
    try {
      reduceFiveSportScoreEvents(this.sportId, this.canonicalEvents, SPORT_PACKS[this.sportId].recommendedSettings);
    } catch (error) {
      this.canonicalEvents.pop();
      this.sequence -= 1;
      throw error;
    }
    return {
      clientEventId: command.clientEventId,
      eventId: command.clientEventId,
      commandFingerprint: "0".repeat(64),
      duplicate: false,
      sequence: this.sequence,
      aggregateVersion: this.sequence,
      serverReceivedAt: command.occurredAt ?? new Date().toISOString(),
      syncState: "pending",
    };
  }

  async finalizeResult(command: { clientEventId: string; matchId: string; occurredAt: string }) {
    return {
      clientEventId: command.clientEventId,
      eventId: command.clientEventId,
      commandFingerprint: "0".repeat(64),
      duplicate: false,
      sequence: this.sequence + 1,
      aggregateVersion: this.sequence + 1,
      serverReceivedAt: command.occurredAt,
      syncState: "pending" as const,
      receiptId: "R-2026-09-12-M12-04",
      matchId: command.matchId,
      resultVersion: 1,
      publicationVersion: 1,
      publishedAt: "10:24 SGT",
    };
  }
}

export function createScoringCommandPort(
  mode: "api" | "demo",
  demoSportId: SportId = "canoe_polo",
): ScoringCommandPort {
  return mode === "demo" ? new DemoScoringCommandPort(demoSportId) : new ApiScoringCommandPort();
}
