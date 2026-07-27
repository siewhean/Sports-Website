"use client";

import {
  phase2Copy,
  phase2Machine,
  type ScoringAccessInput,
  type ScoringAppendReceipt,
  type ScoringCommandPort,
  type ScoringEventCommand,
  type ScoringSessionView,
} from "./phase2";

type ApiSessionState = {
  competition: { slug: string };
  match: {
    id: string;
    code: string;
    stage: string;
    home: { id: string | null; name: string | null };
    away: { id: string | null; name: string | null };
  };
  access: {
    mode: "writer" | "candidate" | "viewer" | "transferred";
    permissions: string[];
    generation: number | null;
    lease_expires_at: string | null;
    expires_at: string;
    read_only: boolean;
    takeover_status: "none" | "pending" | "approved" | "denied";
  };
  score: { home: number; away: number };
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
};

export class ScoringTransportError extends Error {
  constructor(
    public readonly state: "access" | "conflict" | "expired" | "rate_limited" | "revoked" | "unavailable",
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(state);
    this.name = "ScoringTransportError";
  }
}

async function responsePayload<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    const state =
      payload?.error === "conflict" ||
      payload?.error === "expired" ||
      payload?.error === "rate_limited" ||
      payload?.error === "revoked"
        ? payload.error
        : response.status === 400 || response.status === 401 || response.status === 403
          ? "access"
          : "unavailable";
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ScoringTransportError(state, Number.isFinite(retryAfter) ? retryAfter : null);
  }
  return response.json() as Promise<T>;
}

function manualSeconds(value: string): number {
  const [minutes = "0", seconds = "0"] = value.split(":");
  return Math.max(0, Math.min(3599, Number(minutes) * 60 + Number(seconds)));
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

function sessionView(state: ApiSessionState): ScoringSessionView {
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
        matchId: state.match.id,
        eventType: type,
        ...(event.team_slot ? { team: event.team_slot } : {}),
        scorer: event.scorer ?? "",
        period: event.manual_period ?? 1,
        manualTime: manualClock(event.manual_event_seconds),
      },
    ];
  });
  return {
    competitionSlug: state.competition.slug,
    matchId: state.match.id,
    matchLabel: state.match.code,
    stage: state.match.stage,
    home: state.match.home.name ?? "TBD",
    away: state.match.away.name ?? "TBD",
    homeScore: state.score.home,
    awayScore: state.score.away,
    events,
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

function appendBody(command: ScoringEventCommand): Record<string, unknown> {
  const base = {
    client_event_id: command.clientEventId,
    team_slot: command.team,
    scorer: command.scorer,
    manual_period: command.period,
    manual_event_seconds: manualSeconds(command.manualTime),
    occurred_at: new Date().toISOString(),
  };
  if (command.eventType === phase2Machine.matchStarted) {
    return {
      client_event_id: command.clientEventId,
      type: phase2Machine.matchStarted,
      manual_period: command.period,
      manual_event_seconds: manualSeconds(command.manualTime),
      payload: {},
      occurred_at: new Date().toISOString(),
    };
  }
  if (command.eventType === phase2Machine.goal) return { ...base, type: "goal_added", payload: {} };
  if (command.eventType === phase2Machine.timeout) return { ...base, type: "timeout_added", payload: {} };
  if (command.eventType === phase2Machine.incident)
    return { ...base, type: "incident_added", payload: { note: command.scorer } };
  const colour =
    command.eventType === phase2Machine.greenCard
      ? "green"
      : command.eventType === phase2Machine.yellowCard
        ? "yellow"
        : "red";
  return { ...base, type: "card_added", payload: { person_id: command.scorer, colour } };
}

class ApiScoringCommandPort implements ScoringCommandPort {
  async exchangeAccess(input: ScoringAccessInput): Promise<ScoringSessionView> {
    const response = await fetch("/api/scoring/access/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        input.token
          ? { token: input.token, deviceId: input.device.id, deviceLabel: input.device.label }
          : { shortCode: input.shortCode, deviceId: input.device.id, deviceLabel: input.device.label },
      ),
      credentials: "same-origin",
    });
    return sessionView(await responsePayload<ApiSessionState>(response));
  }

  async recoverSession(): Promise<ScoringSessionView | null> {
    const response = await fetch("/api/scoring/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 204 || response.status === 401) return null;
    return sessionView(await responsePayload<ApiSessionState>(response));
  }

  async heartbeat(input: {
    lastAcknowledgedSequence: number;
    pendingEventCount: number;
    pendingThroughSequence: number | null;
  }): Promise<ScoringSessionView> {
    const response = await fetch("/api/scoring/session/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastAcknowledgedSequence: input.lastAcknowledgedSequence,
        pendingEventCount: input.pendingEventCount,
        pendingThroughSequence: input.pendingThroughSequence,
      }),
      credentials: "same-origin",
    });
    return sessionView(await responsePayload<ApiSessionState>(response));
  }

  async requestTakeover(input: {
    pendingEventCount: number;
    pendingThroughSequence: number | null;
  }): Promise<{ status: "pending"; requestId: string }> {
    const response = await fetch("/api/scoring/takeover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      credentials: "same-origin",
    });
    return responsePayload<{ status: "pending"; requestId: string }>(response);
  }

  async appendEvent(command: ScoringEventCommand): Promise<ScoringAppendReceipt> {
    const response = await fetch("/api/scoring/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(appendBody(command)),
      credentials: "same-origin",
    });
    const receipt = await responsePayload<{ sequence: number }>(response);
    return { clientEventId: command.clientEventId, sequence: receipt.sequence, syncState: "acknowledged" };
  }

  async finalizeResult(command: { matchId: string }): Promise<{ receiptId: string; publishedAt: string }> {
    const clientEventId = crypto.randomUUID();
    const response = await fetch("/api/scoring/finalise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_event_id: clientEventId }),
      credentials: "same-origin",
    });
    const receipt = await responsePayload<{ match_id?: string; result_version?: number }>(response);
    return {
      receiptId: `${receipt.match_id ?? command.matchId}:v${receipt.result_version ?? 0}`,
      publishedAt: new Date().toISOString(),
    };
  }
}

