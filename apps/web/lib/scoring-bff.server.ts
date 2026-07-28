import { SPORT_PACKS, parseFiveSportScoreCommand, validateSportSettings, type SportId } from "@matchday/domain";
import {
  expiredScoringSessionCookie,
  InvalidScoringSessionError,
  scoringSessionCookie,
  scoringSessionCookieName,
  ScoringSessionSealer,
  type ScoringServerAuth,
} from "./scoring-session.server";
import { isScoringAccessToken } from "./scoring-access";
import {
  expiredOfflineGrantCookie,
  InvalidOfflineGrantError,
  OfflineGrantSealer,
  offlineGrantCookie,
  offlineGrantCookieName,
} from "./offline-grant.server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type SafeError = "access" | "conflict" | "expired" | "invalid" | "rate_limited" | "revoked" | "unavailable";
const EXPOSED_ERROR_CODES = new Set([
  "ACCESS_EXPIRED",
  "ACCESS_RATE_LIMITED",
  "ACCESS_REVOKED",
  "FINALISATION_INVALID",
  "IDEMPOTENCY_KEY_REUSED",
  "MATCH_FINALISED_READ_ONLY",
  "OFFLINE_AUTHORIZATION_EXPIRED",
  "OFFLINE_AUTHORIZATION_REVOKED",
  "OFFLINE_AUTHORIZATION_TRANSFERRED",
  "OFFLINE_RECORDING_EXPIRED",
  "SCORE_EVENT_INVALID",
  "SCORE_EVENT_REJECTED",
  "SCORE_VERSION_CONFLICT",
  "SCORING_PERMISSION_DENIED",
  "SCORING_SESSION_EXPIRED",
  "SCORING_SESSION_REVOKED",
  "STALE_WRITER_GENERATION",
]);

function jsonResponse(payload: unknown, status: number, cookie?: string): Response {
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    pragma: "no-cache",
    vary: "Cookie",
    "x-content-type-options": "nosniff",
  });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(payload), { status, headers });
}

function safeError(
  status: number,
  clearCookie = false,
  explicitState?: SafeError,
  sourceHeaders?: Headers,
  machine?: { code?: string; current_sequence?: number; current_aggregate_version?: number },
): Response {
  const state: SafeError =
    explicitState ??
    (status === 409
      ? "conflict"
      : status === 410
        ? "expired"
        : status === 429
          ? "rate_limited"
          : status === 422
            ? "invalid"
            : [400, 401, 403].includes(status)
              ? "access"
              : "unavailable");
  const response = jsonResponse(
    {
      error: state,
      ...(machine?.code && EXPOSED_ERROR_CODES.has(machine.code) ? { code: machine.code } : {}),
      ...(Number.isSafeInteger(machine?.current_sequence) ? { current_sequence: machine?.current_sequence } : {}),
      ...(Number.isSafeInteger(machine?.current_aggregate_version)
        ? { current_aggregate_version: machine?.current_aggregate_version }
        : {}),
    },
    status,
    clearCookie ? expiredScoringSessionCookie() : undefined,
  );
  for (const name of ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "retry-after"]) {
    const value = sourceHeaders?.get(name);
    if (value) response.headers.set(name, value);
  }
  return response;
}

function exposedStatus(status: number): number {
  return [400, 401, 403, 409, 410, 422, 429].includes(status) ? status : 503;
}

function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || fetchSite !== "same-origin") return false;
  try {
    const browserOrigin = new URL(origin);
    if (browserOrigin.origin === new URL(request.url).origin) return true;
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const forwardedHost = request.headers.get("x-forwarded-host");
    if (
      !forwardedProto ||
      !forwardedHost ||
      forwardedProto !== forwardedProto.trim() ||
      forwardedHost !== forwardedHost.trim() ||
      !/^(?:http|https)$/.test(forwardedProto) ||
      forwardedHost.length > 253 ||
      !/^[A-Za-z0-9.:[\]-]+$/.test(forwardedHost)
    ) {
      return false;
    }
    const forwardedOrigin = new URL(`${forwardedProto}://${forwardedHost}`);
    return (
      !forwardedOrigin.username &&
      !forwardedOrigin.password &&
      forwardedOrigin.pathname === "/" &&
      !forwardedOrigin.search &&
      !forwardedOrigin.hash &&
      browserOrigin.origin === forwardedOrigin.origin
    );
  } catch {
    return false;
  }
}

function withCookie(response: Response, cookie: string): Response {
  response.headers.append("set-cookie", cookie);
  return response;
}

function apiBaseUrl(): URL | null {
  const configured = process.env.MATCHDAY_API_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

function sealer(): ScoringSessionSealer | null {
  const key = process.env.SCORING_SESSION_SEAL_KEY?.trim();
  if (!key) return null;
  try {
    return new ScoringSessionSealer(key);
  } catch {
    return null;
  }
}

function offlineSealer(): OfflineGrantSealer | null {
  const key = process.env.SCORING_SESSION_SEAL_KEY?.trim();
  if (!key) return null;
  try {
    return new OfflineGrantSealer(key);
  } catch {
    return null;
  }
}

function namedCookieValue(request: Request, cookieName: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== cookieName) continue;
    const value = valueParts.join("=");
    return value && value.length <= 4_096 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  }
  return null;
}

