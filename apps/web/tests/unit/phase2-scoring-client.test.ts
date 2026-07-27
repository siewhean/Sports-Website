import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScoringCommandPort, refreshScoringSessionAccess, ScoringTransportError } from "../../lib/phase2-scoring";
import { phase2Machine, type ScoringSessionView } from "../../lib/phase2";
import { LatestRequestFence } from "../../lib/latest-request";

const matchId = "00000000-0000-4000-8000-000000000102";
const eventId = "00000000-0000-4000-8000-000000000103";

function sessionView(overrides: Partial<ScoringSessionView> = {}): ScoringSessionView {
  return {
    competitionSlug: "singapore-open",
    matchId,
    matchLabel: "Match 12",
    stage: "Group B",
    home: "Marina Blue",
    away: "Harbour Gold",
    homeScore: 0,
    awayScore: 0,
    events: [],
    throughSequence: 0,
    mode: "writer",
    permissions: ["score:read", "score:write"],
    generation: 3,
    leaseExpiresAt: "2030-01-01T00:00:45.000Z",
    expiresAt: "2030-01-01T00:30:00.000Z",
    takeoverStatus: "none",
    readOnly: false,
    ...overrides,
  };
}

function stateResponse(events: Array<Record<string, unknown>> = []): Response {
  return Response.json({
    competition: { slug: "singapore-open" },
    match: {
      id: matchId,
      code: "M-12",
      stage: "Group B",
      home: { id: null, name: "Marina Blue" },
      away: { id: null, name: "Harbour Gold" },
    },
    access: {
      mode: "writer",
      permissions: ["score:read", "score:write"],
      generation: 3,
      lease_expires_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:30:00.000Z",
      read_only: false,
      takeover_status: "none",
    },
    score: { home: 0, away: 0 },
    through_sequence: 0,
    events,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("phase 2 browser scoring transport", () => {
  it("removes the fragment before device lookup or token exchange", async () => {
    const source = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");
    const tokenRead = source.indexOf("fragment.get(phase2Machine.access)");
    const sanitisation = source.indexOf("window.history.replaceState", tokenRead);
    const identity = source.indexOf("getScoringDeviceIdentity()", sanitisation);
    const exchange = source.indexOf("port.exchangeAccess({ token, device: identity })", identity);

    expect(tokenRead).toBeGreaterThan(-1);
    expect(sanitisation).toBeGreaterThan(tokenRead);
    expect(identity).toBeGreaterThan(sanitisation);
    expect(exchange).toBeGreaterThan(identity);
    expect(source).not.toContain("window.location.pathname.match");
  });

  it("appends the canonical match-start event before the UI enters live scoring", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ sequence: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await createScoringCommandPort("api").appendEvent({
      clientEventId: eventId,
      matchId,
      eventType: phase2Machine.matchStarted,
      scorer: "",
      period: 1,
      manualTime: "00:00",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/scoring/events");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      client_event_id: eventId,
      type: phase2Machine.matchStarted,
      manual_period: 1,
      manual_event_seconds: 0,
      payload: {},
    });

    const source = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");
    const startHandler = source.indexOf("const startScoring = async () =>");
    const append = source.indexOf("await port.appendEvent", startHandler);
    const live = source.indexOf('setPhase("live")', append);
    expect(startHandler).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(startHandler);
    expect(live).toBeGreaterThan(append);
  });

  it("uses only relative BFF URLs and same-origin cookies for exchange, recovery, events, and finalisation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(stateResponse())
      .mockResolvedValueOnce(stateResponse())
      .mockResolvedValueOnce(Response.json({ sequence: 7 }))
      .mockResolvedValueOnce(Response.json({ match_id: matchId, result_version: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const port = createScoringCommandPort("api");
    const accessToken = "one-time-access-secret-that-is-never-in-a-fetch-url-01";

    const device = { id: "00000000-0000-4000-8000-000000000106", label: "Test device" };
    const session = await port.exchangeAccess({ token: accessToken, device });
    await port.recoverSession();
    await port.appendEvent({
      clientEventId: eventId,
      matchId,
      eventType: phase2Machine.goal,
      team: "home",
      scorer: "A. Player",
      period: 1,
      manualTime: "01:35",
    });
    const receipt = await port.finalizeResult({ matchId, homeScore: 1, awayScore: 0, scorer: "A. Player" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/scoring/access/exchange",
      "/api/scoring/session",
      "/api/scoring/events",
      "/api/scoring/finalise",
    ]);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes(accessToken))).toBe(true);
    expect(
      fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("x-scoring-session-token") === null),
    ).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => init?.credentials === "same-origin")).toBe(true);
    expect(session.competitionSlug).toBe("singapore-open");
    expect(receipt.receiptId).toBe(`${matchId}:v2`);
  });

  it("treats absent recovery credentials as no recovered session and preserves conflict state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ error: "conflict" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const port = createScoringCommandPort("api");

    await expect(port.recoverSession()).resolves.toBeNull();
    await expect(
      port.exchangeAccess({
        shortCode: "123456789012",
        device: { id: "00000000-0000-4000-8000-000000000106", label: "Test device" },
      }),
    ).rejects.toMatchObject({
      state: "conflict",
      message: "conflict",
    } satisfies Partial<ScoringTransportError>);
  });

  it("preserves a revoked state when a stored scoring session is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "revoked" }, { status: 403 })));

    await expect(createScoringCommandPort("api").recoverSession()).rejects.toMatchObject({
      state: "revoked",
      message: "revoked",
    } satisfies Partial<ScoringTransportError>);
  });

  it("keeps an authoritative read-only writer lease fenced after foreground recovery", async () => {
    const response = stateResponse();
    const payload = (await response.json()) as Record<string, unknown>;
    payload.access = { ...(payload.access as Record<string, unknown>), read_only: true };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));

    const session = await createScoringCommandPort("api").recoverSession();

    expect(session).toMatchObject({ mode: "writer", generation: 3, readOnly: true });
  });

  it("recovers a promoted candidate before heartbeat can use the new writer generation", async () => {
    const recovered = sessionView({ generation: 6 });
    const heartbeaten = sessionView({ generation: 6, leaseExpiresAt: "2030-01-01T00:00:50.000Z" });
    const calls: string[] = [];
    const port = {
      recoverSession: vi.fn(async () => {
        calls.push("recover");
        return recovered;
      }),
      heartbeat: vi.fn(async () => {
        calls.push("heartbeat");
        return heartbeaten;
      }),
    };

    const session = await refreshScoringSessionAccess(
      port,
      {
        lastAcknowledgedSequence: 4,
        pendingEventCount: 0,
        pendingThroughSequence: null,
      },
      true,
    );

    expect(calls).toEqual(["recover", "heartbeat"]);
    expect(session).toEqual(heartbeaten);
  });

  it("does not heartbeat a candidate until authoritative recovery promotes it", async () => {
    const candidate = sessionView({
      mode: "candidate",
      generation: null,
      leaseExpiresAt: null,
      readOnly: true,
      takeoverStatus: "pending",
    });
    const port = {
      recoverSession: vi.fn(async () => candidate),
      heartbeat: vi.fn(async () => candidate),
    };

    const session = await refreshScoringSessionAccess(
      port,
      {
        lastAcknowledgedSequence: 0,
        pendingEventCount: 0,
        pendingThroughSequence: null,
      },
      true,
    );

    expect(session).toEqual(candidate);
    expect(port.heartbeat).not.toHaveBeenCalled();
  });

  it("does not apply a pre-event refresh after a newer scoring append succeeds", async () => {
    let resolveRefresh: (value: ScoringSessionView) => void = () => undefined;
    const refresh = new Promise<ScoringSessionView>((resolve) => {
      resolveRefresh = resolve;
    });
    const fence = new LatestRequestFence();
    const committed: ScoringSessionView[] = [];
    const run = fence.run(
      () => refresh,
      (session) => committed.push(session),
    );

    fence.cancel();
    const appendReceipt = await Promise.resolve({ sequence: 5, syncState: "acknowledged" });
    resolveRefresh(sessionView({ generation: 6 }));
    await run;

    expect(appendReceipt).toEqual({ sequence: 5, syncState: "acknowledged" });
    expect(committed).toEqual([]);
  });

  it("removes recovered cards that have a card reversal event", async () => {
    const cardId = "00000000-0000-4000-8000-000000000104";
    const reverseId = "00000000-0000-4000-8000-000000000105";
    const common = {
      team_slot: "home",
      scorer: "A. Player",
      manual_period: 1,
      manual_event_seconds: 95,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      stateResponse([
        {
          ...common,
          client_event_id: cardId,
          type: "card_added",
          payload: { colour: "yellow", person_id: "A. Player" },
        },
        {
          ...common,
          client_event_id: reverseId,
          type: "card_reversed",
          payload: { reversal_target_event_id: cardId },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await createScoringCommandPort("api").exchangeAccess({
      shortCode: "123456789012",
      device: { id: "00000000-0000-4000-8000-000000000106", label: "Test device" },
    });

    expect(session.events).toEqual([]);
  });
});