const demoSession: ScoringSessionView = {
  competitionSlug: phase2Machine.singaporeOpenSlug,
  matchId: phase2Machine.matchTwelveId,
  matchLabel: phase2Copy.matchTwelve,
  stage: phase2Copy.groupB,
  home: phase2Copy.marinaBlue,
  away: phase2Copy.harbourGold,
  homeScore: 0,
  awayScore: 0,
  events: [],
  throughSequence: 0,
  mode: "writer",
  permissions: ["score:read", "score:write", "score:reverse", "score:finalise"],
  generation: 1,
  leaseExpiresAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-01T00:30:00.000Z",
  takeoverStatus: "none",
  readOnly: false,
};

class DemoScoringCommandPort implements ScoringCommandPort {
  private active = false;
  private sequence = 0;

  async exchangeAccess(input: ScoringAccessInput): Promise<ScoringSessionView> {
    const accepted =
      input.shortCode?.trim().toUpperCase() === "POLO-12" ||
      input.token === "demo-phase2-scoring-access-token-000000000001";
    if (!accepted) throw new ScoringTransportError("access");
    this.active = true;
    return demoSession;
  }

  async recoverSession(): Promise<ScoringSessionView | null> {
    return this.active ? demoSession : null;
  }

  async heartbeat(): Promise<ScoringSessionView> {
    return demoSession;
  }

  async requestTakeover(): Promise<{ status: "pending"; requestId: string }> {
    return { status: "pending", requestId: crypto.randomUUID() };
  }

  async appendEvent(command: ScoringEventCommand): Promise<ScoringAppendReceipt> {
    this.sequence += 1;
    return { clientEventId: command.clientEventId, sequence: this.sequence, syncState: "pending" };
  }

  async finalizeResult(): Promise<{ receiptId: string; publishedAt: string }> {
    return { receiptId: "R-2026-09-12-M12-04", publishedAt: "10:24 SGT" };
  }
}

export function createScoringCommandPort(mode: "api" | "demo"): ScoringCommandPort {
  return mode === "demo" ? new DemoScoringCommandPort() : new ApiScoringCommandPort();
}