function cookieValue(request: Request): string | null {
  return namedCookieValue(request, scoringSessionCookieName);
}

function authHeaders(auth: ScoringServerAuth): Headers {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "x-scoring-session-id": auth.sessionId,
    "x-scoring-session-token": auth.sessionToken,
  });
  if (auth.generation !== null) headers.set("x-writer-generation", String(auth.generation));
  return headers;
}

function authenticatedRequest(request: Request): { auth: ScoringServerAuth; baseUrl: URL } | { response: Response } {
  const baseUrl = apiBaseUrl();
  const sessionSealer = sealer();
  if (!baseUrl || !sessionSealer) return { response: safeError(503) };
  const sealed = cookieValue(request);
  if (!sealed) return { response: safeError(401) };
  try {
    return { auth: sessionSealer.open(sealed), baseUrl };
  } catch (error) {
    if (error instanceof InvalidScoringSessionError) return { response: safeError(401, true) };
    return { response: safeError(503, true) };
  }
}

async function readJson(response: Response): Promise<unknown | null> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, maximum = 500): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function nullableString(value: unknown, maximum = 500): string | null | undefined {
  return value === null ? null : (stringValue(value, maximum) ?? undefined);
}

function eventPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["reversal_target_event_id", "person_id", "colour", "note"] as const) {
    const item = stringValue(source[key]);
    if (item !== null) result[key] = item;
  }
  return result;
}

function canonicalOfflineEvents(value: unknown): Array<Record<string, unknown>> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result: Array<Record<string, unknown>> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const source = raw as Record<string, unknown>;
    const eventId = source.event_id;
    const sequence = source.sequence;
    const rawCommand =
      source.command && typeof source.command === "object" && !Array.isArray(source.command) ? source.command : source;
    if (typeof eventId !== "string" || !UUID_PATTERN.test(eventId) || !safeInteger(sequence, 1)) {
      return null;
    }
    if ((rawCommand as Record<string, unknown>).kind === "finalisation") {
      const finalisation = rawCommand as Record<string, unknown>;
      if (
        typeof finalisation.client_event_id !== "string" ||
        !UUID_PATTERN.test(finalisation.client_event_id) ||
        !safeInteger(finalisation.expected_sequence) ||
        finalisation.expected_sequence !== Number(sequence) - 1 ||
        typeof finalisation.occurred_at !== "string" ||
        !Number.isFinite(Date.parse(finalisation.occurred_at))
      ) {
        return null;
      }
      result.push({
        event_id: eventId,
        sequence,
        command: {
          kind: "finalisation",
          client_event_id: finalisation.client_event_id,
          expected_sequence: finalisation.expected_sequence,
          occurred_at: finalisation.occurred_at,
        },
      });
      continue;
    }
    const command = parseFiveSportScoreCommand(rawCommand);
    if (!command) return null;
    result.push({
      event_id: eventId,
      sequence,
      command: {
        kind: command.type === "finalisation" ? "finalisation" : "event",
        client_event_id: command.clientEventId,
        expected_sequence: Number(sequence) - 1,
        occurred_at: command.occurredAt,
        ...(command.type === "finalisation"
          ? {}
          : {
              type: command.type,
              ...(command.side ? { team_slot: command.side } : {}),
              ...(command.participantId !== undefined ? { participant_id: command.participantId } : {}),
              ...(command.unknownParticipant !== undefined ? { unknown_participant: command.unknownParticipant } : {}),
              ...(command.segmentNumber !== undefined ? { segment_number: command.segmentNumber } : {}),
              ...(command.manualTimeSeconds !== undefined ? { manual_time_seconds: command.manualTimeSeconds } : {}),
              ...(command.reversalTargetEventId ? { reversal_target_event_id: command.reversalTargetEventId } : {}),
              ...(command.reason ? { reason: command.reason } : {}),
            }),
      },
    });
  }
  return result;
}

const SPORT_IDS = new Set<unknown>(Object.keys(SPORT_PACKS));

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function scorePair(value: unknown): { home: number; away: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return safeInteger(source.home) && safeInteger(source.away)
    ? { home: Number(source.home), away: Number(source.away) }
    : null;
}

