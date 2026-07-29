import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPORT_PACKS } from "@matchday/domain";
import {
  appendScoringEvent,
  establishOfflineScoringAuthority,
  exchangeScoringSession,
  finaliseScoringResult,
  heartbeatScoringSession,
  recoverScoringSession,
  requestScoringTakeover,
  revokeOfflineScoringAuthority,
} from "../../lib/scoring-bff.server";
import { OfflineGrantSealer, offlineGrantCookieName } from "../../lib/offline-grant.server";
import {
  scoringSessionCookieName,
  ScoringSessionSealer,
  type ScoringServerAuth,
} from "../../lib/scoring-session.server";

const webOrigin = "https://matchday.test";
const apiOrigin = "https://api.matchday.test";
const sealKey = Buffer.alloc(32, 7).toString("base64url");
const sessionId = "00000000-0000-4000-8000-000000000101";
const matchId = "00000000-0000-4000-8000-000000000102";
const eventId = "00000000-0000-4000-8000-000000000103";
const finalEventId = "00000000-0000-4000-8000-000000000104";
const receivedAt = "2026-07-17T02:00:01.000Z";
const deviceId = "00000000-0000-4000-8000-000000000104";
const offlineAuthorizationId = "00000000-0000-4000-8000-000000000105";
const offlinePrincipalId = "a".repeat(64);
const competitionId = "00000000-0000-4000-8000-000000000106";
const offlineResumeSecret = "r".repeat(43);
const offlineRecordingExpiresAt = "2030-01-01T04:00:00.000Z";
const offlineReplayExpiresAt = "2030-01-01T04:15:00.000Z";
const sessionToken = "server-session-secret-that-never-reaches-browser-0001";
const accessToken = "one-time-access-secret-that-stays-in-request-body-001";
const expiresAt = "2030-01-01T00:00:00.000Z";

const auth: ScoringServerAuth = {
  sessionId,
  sessionToken,
  mode: "writer",
  permissions: ["score:read", "score:write"],
  generation: 3,
  matchId,
  expiresAt,
  leaseExpiresAt: expiresAt,
};

const exchangeBody = { token: accessToken, deviceId, deviceLabel: "Test device" };
const exchangedSession = {
  session_id: sessionId,
  session_token: sessionToken,
  match_id: matchId,
  mode: "writer",
  permissions: ["score:read", "score:write"],
  generation: 3,
  expires_at: expiresAt,
  lease_expires_at: expiresAt,
};

