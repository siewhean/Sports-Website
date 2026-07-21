import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendScoringEvent,
  exchangeScoringSession,
  finaliseScoringResult,
  recoverScoringSession,
} from "../../lib/scoring-bff.server";
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
const sessionToken = "server-session-secret-that-never-reaches-browser-0001";
const accessToken = "one-time-access-secret-that-stays-in-request-body-001";
const expiresAt = "2030-01-01T00:00:00.000Z";

const auth: ScoringServerAuth = { sessionId, sessionToken, generation: 3, matchId, expiresAt };

function state(extra: Record<string, unknown> = {}) {
  return {
    competition: { slug: "singapore-open" },
    match: {
      id: matchId,
      code: "M-12",
      stage: "Group B",
      home: { id: null, name: "Marina Blue" },
      away: { id: null, name: "Harbour Gold" },
    },
    writer: { generation: 3, expires_at: expiresAt, read_only: false },
    score: { home: 1, away: 0 },
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
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  cookie?: string,
  origin = webOrigin,
  requestOrigin = webOrigin,
): Request {
  const headers = new Headers();
  if (method === "POST") {
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
  it("exchanges in the request body, stores only a strict host cookie, and returns allowlisted scoring state", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/access/exchange")) {
        return json({
          session_id: sessionId,
          session_token: sessionToken,
          match_id: matchId,
          generation: 3,
          expires_at: expiresAt,
        });
      }
      return json(state({ session_id: sessionId, session_token: sessionToken }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await exchangeScoringSession(
      bffRequest("POST", "/api/scoring/access/exchange", { token: accessToken }),
    );
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
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ token: accessToken });
    expect(headerValue(calls[1]?.init, "x-scoring-session-token")).toBe(sessionToken);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps the sealed session recoverable when the post-exchange state read is transiently unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          session_id: sessionId,
          session_token: sessionToken,
          match_id: matchId,
          generation: 3,
          expires_at: expiresAt,
        }),
      )
      .mockRejectedValueOnce(new Error(`upstream failed for ${sessionToken}`));
    vi.stubGlobal("fetch", fetchMock);

    const response = await exchangeScoringSession(
      bffRequest("POST", "/api/scoring/access/exchange", { token: accessToken }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(response.headers.get("set-cookie")).toContain(`${scoringSessionCookieName}=`);
    expect(response.headers.get("set-cookie")).not.toContain(sessionToken);
  });

  it("accepts a strictly parsed public origin supplied by the trusted HTTPS proxy", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          session_id: sessionId,
          session_token: sessionToken,
          match_id: matchId,
          generation: 3,
          expires_at: expiresAt,
        }),
      )
      .mockResolvedValueOnce(json(state()));
    vi.stubGlobal("fetch", fetchMock);
    const request = bffRequest(
      "POST",
      "/api/scoring/access/exchange",
      { token: accessToken },
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
        { token: accessToken },
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

  it("rejects an unsafe competition slug before it can reach a public-page link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(state({ competition: { slug: "../organiser" } }))));

    const response = await recoverScoringSession(bffRequest("GET", "/api/scoring/session", undefined, sealedCookie()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("proxies events and finalisation with server-side auth and allowlisted receipts", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(headerValue(init, "x-scoring-session-token")).toBe(sessionToken);
        expect(String(init?.body)).not.toContain(sessionToken);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          type: "goal_reversed",
          payload: { reversal_target_event_id: eventId },
          correction_reason: "Scorekeeper correction",
        });
        return json({ sequence: 8, session_token: sessionToken });
      })
      .mockImplementationOnce(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(headerValue(init, "x-scoring-session-token")).toBe(sessionToken);
        return json({ match_id: matchId, result_version: 4, session_token: sessionToken });
      });
    vi.stubGlobal("fetch", fetchMock);

    const eventResponse = await appendScoringEvent(
      bffRequest(
        "POST",
        "/api/scoring/events",
        {
          client_event_id: eventId,
          type: "goal_reversed",
          team_slot: "home",
          scorer: "A. Player",
          manual_period: 1,
          manual_event_seconds: 95,
          payload: { reversal_target_event_id: eventId },
          correction_reason: "Scorekeeper correction",
          occurred_at: "2026-07-17T02:00:00.000Z",
          session_token: "browser-injected-value",
        },
        sealedCookie(),
      ),
    );
    const finalResponse = await finaliseScoringResult(
      bffRequest("POST", "/api/scoring/finalise", { client_event_id: eventId }, sealedCookie()),
    );

    expect(await eventResponse.json()).toEqual({ sequence: 8 });
    expect(await finalResponse.json()).toEqual({ match_id: matchId, result_version: 4 });
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
      bffRequest("POST", "/api/scoring/access/exchange", { token: accessToken }, sealedCookie()),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access" });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain(sessionToken);
  });

  it("rejects cross-origin mutations without forwarding or logging supplied secrets", async () => {
    const fetchMock = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const response = await exchangeScoringSession(
      bffRequest("POST", "/api/scoring/access/exchange", { token: accessToken }, undefined, "https://evil.test"),
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

    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("NEXT_PUBLIC_MATCHDAY_API_BASE_URL");
    expect(source).not.toContain("x-scoring-session-token");
    expect(source).not.toContain("session_token");
    expect(source).toContain('fetch("/api/scoring/');
  });
});