function canonicalScoreState(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const pair = scorePair(source);
  const totalPoints = scorePair(source.total_points);
  const segmentWins = scorePair(source.segment_wins);
  if (
    !pair ||
    !["not_started", "in_progress", "finalised"].includes(String(source.lifecycle ?? "")) ||
    !safeInteger(source.current_segment, 1) ||
    !totalPoints ||
    !segmentWins ||
    !Array.isArray(source.segments) ||
    !Array.isArray(source.actions) ||
    !Array.isArray(source.conflicts)
  ) {
    return null;
  }
  const segments: Array<Record<string, unknown>> = [];
  for (const raw of source.segments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const segment = raw as Record<string, unknown>;
    if (
      !safeInteger(segment.number, 1) ||
      !safeInteger(segment.home) ||
      !safeInteger(segment.away) ||
      typeof segment.completed !== "boolean" ||
      (segment.winner !== null && segment.winner !== "home" && segment.winner !== "away")
    ) {
      return null;
    }
    segments.push({
      number: segment.number,
      home: segment.home,
      away: segment.away,
      completed: segment.completed,
      winner: segment.winner,
    });
  }
  const actions: Array<Record<string, unknown>> = [];
  for (const raw of source.actions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const action = raw as Record<string, unknown>;
    if (
      !UUID_PATTERN.test(String(action.event_id ?? "")) ||
      !UUID_PATTERN.test(String(action.client_event_id ?? "")) ||
      typeof action.event_type !== "string" ||
      typeof action.label !== "string" ||
      (action.side !== null && action.side !== "home" && action.side !== "away") ||
      (action.participant_id !== null && typeof action.participant_id !== "string") ||
      !safeInteger(action.segment_number, 1) ||
      !safeInteger(action.score_delta) ||
      typeof action.occurred_at !== "string" ||
      !Number.isFinite(Date.parse(action.occurred_at)) ||
      typeof action.reversed !== "boolean" ||
      typeof action.reversible !== "boolean"
    ) {
      return null;
    }
    actions.push({
      event_id: action.event_id,
      client_event_id: action.client_event_id,
      event_type: action.event_type,
      label: action.label,
      side: action.side,
      participant_id: action.participant_id,
      segment_number: action.segment_number,
      score_delta: action.score_delta,
      occurred_at: action.occurred_at,
      reversed: action.reversed,
      reversible: action.reversible,
    });
  }
  const conflicts: Array<Record<string, unknown>> = [];
  for (const raw of source.conflicts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const conflict = raw as Record<string, unknown>;
    if (
      typeof conflict.code !== "string" ||
      !safeInteger(conflict.segment_number, 1) ||
      !UUID_PATTERN.test(String(conflict.target_event_id ?? ""))
    ) {
      return null;
    }
    conflicts.push({
      code: conflict.code,
      segment_number: conflict.segment_number,
      target_event_id: conflict.target_event_id,
    });
  }
  return {
    ...pair,
    lifecycle: source.lifecycle,
    current_segment: source.current_segment,
    total_points: totalPoints,
    segment_wins: segmentWins,
    segments,
    actions,
    conflicts,
  };
}

function scoringState(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const competition = source.competition as Record<string, unknown> | null;
  const match = source.match as Record<string, unknown> | null;
  const access = source.access as Record<string, unknown> | null;
  const writer = source.writer as Record<string, unknown> | null;
  const score = source.score as Record<string, unknown> | null;
  const sport = source.sport as Record<string, unknown> | null;
  const home = match?.home as Record<string, unknown> | null;
  const away = match?.away as Record<string, unknown> | null;
  const canonicalEvents = canonicalOfflineEvents(source.canonical_events);
  if (
    !competition ||
    typeof competition.slug !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(competition.slug) ||
    !SPORT_IDS.has(competition.sport_code) ||
    !sport ||
    typeof sport.pack_version !== "string" ||
    sport.pack_version !== SPORT_PACKS[competition.sport_code as SportId].version ||
    !sport.settings ||
    typeof sport.settings !== "object" ||
    Array.isArray(sport.settings) ||
    validateSportSettings(SPORT_PACKS[competition.sport_code as SportId], sport.settings).length > 0 ||
    !match ||
    !access ||
    !writer ||
    !score ||
    !UUID_PATTERN.test(String(match.id ?? "")) ||
    typeof match.code !== "string" ||
    typeof match.stage !== "string" ||
    !home ||
    !away ||
    nullableString(home.id, 64) === undefined ||
    nullableString(home.name, 200) === undefined ||
    nullableString(away.id, 64) === undefined ||
    nullableString(away.name, 200) === undefined ||
    !["writer", "candidate", "viewer", "transferred"].includes(String(access.mode ?? "")) ||
    !Array.isArray(access.permissions) ||
    !access.permissions.every((permission) => typeof permission === "string") ||
    (writer.generation !== null && !Number.isSafeInteger(writer.generation)) ||
    (writer.expires_at !== null && typeof writer.expires_at !== "string") ||
    typeof writer.read_only !== "boolean" ||
    typeof access.session_expires_at !== "string" ||
    !["none", "pending", "approved", "denied"].includes(String(source.takeover_status ?? "none")) ||
    !canonicalScoreState(score) ||
    !Number.isSafeInteger(source.through_sequence) ||
    !Array.isArray(source.events) ||
    !canonicalEvents
  ) {
    return null;
  }
  const events: Array<Record<string, unknown>> = [];
  for (const rawEvent of source.events) {
    if (!rawEvent || typeof rawEvent !== "object") return null;
    const event = rawEvent as Record<string, unknown>;
    const teamSlot = event.team_slot;
    const scorer = nullableString(event.scorer, 120);
    if (
      !UUID_PATTERN.test(String(event.client_event_id ?? "")) ||
      typeof event.type !== "string" ||
      (teamSlot !== null && teamSlot !== "home" && teamSlot !== "away") ||
      scorer === undefined ||
      (event.manual_period !== null && !Number.isSafeInteger(event.manual_period)) ||
      (event.manual_event_seconds !== null && !Number.isSafeInteger(event.manual_event_seconds))
    ) {
      return null;
    }
    events.push({
      client_event_id: event.client_event_id,
      type: event.type,
      team_slot: teamSlot,
      scorer,
      manual_period: event.manual_period,
      manual_event_seconds: event.manual_event_seconds,
      payload: eventPayload(event.payload),
    });
  }
  return {
    competition: { slug: competition.slug, sport_code: competition.sport_code },
    sport: { pack_version: sport.pack_version, settings: sport.settings },
    match: {
      id: match.id,
      code: match.code,
      stage: match.stage,
      home: { id: home.id, name: home.name },
      away: { id: away.id, name: away.name },
    },
    access: {
      mode: access.mode,
      permissions: access.permissions,
      generation: writer.generation,
      lease_expires_at: writer.expires_at,
      expires_at: access.session_expires_at,
      read_only: writer.read_only,
      takeover_status: source.takeover_status ?? "none",
    },
    score: canonicalScoreState(score),
    through_sequence: source.through_sequence,
    events,
    canonical_events: canonicalEvents,
  };
}

