import {
  expiredScoringSessionCookie,
  InvalidScoringSessionError,
  scoringSessionCookie,
  scoringSessionCookieName,
  ScoringSessionSealer,
  type ScoringServerAuth,
} from "./scoring-session.server";
import { isScoringAccessToken } from "./scoring-access";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES = new Set([
  "match_started",
  "period_changed",
  "goal_added",
  "goal_reversed",
  "card_added",
  "card_reversed",
  "timeout_added",
  "incident_added",
  "match_reopened",
]);

type SafeError = "access" | "conflict" | "expired" | "rate_limited" | "revoked" | "unavailable";

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

function safeError(status: number, clearCookie = false, explicitState?: SafeError, sourceHeaders?: Headers): Response {
  const state: SafeError =
    explicitState ??
    (status === 409
      ? "conflict"
      : status === 410
        ? "expired"
        : status === 429
          ? "rate_limited"
          : [400, 401, 403].includes(status)
            ? "access"
            : "unavailable");
  const response = jsonResponse({ error: state }, status, clearCookie ? expiredScoringSessionCookie() : undefined);
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

function cookieValue(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== scoringSessionCookieName) continue;
    const value = valueParts.join("=");
    return value && value.length <= 4_096 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  }
  return null;
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

function scoringState(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const competition = source.competition as Record<string, unknown> | null;
  const match = source.match as Record<string, unknown> | null;
  const access = source.access as Record<string, unknown> | null;
  const writer = source.writer as Record<string, unknown> | null;
  const score = source.score as Record<string, unknown> | null;
  const home = match?.home as Record<string, unknown> | null;
  const away = match?.away as Record<string, unknown> | null;
  if (
    !competition ||
    typeof competition.slug !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(competition.slug) ||
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
    !Number.isSafeInteger(score.home) ||
    !Number.isSafeInteger(score.away) ||
    !Number.isSafeInteger(source.through_sequence) ||
    !Array.isArray(source.events)
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
    competition: { slug: competition.slug },
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
    score: { home: score.home, away: score.away },
    through_sequence: source.through_sequence,
    events,
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
  const correctionReason = input.correction_reason;
  const needsCorrectionReason =
    input.type === "goal_reversed" || input.type === "card_reversed" || input.type === "match_reopened";
  if (
    !UUID_PATTERN.test(String(input.client_event_id ?? "")) ||
    typeof input.type !== "string" ||
    !EVENT_TYPES.has(input.type) ||
    (input.team_slot !== undefined && input.team_slot !== "home" && input.team_slot !== "away") ||
    (input.scorer !== undefined &&
      (typeof input.scorer !== "string" || input.scorer.length < 1 || input.scorer.length > 120)) ||
    (input.manual_period !== 1 && input.manual_period !== 2) ||
    !Number.isInteger(input.manual_event_seconds) ||
    Number(input.manual_event_seconds) < 0 ||
    Number(input.manual_event_seconds) > 3_599 ||
    (correctionReason !== undefined &&
      (typeof correctionReason !== "string" || correctionReason.trim().length < 3 || correctionReason.length > 500)) ||
    (needsCorrectionReason && typeof correctionReason !== "string") ||
    typeof input.occurred_at !== "string" ||
    !Number.isFinite(Date.parse(input.occurred_at))
  ) {
    return null;
  }
  return {
    client_event_id: input.client_event_id,
    type: input.type,
    ...(input.team_slot ? { team_slot: input.team_slot } : {}),
    ...(input.scorer ? { scorer: input.scorer } : {}),
    manual_period: input.manual_period,
    manual_event_seconds: input.manual_event_seconds,
    payload: eventPayload(input.payload),
    ...(typeof correctionReason === "string" ? { correction_reason: correctionReason } : {}),
    occurred_at: input.occurred_at,
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
  const state: SafeError | undefined =
    code === "ACCESS_RATE_LIMITED"
      ? "rate_limited"
      : code === "ACCESS_REVOKED" || code === "SCORING_SESSION_REVOKED"
        ? "revoked"
        : code === "ACCESS_EXPIRED" || code === "SCORING_SESSION_EXPIRED"
          ? "expired"
          : undefined;
  return safeError(exposedStatus(response.status), clearCookie, state, response.headers);
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
  if (!upstream.ok) return safeError(exposedStatus(upstream.status), [401, 403].includes(upstream.status));
  const payload = await readJson(upstream);
  const sequence = payload && typeof payload === "object" ? (payload as Record<string, unknown>).sequence : null;
  return Number.isSafeInteger(sequence) ? jsonResponse({ sequence }, 200) : safeError(503);
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
  if (typeof clientEventId !== "string" || !UUID_PATTERN.test(clientEventId)) return safeError(400);
  const upstream = await upstreamFetch(new URL("/api/v1/scoring/finalise", authenticated.baseUrl), {
    method: "POST",
    headers: authHeaders(authenticated.auth),
    body: JSON.stringify({ client_event_id: clientEventId }),
  });
  if (!upstream) return safeError(503);
  if (!upstream.ok) return safeError(exposedStatus(upstream.status), [401, 403].includes(upstream.status));
  const payload = await readJson(upstream);
  if (!payload || typeof payload !== "object") return safeError(503);
  const source = payload as Record<string, unknown>;
  if (
    typeof source.match_id !== "string" ||
    !UUID_PATTERN.test(source.match_id) ||
    !Number.isSafeInteger(source.result_version)
  ) {
    return safeError(503);
  }
  return jsonResponse({ match_id: source.match_id, result_version: source.result_version }, 200);
}