function state(extra: Record<string, unknown> = {}) {
  return {
    competition: { slug: "singapore-open", sport_code: "canoe_polo" },
    sport: {
      pack_version: SPORT_PACKS.canoe_polo.version,
      settings: SPORT_PACKS.canoe_polo.recommendedSettings,
    },
    match: {
      id: matchId,
      code: "M-12",
      stage: "Group B",
      home: { id: null, name: "Marina Blue" },
      away: { id: null, name: "Harbour Gold" },
    },
    access: {
      principal_id: "a".repeat(64),
      mode: "writer",
      permissions: ["score:read", "score:write"],
      session_expires_at: expiresAt,
    },
    writer: { generation: 3, expires_at: expiresAt, read_only: false },
    score: {
      home: 1,
      away: 0,
      lifecycle: "in_progress",
      current_segment: 1,
      total_points: { home: 1, away: 0 },
      segment_wins: { home: 0, away: 0 },
      segments: [{ number: 1, home: 1, away: 0, completed: false, winner: null }],
      actions: [
        {
          event_id: eventId,
          client_event_id: eventId,
          event_type: "goal",
          label: "Goal",
          side: "home",
          participant_id: "A. Player",
          segment_number: 1,
          score_delta: 1,
          occurred_at: "2026-07-28T00:00:00.000Z",
          reversed: false,
          reversible: true,
        },
      ],
      conflicts: [],
    },
    through_sequence: 1,
    events: [
      {
        client_event_id: eventId,
        type: "goal_added",
        team_slot: "home",
        scorer: "A. Player",
        manual_period: 1,
        manual_event_seconds: 95,
        payload: { colour: "green", session_token: sessionToken },
      },
    ],
    ...extra,
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bffRequest(
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
  cookie?: string,
  origin = webOrigin,
  requestOrigin = webOrigin,
): Request {
  const headers = new Headers();
  if (method === "POST" || method === "DELETE") {
    headers.set("content-type", "application/json");
    headers.set("origin", origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${requestOrigin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sealedCookie(value: ScoringServerAuth = auth): string {
  return `${scoringSessionCookieName}=${new ScoringSessionSealer(sealKey).seal(value)}`;
}

function sealedOfflineCookie(): string {
  const sealed = new OfflineGrantSealer(sealKey).seal({
    authorizationId: offlineAuthorizationId,
    resumeSecret: offlineResumeSecret,
    matchId,
    replayExpiresAt: offlineReplayExpiresAt,
  });
  return `${offlineGrantCookieName}=${sealed}`;
}

const offlineAuthorityBody = {
  deviceId,
  lastAcknowledgedSequence: 1,
  pendingEventCount: 0,
  pendingThroughSequence: 1,
  lastReportedLocalSequence: 0,
  queueFingerprint: "c".repeat(64),
  indexeddbSchemaVersion: 1,
  serviceWorkerVersion: "gate-c-c3-v6",
};

function headerValue(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

beforeEach(() => {
  process.env.MATCHDAY_API_BASE_URL = apiOrigin;
  process.env.SCORING_SESSION_SEAL_KEY = sealKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("scoring session sealing", () => {
  it("round-trips an authenticated-encrypted bundle without plaintext credentials", () => {
    const sealer = new ScoringSessionSealer(sealKey);
    const sealed = sealer.seal(auth);

    expect(sealed).not.toContain(sessionId);
    expect(sealed).not.toContain(sessionToken);
    expect(sealer.open(sealed)).toEqual(auth);
    expect(() => sealer.open(`${sealed.slice(0, -1)}${sealed.endsWith("a") ? "b" : "a"}`)).toThrow(
      "Scoring session is unavailable.",
    );
  });

  it("fails closed when the server-only key is absent or malformed", async () => {
    delete process.env.SCORING_SESSION_SEAL_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => new ScoringSessionSealer("not-a-32-byte-key")).toThrow("exactly 32 random bytes");
  });
});

describe("scoring BFF", () => {
  it("returns no content when recovery has no scoring cookie", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await recoverScoringSession(bffRequest("GET", "/api/scoring/session"));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains a transferred writer generation for stale-event fencing without a live lease", () => {
    const transferred = {
      ...auth,
      mode: "transferred" as const,
      generation: 4,
      leaseExpiresAt: null,
    };
    const sealer = new ScoringSessionSealer(sealKey);

    expect(sealer.open(sealer.seal(transferred))).toEqual(transferred);
  });

  it("exchanges in the request body, stores only a strict host cookie, and returns allowlisted scoring state", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/access/exchange")) {
        return json(exchangedSession);
      }
      return json(state({ session_id: sessionId, session_token: sessionToken }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await exchangeScoringSession(bffRequest("POST", "/api/scoring/access/exchange", exchangeBody));
    const body = await response.text();
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(body).not.toContain(sessionId);
    expect(body).not.toContain(sessionToken);
    expect(body).not.toContain("session_token");
    expect(cookie).toContain(`${scoringSessionCookieName}=`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toContain(sessionId);
    expect(cookie).not.toContain(sessionToken);
    expect(calls.every((call) => !call.url.includes(accessToken) && !call.url.includes(sessionToken))).toBe(true);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      token: accessToken,
      device_id: deviceId,
      device_label: "Test device",
    });
    expect(headerValue(calls[1]?.init, "x-scoring-session-token")).toBe(sessionToken);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps the sealed session recoverable when the post-exchange state read is transiently unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(exchangedSession))
      .mockRejectedValueOnce(new Error(`upstream failed for ${sessionToken}`));
    vi.stubGlobal("fetch", fetchMock);

    const response = await exchangeScoringSession(bffRequest("POST", "/api/scoring/access/exchange", exchangeBody));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(response.headers.get("set-cookie")).toContain(`${scoringSessionCookieName}=`);
    expect(response.headers.get("set-cookie")).not.toContain(sessionToken);
  });

  it("accepts a strictly parsed public origin supplied by the trusted HTTPS proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(exchangedSession)).mockResolvedValueOnce(json(state()));
    vi.stubGlobal("fetch", fetchMock);
    const request = bffRequest(
      "POST",
      "/api/scoring/access/exchange",
      exchangeBody,
      undefined,
      "https://127.0.0.1:3103",
      "http://127.0.0.1:3000",
    );
    request.headers.set("x-forwarded-proto", "https");
    request.headers.set("x-forwarded-host", "127.0.0.1:3103");

    const response = await exchangeScoringSession(request);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects spoofed or multi-valued forwarded origins", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const malformed = [
      { proto: "https,http", host: "matchday.test" },
      { proto: "https", host: "user@matchday.test" },
      { proto: "https", host: "matchday.test,evil.test" },
    ];

    for (const forwarded of malformed) {
      const request = bffRequest(
        "POST",
        "/api/scoring/access/exchange",
        exchangeBody,
        undefined,
        "https://matchday.test",
        "http://127.0.0.1:3000",
      );
      request.headers.set("x-forwarded-proto", forwarded.proto);
      request.headers.set("x-forwarded-host", forwarded.host);
      const response = await exchangeScoringSession(request);
      expect(response.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers through the sealed cookie and strips unexpected credential fields", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(headerValue(init, "x-scoring-session-id")).toBe(sessionId);
      expect(headerValue(init, "x-scoring-session-token")).toBe(sessionToken);
      return json(state({ session_token: sessionToken, access_token: accessToken }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(sessionToken);
    expect(body).not.toContain(accessToken);
    expect(body).not.toContain("session_token");
    expect(JSON.parse(body)).toMatchObject({
      competition: { slug: "singapore-open" },
      match: { id: matchId },
      score: { home: 1, away: 0 },
    });
  });

  it("reseals an approved candidate as the authoritative writer generation during recovery", async () => {
    const candidateAuth: ScoringServerAuth = {
      ...auth,
      mode: "candidate",
      generation: null,
      leaseExpiresAt: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          state({
            access: {
              principal_id: offlinePrincipalId,
              mode: "writer",
              permissions: ["score:read", "score:write"],
              session_expires_at: expiresAt,
            },
            writer: { generation: 6, expires_at: expiresAt, read_only: false },
          }),
        ),
      ),
    );

    const response = await recoverScoringSession(
      bffRequest("GET", "/api/scoring/session", undefined, sealedCookie(candidateAuth)),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    const sealed = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";

    expect(response.status).toBe(200);
    expect(new ScoringSessionSealer(sealKey).open(sealed)).toMatchObject({
      mode: "writer",
      generation: 6,
      leaseExpiresAt: expiresAt,
    });
    expect(setCookie).not.toContain(sessionToken);
  });

  it("does not reseal an unchanged candidate recovery that could overwrite a newer writer cookie", async () => {
    const candidateAuth: ScoringServerAuth = {
      ...auth,
      mode: "candidate",
      generation: null,
      leaseExpiresAt: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          state({
            access: {
              principal_id: offlinePrincipalId,
              mode: "candidate",
              permissions: ["score:read", "score:write"],
              session_expires_at: expiresAt,
            },
            writer: { generation: null, expires_at: null, read_only: true },
          }),
        ),
      ),
    );

    const response = await recoverScoringSession(
      bffRequest("GET", "/api/scoring/session", undefined, sealedCookie(candidateAuth)),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reseals recovery when authoritative session expiry changes", async () => {
    const renewedExpiry = "2030-01-01T00:15:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          state({
            access: {
              principal_id: offlinePrincipalId,
              mode: "writer",
              permissions: ["score:write", "score:read"],
              session_expires_at: renewedExpiry,
            },
          }),
        ),
      ),
    );

    const response = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));
    const setCookie = response.headers.get("set-cookie") ?? "";
    const sealed = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";

    expect(response.status).toBe(200);
    expect(new ScoringSessionSealer(sealKey).open(sealed)).toMatchObject({
      expiresAt: renewedExpiry,
      permissions: ["score:write", "score:read"],
    });
  });

  it("rejects an unsafe competition slug before it can reach a public-page link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(state({ competition: { slug: "../organiser" } }))));

    const response = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("fails closed when the API omits the authoritative sport contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(state({ sport: undefined }))));

    const response = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("fails closed when the API sport-pack version differs from the local executable pack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          state({
            sport: {
              pack_version: "canoe-polo-stale-v0",
              settings: SPORT_PACKS.canoe_polo.recommendedSettings,
            },
          }),
        ),
      ),
    );

    const response = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("recovers a finalised session with its canonical offline finalisation command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          state({
            score: {
              ...state().score,
              lifecycle: "finalised",
              current_segment: 2,
            },
            through_sequence: 1,
            canonical_events: [
              {
                event_id: finalEventId,
                sequence: 1,
                command: {
                  kind: "finalisation",
                  client_event_id: finalEventId,
                  expected_sequence: 0,
                  occurred_at: receivedAt,
                },
              },
            ],
          }),
        ),
      ),
    );

    const response = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      score: { lifecycle: "finalised" },
      canonical_events: [
        {
          event_id: finalEventId,
          sequence: 1,
          command: {
            kind: "finalisation",
            client_event_id: finalEventId,
            expected_sequence: 0,
            occurred_at: receivedAt,
          },
        },
      ],
    });
  });

  it("proxies events and finalisation with server-side auth and allowlisted receipts", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(headerValue(init, "x-scoring-session-token")).toBe(sessionToken);
        expect(String(init?.body)).not.toContain(sessionToken);
        expect(JSON.parse(String(init?.body))).toEqual({
          client_event_id: eventId,
          expected_sequence: 7,
          type: "reversal",
          occurred_at: "2026-07-17T02:00:00.000Z",
          team_slot: "home",
          reversal_target_event_id: eventId,
          reason: "Scorekeeper correction",
        });
        return json({
          client_event_id: eventId,
          event_id: eventId,
          command_fingerprint: "a".repeat(64),
          sequence: 8,
          aggregate_version: 8,
          duplicate: false,
          server_received_at: receivedAt,
          session_token: sessionToken,
        });
      })
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(headerValue(init, "x-scoring-session-token")).toBe(sessionToken);
        return json({
          client_event_id: finalEventId,
          event_id: finalEventId,
          command_fingerprint: "b".repeat(64),
          duplicate: false,
          match_id: matchId,
          sequence: 9,
          aggregate_version: 9,
          result_version: 4,
          publication_version: 4,
          server_received_at: receivedAt,
          published_at: receivedAt,
          session_token: sessionToken,
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    const eventResponse = await appendScoringEvent(
      bffRequest(
        "POST",
        "/api/scoring/events",
        {
          client_event_id: eventId,
          expected_sequence: 7,
          type: "reversal",
          team_slot: "home",
          reversal_target_event_id: eventId,
          reason: "Scorekeeper correction",
          occurred_at: "2026-07-17T02:00:00.000Z",
          session_token: "browser-injected-value",
        },
        sealedCookie(),
      ),
    );
    const finalResponse = await finaliseScoringResult(
      bffRequest(
        "POST",
        "/api/scoring/finalise",
        { client_event_id: finalEventId, expected_sequence: 8 },
        sealedCookie(),
      ),
    );

    expect(await eventResponse.json()).toMatchObject({
      client_event_id: eventId,
      event_id: eventId,
      sequence: 8,
      aggregate_version: 8,
      duplicate: false,
    });
    expect(await finalResponse.json()).toMatchObject({
      client_event_id: finalEventId,
      match_id: matchId,
      result_version: 4,
      publication_version: 4,
    });
  });

  it("preserves an explicit unknown participant in the canonical upstream body", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        client_event_id: eventId,
        expected_sequence: 3,
        type: "goal",
        occurred_at: "2026-07-17T02:00:00.000Z",
        team_slot: "home",
        unknown_participant: true,
        segment_number: 1,
        manual_time_seconds: 95,
      });
      return json({
        client_event_id: eventId,
        event_id: eventId,
        command_fingerprint: "a".repeat(64),
        sequence: 4,
        aggregate_version: 4,
        duplicate: false,
        server_received_at: receivedAt,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await appendScoringEvent(
      bffRequest(
        "POST",
        "/api/scoring/events",
        {
          client_event_id: eventId,
          expected_sequence: 3,
          type: "goal",
          team_slot: "home",
          unknown_participant: true,
          segment_number: 1,
          manual_time_seconds: 95,
          occurred_at: "2026-07-17T02:00:00.000Z",
        },
        sealedCookie(),
      ),
    );

    expect(await response.json()).toMatchObject({ sequence: 4, aggregate_version: 4, duplicate: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("omits participant_id for a canonical no-attribution action", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        client_event_id: eventId,
        expected_sequence: 3,
        type: "point",
        occurred_at: "2026-07-17T02:00:00.000Z",
        team_slot: "home",
        segment_number: 1,
      });
      return json({
        client_event_id: eventId,
        event_id: eventId,
        command_fingerprint: "a".repeat(64),
        sequence: 4,
        aggregate_version: 4,
        duplicate: false,
        server_received_at: receivedAt,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await appendScoringEvent(
      bffRequest(
        "POST",
        "/api/scoring/events",
        {
          client_event_id: eventId,
          expected_sequence: 3,
          type: "point",
          team_slot: "home",
          segment_number: 1,
          occurred_at: "2026-07-17T02:00:00.000Z",
        },
        sealedCookie(),
      ),
    );

    expect(await response.json()).toMatchObject({ sequence: 4, aggregate_version: 4, duplicate: false });
  });

  it("fails closed when the canonical append receipt omits its idempotency result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ sequence: 4 })));

    const response = await appendScoringEvent(
      bffRequest(
        "POST",
        "/api/scoring/events",
        {
          client_event_id: eventId,
          expected_sequence: 3,
          type: "point",
          team_slot: "home",
          segment_number: 1,
          occurred_at: "2026-07-17T02:00:00.000Z",
        },
        sealedCookie(),
      ),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("preserves a semantic 422 as an in-context invalid-state response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: { code: "EVENT_NOT_ALLOWED" } }, 422)));

    const response = await appendScoringEvent(
      bffRequest(
        "POST",
        "/api/scoring/events",
        {
          client_event_id: eventId,
          expected_sequence: 3,
          type: "game_completion",
          team_slot: "home",
          segment_number: 1,
          occurred_at: "2026-07-17T02:00:00.000Z",
        },
        sealedCookie(),
      ),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid" });
  });

  it("preserves offline recording expiry without exposing upstream detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          {
            error: {
              code: "OFFLINE_RECORDING_EXPIRED",
              message: "Sensitive upstream detail is not exposed.",
            },
          },
          409,
        ),
      ),
    );

    const response = await appendScoringEvent(
      bffRequest(
        "POST",
        "/api/scoring/events",
        {
          client_event_id: eventId,
          expected_sequence: 3,
          type: "point",
          team_slot: "home",
          segment_number: 1,
          occurred_at: "2026-07-17T02:00:00.000Z",
        },
        sealedCookie(),
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", code: "OFFLINE_RECORDING_EXPIRED" });
  });

  it("normalizes an empty pending queue to the acknowledged sequence before heartbeat", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return url.endsWith("/sessions/heartbeat")
        ? json({
            mode: "writer",
            generation: 3,
            session_expires_at: expiresAt,
            lease_expires_at: expiresAt,
          })
        : json(state());
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await heartbeatScoringSession(
      bffRequest(
        "POST",
        "/api/scoring/session/heartbeat",
        { lastAcknowledgedSequence: 7, pendingEventCount: 0, pendingThroughSequence: null },
        sealedCookie(),
      ),
    );

    expect(response.status).toBe(200);
    const heartbeat = calls.find(({ url }) => url.endsWith("/sessions/heartbeat"));
    expect(JSON.parse(String(heartbeat?.init?.body))).toEqual({
      last_acknowledged_sequence: 7,
      pending_event_count: 0,
      pending_through_sequence: 7,
    });
  });

  it("reseals heartbeat from the final authoritative state when takeover wins the request race", async () => {
    const candidateAuth: ScoringServerAuth = {
      ...auth,
      mode: "candidate",
      generation: null,
      leaseExpiresAt: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          mode: "candidate",
          generation: null,
          session_expires_at: expiresAt,
          lease_expires_at: null,
        }),
      )
      .mockResolvedValueOnce(
        json(
          state({
            access: {
              principal_id: offlinePrincipalId,
              mode: "writer",
              permissions: ["score:read", "score:write"],
              session_expires_at: expiresAt,
            },
            writer: { generation: 6, expires_at: expiresAt, read_only: false },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await heartbeatScoringSession(
      bffRequest(
        "POST",
        "/api/scoring/session/heartbeat",
        { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: null },
        sealedCookie(candidateAuth),
      ),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    const sealed = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";

    expect(response.status).toBe(200);
    expect(new ScoringSessionSealer(sealKey).open(sealed)).toMatchObject({
      mode: "writer",
      generation: 6,
      leaseExpiresAt: expiresAt,
    });
  });

  it("reseals heartbeat as transferred when the final authoritative state fences the writer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          mode: "writer",
          generation: 3,
          session_expires_at: expiresAt,
          lease_expires_at: expiresAt,
        }),
      )
      .mockResolvedValueOnce(
        json(
          state({
            access: {
              principal_id: offlinePrincipalId,
              mode: "transferred",
              permissions: ["score:read", "score:write"],
              session_expires_at: expiresAt,
            },
            writer: { generation: 3, expires_at: null, read_only: true },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await heartbeatScoringSession(
      bffRequest(
        "POST",
        "/api/scoring/session/heartbeat",
        { lastAcknowledgedSequence: 0, pendingEventCount: 0, pendingThroughSequence: null },
        sealedCookie(),
      ),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    const sealed = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";

    expect(response.status).toBe(200);
    expect(new ScoringSessionSealer(sealKey).open(sealed)).toMatchObject({
      mode: "transferred",
      generation: 3,
      leaseExpiresAt: null,
    });
  });

  it("returns the runtime takeover id without exposing the scoring session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        id: eventId,
        status: "pending",
        incumbent_pending_state: "none",
        requested_at: "2026-07-27T10:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestScoringTakeover(
      bffRequest(
        "POST",
        "/api/scoring/takeover",
        { pendingEventCount: 0, pendingThroughSequence: null },
        sealedCookie({ ...auth, mode: "candidate", generation: null, leaseExpiresAt: null }),
      ),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending", requestId: eventId });
  });

  it("clears invalid, expired, and upstream-rejected sessions while preserving conflicts", async () => {
    const expiredAuth = { ...auth, expiresAt: "2021-01-01T00:00:00.000Z" };
    const expiredSealed = new ScoringSessionSealer(sealKey, () => Date.parse("2020-01-01T00:00:00.000Z")).seal(
      expiredAuth,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ message: sessionToken }, 403))
      .mockResolvedValueOnce(json({ message: sessionToken }, 409));
    vi.stubGlobal("fetch", fetchMock);

    const expired = await recoverScoringSession(
      bffRequest("GET", "/api/scoring/session", undefined, `${scoringSessionCookieName}=${expiredSealed}`),
    );
    const rejected = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));
    const conflict = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));

    expect(expired.status).toBe(401);
    expect(expired.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: "access" });
    expect(rejected.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflict" });
    expect(conflict.headers.get("set-cookie")).toBeNull();
  });

  it("clears a pre-existing scoring cookie when access exchange is rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ message: sessionToken }, 403));
    vi.stubGlobal("fetch", fetchMock);

    const response = await exchangeScoringSession(
      bffRequest("POST", "/api/scoring/access/exchange", exchangeBody, sealedCookie()),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access" });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain(sessionToken);
  });

  it.each([
    ["ACCESS_EXPIRED", "expired"],
    ["ACCESS_REVOKED", "revoked"],
    ["ACCESS_RATE_LIMITED", "rate_limited"],
  ])("maps the API error envelope %s to the safe browser state %s", async (code, expectedState) => {
    const status = code === "ACCESS_RATE_LIMITED" ? 429 : 403;
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        {
          error: {
            code,
            message: "Sensitive upstream detail is not exposed.",
            request_id: eventId,
          },
        },
        status,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await exchangeScoringSession(
      bffRequest("POST", "/api/scoring/access/exchange", exchangeBody, sealedCookie()),
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: expectedState, code });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("issues offline authority without exposing the raw resume secret to browser code", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(headerValue(init, "x-scoring-session-token")).toBe(sessionToken);
      expect(String(init?.body)).not.toContain(offlineResumeSecret);
      return json({
        principal_id: offlinePrincipalId,
        authorization_id: offlineAuthorizationId,
        resume_secret: offlineResumeSecret,
        competition_id: competitionId,
        match_id: matchId,
        generation: 3,
        recording_expires_at: offlineRecordingExpiresAt,
        replay_expires_at: offlineReplayExpiresAt,
        pass_expires_at: expiresAt,
        status: "active",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await establishOfflineScoringAuthority(
      bffRequest(
        "POST",
        "/api/scoring/offline/authority",
        { ...offlineAuthorityBody, intent: "prepare" },
        sealedCookie(),
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain(`${offlineGrantCookieName}=`);
    expect(response.headers.get("set-cookie")).toContain("Path=/api/scoring/offline");
    expect(JSON.stringify(payload)).not.toContain(offlineResumeSecret);
    expect(payload).toEqual({
      offline: {
        principal_id: offlinePrincipalId,
        authorization_id: offlineAuthorizationId,
        competition_id: competitionId,
        match_id: matchId,
        generation: 3,
        recording_expires_at: offlineRecordingExpiresAt,
        replay_expires_at: offlineReplayExpiresAt,
        pass_expires_at: expiresAt,
        status: "active",
      },
    });
  });

  it("resumes an expired ordinary session from the sealed grant and rotates both cookies", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.resume_secret).toBe(offlineResumeSecret);
        return json({
          session: exchangedSession,
          offline: {
            principal_id: offlinePrincipalId,
            authorization_id: offlineAuthorizationId,
            resume_secret: "s".repeat(43),
            competition_id: competitionId,
            match_id: matchId,
            generation: 3,
            recording_expires_at: offlineRecordingExpiresAt,
            replay_expires_at: offlineReplayExpiresAt,
            pass_expires_at: expiresAt,
            status: "active",
          },
        });
      })
      .mockResolvedValueOnce(json(state()));
    vi.stubGlobal("fetch", fetchMock);

    const response = await establishOfflineScoringAuthority(
      bffRequest(
        "POST",
        "/api/scoring/offline/authority",
        { ...offlineAuthorityBody, intent: "resume" },
        sealedOfflineCookie(),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      session: { through_sequence: 1 },
      offline: { authorization_id: offlineAuthorizationId },
    });
    expect(response.headers.get("set-cookie")).toContain(scoringSessionCookieName);
    expect(response.headers.get("set-cookie")).toContain(offlineGrantCookieName);
    expect(response.headers.get("set-cookie")).not.toContain(offlineResumeSecret);
  });

  it.each([
    ["missing", sealedCookie()],
    ["invalid", `${sealedCookie()}; ${offlineGrantCookieName}=not-a-valid-sealed-grant`],
  ])("rejects resume with a %s offline grant instead of issuing new authority", async (_label, cookie) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await establishOfflineScoringAuthority(
      bffRequest("POST", "/api/scoring/offline/authority", { ...offlineAuthorityBody, intent: "resume" }, cookie),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "access" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews recording authority through the authenticated writer instead of treating preparation as resume", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/api/v1/scoring/offline-authorizations");
      expect(String(input)).not.toContain(`/${offlineAuthorizationId}/resume`);
      expect(headerValue(init, "x-scoring-session-token")).toBe(sessionToken);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        resume_secret: offlineResumeSecret,
      });
      return json({
        principal_id: offlinePrincipalId,
        authorization_id: offlineAuthorizationId,
        resume_secret: offlineResumeSecret,
        competition_id: competitionId,
        match_id: matchId,
        generation: 3,
        recording_expires_at: offlineRecordingExpiresAt,
        replay_expires_at: offlineReplayExpiresAt,
        pass_expires_at: expiresAt,
        status: "active",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await establishOfflineScoringAuthority(
      bffRequest(
        "POST",
        "/api/scoring/offline/authority",
        { ...offlineAuthorityBody, intent: "prepare" },
        `${sealedCookie()}; ${sealedOfflineCookie()}`,
      ),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain(offlineGrantCookieName);
  });

  it("revokes the server grant and expires the path-scoped cookie", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect(JSON.parse(String(init?.body))).toEqual({
        resume_secret: offlineResumeSecret,
        device_id: deviceId,
        preserve_writer_session: false,
      });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await revokeOfflineScoringAuthority(
      bffRequest(
        "DELETE",
        "/api/scoring/offline/authority",
        { deviceId, intent: "end_session" },
        sealedOfflineCookie(),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get("set-cookie")).toContain(`${offlineGrantCookieName}=`);
    expect(response.headers.get("set-cookie")).toContain(`${scoringSessionCookieName}=`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rolls back failed shell preparation without revoking the ordinary writer session", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        resume_secret: offlineResumeSecret,
        device_id: deviceId,
        preserve_writer_session: true,
      });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await revokeOfflineScoringAuthority(
      bffRequest(
        "DELETE",
        "/api/scoring/offline/authority",
        { deviceId, intent: "preparation_rollback" },
        sealedOfflineCookie(),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${offlineGrantCookieName}=`);
    expect(response.headers.get("set-cookie")).not.toContain(`${scoringSessionCookieName}=`);
  });

  it("retains local rollback recovery state when the sealed offline grant is unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await revokeOfflineScoringAuthority(
      bffRequest("DELETE", "/api/scoring/offline/authority", {
        deviceId,
        intent: "preparation_rollback",
      }),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects cross-origin mutations without forwarding or logging supplied secrets", async () => {
    const fetchMock = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const response = await exchangeScoringSession(
      bffRequest("POST", "/api/scoring/access/exchange", exchangeBody, undefined, "https://evil.test"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("browser scoring transport source", () => {
  it("contains no browser credential persistence or direct/public API credential transport", async () => {
    const source = await readFile(new URL("../../lib/phase2-scoring.ts", import.meta.url), "utf8");
    const directFetches = source.match(/\bfetch\(/g) ?? [];
    const scoringEndpoints = [...source.matchAll(/\bscoringFetch\(\s*["']([^"']+)["']/g)].map((match) => match[1]);

    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("NEXT_PUBLIC_MATCHDAY_API_BASE_URL");
    expect(source).not.toContain("x-scoring-session-token");
    expect(source).not.toContain("session_token");
    expect(directFetches).toHaveLength(1);
    expect(source).toContain("return await fetch(input, init);");
    expect(scoringEndpoints.length).toBeGreaterThan(0);
    expect(source.match(/\bscoringFetch\(/g)).toHaveLength(scoringEndpoints.length + 1);
    expect(scoringEndpoints.every((endpoint) => endpoint?.startsWith("/api/scoring/"))).toBe(true);
  });
});