function refreshAuthFromState(auth: ScoringServerAuth, state: Record<string, unknown>): ScoringServerAuth | null {
  const access = state.access;
  if (!access || typeof access !== "object" || Array.isArray(access)) return null;
  const source = access as Record<string, unknown>;
  if (
    (source.mode !== "writer" &&
      source.mode !== "candidate" &&
      source.mode !== "viewer" &&
      source.mode !== "transferred") ||
    !Array.isArray(source.permissions) ||
    !source.permissions.every((permission) => typeof permission === "string") ||
    (source.generation !== null && !Number.isSafeInteger(source.generation)) ||
    typeof source.expires_at !== "string" ||
    (source.lease_expires_at !== null && typeof source.lease_expires_at !== "string")
  ) {
    return null;
  }
  return {
    ...auth,
    mode: source.mode,
    permissions: source.permissions as string[],
    generation: source.generation as number | null,
    expiresAt: source.expires_at,
    leaseExpiresAt: source.lease_expires_at as string | null,
  };
}

function exchangeInput(
  value: unknown,
): { token?: string; short_code?: string; device_id: string; device_label?: string } | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const token = input.token;
  const shortCode = input.shortCode;
  const deviceId = input.deviceId;
  const deviceLabel = input.deviceLabel;
  if (
    typeof deviceId !== "string" ||
    !UUID_PATTERN.test(deviceId) ||
    (deviceLabel !== undefined &&
      (typeof deviceLabel !== "string" || deviceLabel.trim().length < 1 || deviceLabel.length > 80))
  ) {
    return null;
  }
  if (isScoringAccessToken(token) && shortCode === undefined) {
    return {
      token,
      device_id: deviceId,
      ...(typeof deviceLabel === "string" ? { device_label: deviceLabel.trim() } : {}),
    };
  }
  if (typeof shortCode === "string" && /^\d{12}$/.test(shortCode) && token === undefined) {
    return {
      short_code: shortCode,
      device_id: deviceId,
      ...(typeof deviceLabel === "string" ? { device_label: deviceLabel.trim() } : {}),
    };
  }
  return null;
}

function exchangedAuth(value: unknown): ScoringServerAuth | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const auth = {
    sessionId: source.session_id,
    sessionToken: source.session_token,
    mode: source.mode,
    permissions: source.permissions,
    generation: source.generation,
    matchId: source.match_id,
    expiresAt: source.expires_at,
    leaseExpiresAt: source.lease_expires_at,
  };
  return typeof auth.sessionId === "string" &&
    typeof auth.sessionToken === "string" &&
    (auth.mode === "writer" || auth.mode === "candidate" || auth.mode === "viewer" || auth.mode === "transferred") &&
    Array.isArray(auth.permissions) &&
    auth.permissions.every((permission) => typeof permission === "string") &&
    (auth.generation === null || typeof auth.generation === "number") &&
    typeof auth.matchId === "string" &&
    typeof auth.expiresAt === "string" &&
    (auth.leaseExpiresAt === null || typeof auth.leaseExpiresAt === "string")
    ? (auth as ScoringServerAuth)
    : null;
}

function appendInput(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const command = parseFiveSportScoreCommand(input);
  if (!command || !safeInteger(input.expected_sequence)) return null;
  return {
    client_event_id: command.clientEventId,
    expected_sequence: input.expected_sequence,
    type: command.type,
    occurred_at: command.occurredAt,
    ...(command.side ? { team_slot: command.side } : {}),
    ...(typeof command.participantId === "string" ? { participant_id: command.participantId } : {}),
    ...(command.unknownParticipant !== undefined ? { unknown_participant: command.unknownParticipant } : {}),
    ...(command.segmentNumber !== undefined ? { segment_number: command.segmentNumber } : {}),
    ...(command.manualTimeSeconds !== undefined ? { manual_time_seconds: command.manualTimeSeconds } : {}),
    ...(command.reversalTargetEventId ? { reversal_target_event_id: command.reversalTargetEventId } : {}),
    ...(command.reason ? { reason: command.reason } : {}),
  };
}

async function upstreamFetch(url: URL, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, redirect: "error" });
  } catch {
    return null;
  }
}

async function upstreamSafeError(response: Response, clearCookie = false): Promise<Response> {
  const payload = await readJson(response);
  const envelope =
    payload && typeof payload === "object" && (payload as Record<string, unknown>).error
      ? ((payload as Record<string, unknown>).error as Record<string, unknown>)
      : null;
  const code = envelope && typeof envelope.code === "string" ? envelope.code : "";
  const currentSequence =
    envelope && Number.isSafeInteger(envelope.current_sequence) ? Number(envelope.current_sequence) : undefined;
  const currentAggregateVersion =
    envelope && Number.isSafeInteger(envelope.current_aggregate_version)
      ? Number(envelope.current_aggregate_version)
      : undefined;
  const state: SafeError | undefined =
    code === "ACCESS_RATE_LIMITED"
      ? "rate_limited"
      : code === "ACCESS_REVOKED" || code === "SCORING_SESSION_REVOKED"
        ? "revoked"
        : code === "ACCESS_EXPIRED" || code === "SCORING_SESSION_EXPIRED"
          ? "expired"
          : undefined;
  return safeError(exposedStatus(response.status), clearCookie, state, response.headers, {
    code,
    current_sequence: currentSequence,
    current_aggregate_version: currentAggregateVersion,
  });
}

export async function exchangeScoringSession(request: Request): Promise<Response> {
  if (!sameOriginMutation(request)) return safeError(403);
  const baseUrl = apiBaseUrl();
  const sessionSealer = sealer();
  if (!baseUrl || !sessionSealer) return safeError(503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError(400);
  }
  const input = exchangeInput(body);
  if (!input) return safeError(400);
  const exchange = await upstreamFetch(new URL("/api/v1/scoring/access/exchange", baseUrl), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!exchange) return safeError(503);
  if (!exchange.ok) {
    return upstreamSafeError(exchange, [401, 403, 410, 429].includes(exchange.status));
  }
  const auth = exchangedAuth(await readJson(exchange));
  if (!auth) return safeError(503);
  let cookie: string;
  try {
    cookie = scoringSessionCookie(sessionSealer.seal(auth), auth.expiresAt);
  } catch {
    return safeError(503);
  }
  const stateResponse = await upstreamFetch(new URL("/api/v1/scoring/session", baseUrl), {
    headers: authHeaders(auth),
    cache: "no-store",
  });
  if (!stateResponse) return withCookie(safeError(503), cookie);
  if (!stateResponse.ok) {
    return [401, 403].includes(stateResponse.status)
      ? upstreamSafeError(stateResponse, true)
      : withCookie(await upstreamSafeError(stateResponse), cookie);
  }
  const state = scoringState(await readJson(stateResponse));
  if (!state) return withCookie(safeError(503), cookie);
  return jsonResponse(state, 200, cookie);
}

export async function recoverScoringSession(request: Request): Promise<Response> {
  if (!cookieValue(request)) {
    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": "private, no-store",
        pragma: "no-cache",
        vary: "Cookie",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const authenticated = authenticatedRequest(request);
  if ("response" in authenticated) return authenticated.response;
  const upstream = await upstreamFetch(new URL("/api/v1/scoring/session", authenticated.baseUrl), {
    headers: authHeaders(authenticated.auth),
    cache: "no-store",
  });
  if (!upstream) return safeError(503);
  if (!upstream.ok) return upstreamSafeError(upstream, [401, 403, 410].includes(upstream.status));
  const state = scoringState(await readJson(upstream));
  const sessionSealer = sealer();
  if (!state || !sessionSealer) return safeError(503);
  const refreshedAuth = refreshAuthFromState(authenticated.auth, state);
  if (!refreshedAuth) return safeError(503, true);
  try {
    return jsonResponse(state, 200, scoringSessionCookie(sessionSealer.seal(refreshedAuth), refreshedAuth.expiresAt));
  } catch {
    return safeError(503, true);
  }
}

function heartbeatInput(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const lastAcknowledgedSequence = source.lastAcknowledgedSequence;
  const pendingEventCount = source.pendingEventCount;
  const pendingThroughSequence = source.pendingThroughSequence;
  if (
    !Number.isSafeInteger(lastAcknowledgedSequence) ||
    Number(lastAcknowledgedSequence) < 0 ||
    !Number.isSafeInteger(pendingEventCount) ||
    Number(pendingEventCount) < 0 ||
    (pendingThroughSequence !== null &&
      (!Number.isSafeInteger(pendingThroughSequence) || Number(pendingThroughSequence) < 0))
  ) {
    return null;
  }
  return {
    last_acknowledged_sequence: Number(lastAcknowledgedSequence),
    pending_event_count: Number(pendingEventCount),
    pending_through_sequence:
      pendingThroughSequence === null ? Number(lastAcknowledgedSequence) : Number(pendingThroughSequence),
  };
}

export async function heartbeatScoringSession(request: Request): Promise<Response> {
  if (!sameOriginMutation(request)) return safeError(403);
  const authenticated = authenticatedRequest(request);
  if ("response" in authenticated) return authenticated.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError(400);
  }
  const input = heartbeatInput(body);
  if (!input) return safeError(400);
  const heartbeat = await upstreamFetch(new URL("/api/v1/scoring/sessions/heartbeat", authenticated.baseUrl), {
    method: "POST",
    headers: authHeaders(authenticated.auth),
    body: JSON.stringify(input),
  });
  if (!heartbeat) return safeError(503);
  if (!heartbeat.ok) return upstreamSafeError(heartbeat, [401, 403, 410].includes(heartbeat.status));
  const heartbeatPayload = await readJson(heartbeat);
  const heartbeatState =
    heartbeatPayload && typeof heartbeatPayload === "object" ? (heartbeatPayload as Record<string, unknown>) : null;
  const refreshedAuth: ScoringServerAuth =
    heartbeatState &&
    (heartbeatState.mode === "writer" ||
      heartbeatState.mode === "candidate" ||
      heartbeatState.mode === "viewer" ||
      heartbeatState.mode === "transferred") &&
    (heartbeatState.generation === null || Number.isSafeInteger(heartbeatState.generation)) &&
    typeof heartbeatState.session_expires_at === "string" &&
    (heartbeatState.lease_expires_at === null || typeof heartbeatState.lease_expires_at === "string")
      ? {
          ...authenticated.auth,
          mode: heartbeatState.mode,
          generation: heartbeatState.generation as number | null,
          expiresAt: heartbeatState.session_expires_at,
          leaseExpiresAt: heartbeatState.lease_expires_at as string | null,
        }
      : authenticated.auth;
  const stateResponse = await upstreamFetch(new URL("/api/v1/scoring/session", authenticated.baseUrl), {
    headers: authHeaders(refreshedAuth),
    cache: "no-store",
  });
  if (!stateResponse) return safeError(503);
  if (!stateResponse.ok) return upstreamSafeError(stateResponse, [401, 403, 410].includes(stateResponse.status));
  const state = scoringState(await readJson(stateResponse));
  const sessionSealer = sealer();
  if (!state || !sessionSealer) return safeError(503);
  try {
    return jsonResponse(state, 200, scoringSessionCookie(sessionSealer.seal(refreshedAuth), refreshedAuth.expiresAt));
  } catch {
    return safeError(503, true);
  }
}

export async function requestScoringTakeover(request: Request): Promise<Response> {
  if (!sameOriginMutation(request)) return safeError(403);
  const authenticated = authenticatedRequest(request);
  if ("response" in authenticated) return authenticated.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError(400);
  }
  const input = heartbeatInput({
    ...(body && typeof body === "object" ? body : {}),
    lastAcknowledgedSequence: 0,
  });
  if (!input) return safeError(400);
  const takeover = await upstreamFetch(new URL("/api/v1/scoring/takeover-requests", authenticated.baseUrl), {
    method: "POST",
    headers: authHeaders(authenticated.auth),
    body: JSON.stringify({
      pending_event_count: input.pending_event_count,
      pending_through_sequence: input.pending_through_sequence ?? 0,
    }),
  });
  if (!takeover) return safeError(503);
  if (!takeover.ok) return upstreamSafeError(takeover, [401, 403, 410].includes(takeover.status));
  const payload = await readJson(takeover);
  const requestId = payload && typeof payload === "object" ? (payload as Record<string, unknown>).id : undefined;
  return typeof requestId === "string" && UUID_PATTERN.test(requestId)
    ? jsonResponse({ status: "pending", requestId }, 202)
    : safeError(503);
}

export async function appendScoringEvent(request: Request): Promise<Response> {
  if (!sameOriginMutation(request)) return safeError(403);
  const authenticated = authenticatedRequest(request);
  if ("response" in authenticated) return authenticated.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError(400);
  }
  const input = appendInput(body);
  if (!input) return safeError(400);
  const upstream = await upstreamFetch(new URL("/api/v1/scoring/events", authenticated.baseUrl), {
    method: "POST",
    headers: authHeaders(authenticated.auth),
    body: JSON.stringify(input),
  });
  if (!upstream) return safeError(503);
  if (!upstream.ok) return upstreamSafeError(upstream, [401, 403].includes(upstream.status));
  const payload = await readJson(upstream);
  const source = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (
    !source ||
    typeof input.client_event_id !== "string" ||
    typeof source.client_event_id !== "string" ||
    source.client_event_id !== input.client_event_id ||
    typeof source.event_id !== "string" ||
    !UUID_PATTERN.test(source.event_id) ||
    typeof source.command_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.command_fingerprint) ||
    typeof source.duplicate !== "boolean" ||
    !Number.isSafeInteger(source.sequence) ||
    !Number.isSafeInteger(source.aggregate_version) ||
    source.sequence !== source.aggregate_version ||
    typeof source.server_received_at !== "string" ||
    !Number.isFinite(Date.parse(source.server_received_at))
  ) {
    return safeError(503);
  }
  return jsonResponse(
    {
      client_event_id: source.client_event_id,
      event_id: source.event_id,
      command_fingerprint: source.command_fingerprint,
      duplicate: source.duplicate,
      sequence: source.sequence,
      aggregate_version: source.aggregate_version,
      server_received_at: source.server_received_at,
    },
    200,
  );
}

export async function finaliseScoringResult(request: Request): Promise<Response> {
  if (!sameOriginMutation(request)) return safeError(403);
  const authenticated = authenticatedRequest(request);
  if ("response" in authenticated) return authenticated.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError(400);
  }
  const clientEventId =
    body && typeof body === "object" ? (body as Record<string, unknown>).client_event_id : undefined;
  const expectedSequence =
    body && typeof body === "object" ? (body as Record<string, unknown>).expected_sequence : undefined;
  const occurredAt = body && typeof body === "object" ? (body as Record<string, unknown>).occurred_at : undefined;
  if (
    typeof clientEventId !== "string" ||
    !UUID_PATTERN.test(clientEventId) ||
    !safeInteger(expectedSequence) ||
    (occurredAt !== undefined &&
      (typeof occurredAt !== "string" || occurredAt.length > 40 || !Number.isFinite(Date.parse(occurredAt))))
  ) {
    return safeError(400);
  }
  const upstream = await upstreamFetch(new URL("/api/v1/scoring/finalise", authenticated.baseUrl), {
    method: "POST",
    headers: authHeaders(authenticated.auth),
    body: JSON.stringify({
      client_event_id: clientEventId,
      expected_sequence: expectedSequence,
      ...(typeof occurredAt === "string" ? { occurred_at: occurredAt } : {}),
    }),
  });
  if (!upstream) return safeError(503);
  if (!upstream.ok) return upstreamSafeError(upstream, [401, 403].includes(upstream.status));
  const payload = await readJson(upstream);
  if (!payload || typeof payload !== "object") return safeError(503);
  const source = payload as Record<string, unknown>;
  if (
    typeof source.client_event_id !== "string" ||
    source.client_event_id !== clientEventId ||
    typeof source.event_id !== "string" ||
    !UUID_PATTERN.test(source.event_id) ||
    typeof source.command_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.command_fingerprint) ||
    typeof source.duplicate !== "boolean" ||
    typeof source.match_id !== "string" ||
    !UUID_PATTERN.test(source.match_id) ||
    !Number.isSafeInteger(source.sequence) ||
    !Number.isSafeInteger(source.aggregate_version) ||
    source.sequence !== source.aggregate_version ||
    !Number.isSafeInteger(source.result_version) ||
    !Number.isSafeInteger(source.publication_version) ||
    typeof source.server_received_at !== "string" ||
    !Number.isFinite(Date.parse(source.server_received_at)) ||
    typeof source.published_at !== "string" ||
    !Number.isFinite(Date.parse(source.published_at))
  ) {
    return safeError(503);
  }
  return jsonResponse(
    {
      client_event_id: source.client_event_id,
      event_id: source.event_id,
      command_fingerprint: source.command_fingerprint,
      duplicate: source.duplicate,
      match_id: source.match_id,
      sequence: source.sequence,
      aggregate_version: source.aggregate_version,
      result_version: source.result_version,
      publication_version: source.publication_version,
      server_received_at: source.server_received_at,
      published_at: source.published_at,
    },
    200,
  );
}

type OfflineAuthorityInput = {
  device_id: string;
  last_acknowledged_sequence: number;
  pending_event_count: number;
  pending_through_sequence: number;
  last_reported_local_sequence: number;
  queue_fingerprint: string;
  indexeddb_schema_version: number;
  service_worker_version: string;
};

function offlineAuthorityInput(value: unknown): OfflineAuthorityInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const deviceId = source.deviceId;
  const lastAcknowledgedSequence = source.lastAcknowledgedSequence;
  const pendingEventCount = source.pendingEventCount;
  const pendingThroughSequence = source.pendingThroughSequence;
  const lastReportedLocalSequence = source.lastReportedLocalSequence;
  const queueFingerprint = source.queueFingerprint;
  const indexeddbSchemaVersion = source.indexeddbSchemaVersion;
  const serviceWorkerVersion = source.serviceWorkerVersion;
  if (
    typeof deviceId !== "string" ||
    !UUID_PATTERN.test(deviceId) ||
    !safeInteger(lastAcknowledgedSequence) ||
    !safeInteger(pendingEventCount) ||
    !safeInteger(pendingThroughSequence) ||
    !safeInteger(lastReportedLocalSequence) ||
    typeof queueFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(queueFingerprint) ||
    !safeInteger(indexeddbSchemaVersion, 1) ||
    Number(indexeddbSchemaVersion) > 100 ||
    typeof serviceWorkerVersion !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(serviceWorkerVersion)
  ) {
    return null;
  }
  return {
    device_id: deviceId,
    last_acknowledged_sequence: Number(lastAcknowledgedSequence),
    pending_event_count: Number(pendingEventCount),
    pending_through_sequence: Number(pendingThroughSequence),
    last_reported_local_sequence: Number(lastReportedLocalSequence),
    queue_fingerprint: queueFingerprint,
    indexeddb_schema_version: Number(indexeddbSchemaVersion),
    service_worker_version: serviceWorkerVersion,
  };
}

function offlineAuthorityMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.authorization_id !== "string" ||
    !UUID_PATTERN.test(source.authorization_id) ||
    typeof source.competition_id !== "string" ||
    !UUID_PATTERN.test(source.competition_id) ||
    typeof source.match_id !== "string" ||
    !UUID_PATTERN.test(source.match_id) ||
    !safeInteger(source.generation, 1) ||
    typeof source.recording_expires_at !== "string" ||
    !Number.isFinite(Date.parse(source.recording_expires_at)) ||
    typeof source.replay_expires_at !== "string" ||
    !Number.isFinite(Date.parse(source.replay_expires_at)) ||
    typeof source.pass_expires_at !== "string" ||
    !Number.isFinite(Date.parse(source.pass_expires_at))
  ) {
    return null;
  }
  return {
    authorization_id: source.authorization_id,
    competition_id: source.competition_id,
    match_id: source.match_id,
    generation: source.generation,
    recording_expires_at: source.recording_expires_at,
    replay_expires_at: source.replay_expires_at,
    pass_expires_at: source.pass_expires_at,
    status: typeof source.status === "string" ? source.status : "active",
  };
}

function offlineCredentialFromResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const metadata = offlineAuthorityMetadata(source);
  return metadata && typeof source.resume_secret === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(source.resume_secret)
    ? {
        metadata,
        credential: {
          authorizationId: String(source.authorization_id),
          resumeSecret: source.resume_secret,
          matchId: String(source.match_id),
          replayExpiresAt: String(source.replay_expires_at),
        },
      }
    : null;
}

function offlineCredential(request: Request) {
  const sealed = namedCookieValue(request, offlineGrantCookieName);
  const grantSealer = offlineSealer();
  if (!sealed || !grantSealer) return null;
  try {
    return grantSealer.open(sealed);
  } catch (error) {
    if (error instanceof InvalidOfflineGrantError) return null;
    return null;
  }
}

async function offlineError(response: Response): Promise<Response> {
  const safe = await upstreamSafeError(response, false);
  if ([401, 403, 410].includes(response.status)) safe.headers.append("set-cookie", expiredOfflineGrantCookie());
  return safe;
}

function expiredOfflineScoringResponse(): Response {
  const response = jsonResponse({ success: true }, 200);
  response.headers.append("set-cookie", expiredOfflineGrantCookie());
  response.headers.append("set-cookie", expiredScoringSessionCookie());
  return response;
}

export async function establishOfflineScoringAuthority(request: Request): Promise<Response> {
  if (!sameOriginMutation(request)) return safeError(403);
  const baseUrl = apiBaseUrl();
  const sessionSealer = sealer();
  const grantSealer = offlineSealer();
  if (!baseUrl || !sessionSealer || !grantSealer) return safeError(503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError(400);
  }
  const input = offlineAuthorityInput(body);
  if (!input) return safeError(400);
  const intent =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).intent : null;
  if (intent !== "prepare" && intent !== "resume") return safeError(400);
  const existing = offlineCredential(request);
  if (intent === "prepare") {
    const authenticated = authenticatedRequest(request);
    if ("response" in authenticated) return authenticated.response;
    const upstream = await upstreamFetch(new URL("/api/v1/scoring/offline-authorizations", baseUrl), {
      method: "POST",
      headers: authHeaders(authenticated.auth),
      body: JSON.stringify({
        ...input,
        ...(existing ? { resume_secret: existing.resumeSecret } : {}),
      }),
    });
    if (!upstream) return safeError(503);
    if (!upstream.ok) return offlineError(upstream);
    const result = offlineCredentialFromResponse(await readJson(upstream));
    if (!result) return safeError(503);
    try {
      const cookie = offlineGrantCookie(grantSealer.seal(result.credential), result.credential.replayExpiresAt);
      return jsonResponse({ offline: result.metadata }, 201, cookie);
    } catch {
      return safeError(503);
    }
  }
  if (!existing) return safeError(401);

  const upstream = await upstreamFetch(
    new URL(`/api/v1/scoring/offline-authorizations/${existing.authorizationId}/resume`, baseUrl),
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ...input, resume_secret: existing.resumeSecret }),
    },
  );
  if (!upstream) return safeError(503);
  if (!upstream.ok) return offlineError(upstream);
  const source = await readJson(upstream);
  if (!source || typeof source !== "object" || Array.isArray(source)) return safeError(503);
  const payload = source as Record<string, unknown>;
  const auth = exchangedAuth(payload.session ?? payload);
  const refreshedGrant = offlineCredentialFromResponse(payload.offline ?? payload);
  if (
    !auth ||
    !refreshedGrant ||
    auth.matchId !== existing.matchId ||
    refreshedGrant.metadata.match_id !== existing.matchId
  ) {
    return safeError(503);
  }
  const stateResponse = await upstreamFetch(new URL("/api/v1/scoring/session", baseUrl), {
    headers: authHeaders(auth),
    cache: "no-store",
  });
  if (!stateResponse) return safeError(503);
  if (!stateResponse.ok) return upstreamSafeError(stateResponse, [401, 403, 410].includes(stateResponse.status));
  const state = scoringState(await readJson(stateResponse));
  if (!state) return safeError(503);
  try {
    const response = jsonResponse(
      { session: state, offline: refreshedGrant.metadata },
      200,
      scoringSessionCookie(sessionSealer.seal(auth), auth.expiresAt),
    );
    response.headers.append(
      "set-cookie",
      offlineGrantCookie(grantSealer.seal(refreshedGrant.credential), refreshedGrant.credential.replayExpiresAt),
    );
    return response;
  } catch {
    return safeError(503);
  }
}

export async function revokeOfflineScoringAuthority(request: Request): Promise<Response> {
  if (!sameOriginMutation(request)) return safeError(403);
  const baseUrl = apiBaseUrl();
  const existing = offlineCredential(request);
  if (!baseUrl) return safeError(503);
  if (!existing) return expiredOfflineScoringResponse();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError(400);
  }
  const deviceId =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).deviceId : null;
  if (typeof deviceId !== "string" || !UUID_PATTERN.test(deviceId)) return safeError(400);
  const upstream = await upstreamFetch(
    new URL(`/api/v1/scoring/offline-authorizations/${existing.authorizationId}`, baseUrl),
    {
      method: "DELETE",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ resume_secret: existing.resumeSecret, device_id: deviceId }),
    },
  );
  if (!upstream) return safeError(503);
  if (!upstream.ok && upstream.status !== 404 && upstream.status !== 410) return offlineError(upstream);
  return expiredOfflineScoringResponse();
}
