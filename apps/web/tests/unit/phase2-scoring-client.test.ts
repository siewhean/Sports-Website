import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalSegmentNumber,
  recoveredOfflineState,
  createScoringCommandPort,
  refreshScoringSessionAccess,
  scoringRefreshFailureState,
  scoringSessionAnnouncement,
  scoringMutationIsLocked,
  terminalOfflineQueueState,
  scoringWriterAvailability,
  ScoringTransportError,
} from "../../lib/phase2-scoring";
import { phase2Copy, phase2Machine, type ScoringSessionView } from "../../lib/phase2";
import { LatestRequestFence } from "../../lib/latest-request";
import { SPORT_PACKS } from "@matchday/domain";

const matchId = "00000000-0000-4000-8000-000000000102";
const eventId = "00000000-0000-4000-8000-000000000103";

function sessionView(overrides: Partial<ScoringSessionView> = {}): ScoringSessionView {
  return {
    principalId: "a".repeat(64),
    competitionSlug: "singapore-open",
    sportId: "canoe_polo",
    sportPackVersion: SPORT_PACKS.canoe_polo.version,
    sportSettings: SPORT_PACKS.canoe_polo.recommendedSettings,
    matchId,
    matchLabel: "Match 12",
    stage: "Group B",
    home: "Marina Blue",
    away: "Harbour Gold",
    homeScore: 0,
    awayScore: 0,
    scoreState: {
      home: 0,
      away: 0,
      lifecycle: "in_progress",
      currentSegment: 1,
      totalPoints: { home: 0, away: 0 },
      segmentWins: { home: 0, away: 0 },
      segments: [{ number: 1, home: 0, away: 0, completed: false, winner: null }],
      actions: [],
      conflicts: [],
    },
    events: [],
    canonicalEvents: [],
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

function stateResponse(
  events: Array<Record<string, unknown>> = [],
  packVersion: string = SPORT_PACKS.canoe_polo.version,
): Response {
  return Response.json({
    competition: { slug: "singapore-open", sport_code: "canoe_polo" },
    sport: {
      pack_version: packVersion,
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
      mode: "writer",
      permissions: ["score:read", "score:write"],
      generation: 3,
      lease_expires_at: "2030-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:30:00.000Z",
      read_only: false,
      takeover_status: "none",
    },
    score: {
      home: 0,
      away: 0,
      lifecycle: "in_progress",
      current_segment: 1,
      total_points: { home: 0, away: 0 },
      segment_wins: { home: 0, away: 0 },
      segments: [{ number: 1, home: 0, away: 0, completed: false, winner: null }],
      actions: [],
      conflicts: [],
    },
    through_sequence: 0,
    events,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Gate C3 offline mutation gating", () => {
  it("keeps valid offline recording writable after the ordinary writer lease expires", () => {
    expect(
      scoringMutationIsLocked({
        writerState: "expiring",
        offlineState: "offline-recording",
        hasOfflineAuthorization: true,
        pendingCount: 0,
        queueLimit: 2_000,
      }),
    ).toBe(false);
    expect(
      scoringMutationIsLocked({
        writerState: "expired",
        offlineState: "pending-sync",
        hasOfflineAuthorization: true,
        pendingCount: 1,
        queueLimit: 2_000,
      }),
    ).toBe(false);
  });

  it("classifies every terminal offline queue rejection for modal dismissal and status focus", () => {
    for (const availability of ["recording_expired", "replay_expired", "pass_expired", "expired"]) {
      expect(terminalOfflineQueueState(`Offline scoring cannot accept another command: ${availability}.`)).toBe(
        "expired",
      );
    }
    expect(terminalOfflineQueueState("Offline scoring cannot accept another command: revoked.")).toBe("revoked");
    expect(terminalOfflineQueueState("Offline scoring cannot accept another command: transferred.")).toBe("read-only");
    expect(terminalOfflineQueueState("Offline scoring cannot accept another command: completed.")).toBe("read-only");
    expect(terminalOfflineQueueState("Offline scoring cannot accept another command: queue_full.")).toBeNull();
    expect(terminalOfflineQueueState("The request was completed.")).toBeNull();
  });

  it("derives restart state from authoritative offline time boundaries", () => {
    const common = {
      status: "active" as const,
      recordingExpiresAt: "2026-07-28T04:00:00.000Z",
      replayExpiresAt: "2026-07-28T04:15:00.000Z",
      passExpiresAt: "2026-07-28T05:00:00.000Z",
      pendingCount: 1,
    };
    expect(recoveredOfflineState({ ...common, now: Date.parse("2026-07-28T03:59:59.999Z") })).toBe("pending-sync");
    expect(recoveredOfflineState({ ...common, now: Date.parse(common.recordingExpiresAt) })).toBe("expired");
    expect(recoveredOfflineState({ ...common, now: Date.parse(common.replayExpiresAt) })).toBe("expired");
    expect(recoveredOfflineState({ ...common, now: Date.parse(common.passExpiresAt) })).toBe("expired");
    expect(recoveredOfflineState({ ...common, status: "revoked", now: 0 })).toBe("revoked");
    expect(recoveredOfflineState({ ...common, status: "transferred", now: 0 })).toBe("read-only");
    expect(recoveredOfflineState({ ...common, status: "completed", now: 0 })).toBe("read-only");
  });

  it.each(["reconnecting", "replaying", "pending-finalisation", "conflict", "expired", "revoked", "read-only"])(
    "keeps %s offline state read-only even with a retained authorization",
    (offlineState) => {
      expect(
        scoringMutationIsLocked({
          writerState: "active",
          offlineState,
          hasOfflineAuthorization: true,
          pendingCount: 1,
          queueLimit: 2_000,
        }),
      ).toBe(true);
    },
  );

  it("requires a retained authorization and enforces the unresolved-command cap", () => {
    expect(
      scoringMutationIsLocked({
        writerState: "expired",
        offlineState: "offline-recording",
        hasOfflineAuthorization: false,
        pendingCount: 0,
        queueLimit: 2_000,
      }),
    ).toBe(true);
    expect(
      scoringMutationIsLocked({
        writerState: "active",
        offlineState: "offline-recording",
        hasOfflineAuthorization: true,
        pendingCount: 2_000,
        queueLimit: 2_000,
      }),
    ).toBe(true);
  });
});

describe("phase 2 browser scoring transport", () => {
  it("submits Basketball overtime against the next authoritative segment", () => {
    expect(canonicalSegmentNumber(phase2Machine.overtime, 4, 4)).toBe(5);
    expect(canonicalSegmentNumber("three_point_score", 4, 4)).toBe(4);
  });

  it("distinguishes a lapsed writer lease from a genuinely expired scoring session", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");

    expect(scoringWriterAvailability(sessionView(), now)).toBe("active");
    expect(
      scoringWriterAvailability(
        sessionView({
          leaseExpiresAt: "2030-01-01T00:00:10.000Z",
        }),
        now,
      ),
    ).toBe("expiring");
    expect(
      scoringWriterAvailability(
        sessionView({
          leaseExpiresAt: "2029-12-31T23:59:59.000Z",
          readOnly: true,
        }),
        now,
      ),
    ).toBe("expiring");
    expect(
      scoringWriterAvailability(
        sessionView({
          expiresAt: "2030-01-01T00:00:00.000Z",
        }),
        now,
      ),
    ).toBe("expired");
  });

  it("announces the effective writer, candidate, transferred and viewer states truthfully", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    expect(scoringSessionAnnouncement(sessionView(), now)).toBe(phase2Copy.accessRestored);
    expect(
      scoringSessionAnnouncement(
        sessionView({
          leaseExpiresAt: "2029-12-31T23:59:59.000Z",
          readOnly: true,
        }),
        now,
      ),
    ).toBe(phase2Copy.leaseExpiring);
    expect(scoringSessionAnnouncement(sessionView({ expiresAt: "2030-01-01T00:00:00.000Z" }), now)).toBe(
      phase2Copy.sessionExpired,
    );
    expect(scoringSessionAnnouncement(sessionView({ mode: "candidate", readOnly: true }), now)).toBe(
      phase2Copy.candidate,
    );
    expect(scoringSessionAnnouncement(sessionView({ mode: "transferred", readOnly: true }), now)).toBe(
      phase2Copy.transferred,
    );
    expect(scoringSessionAnnouncement(sessionView({ mode: "viewer", readOnly: true }), now)).toBe(phase2Copy.readOnly);
  });

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

  it("fails closed when the authoritative sport-pack version differs from the local executable pack", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stateResponse([], "canoe-polo-stale-v0")));

    await expect(createScoringCommandPort("api").recoverSession()).rejects.toMatchObject({
      state: "unavailable",
    });
  });

  it("classifies a cold-start network rejection as unavailable so IndexedDB recovery can run", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(createScoringCommandPort("api").recoverSession()).rejects.toMatchObject({
      state: "unavailable",
      message: "unavailable",
    } satisfies Partial<ScoringTransportError>);
  });

  it("appends the canonical match-start event before the UI enters live scoring", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ sequence: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await createScoringCommandPort("api").appendEvent({
      clientEventId: eventId,
      expectedSequence: 0,
      matchId,
      eventType: phase2Machine.matchStarted,
      canonical: true,
      scorer: "",
      period: 1,
      manualTime: "00:00",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/scoring/events");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      client_event_id: eventId,
      expected_sequence: 0,
      type: phase2Machine.matchStarted,
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
      .mockResolvedValueOnce(
        Response.json({
          client_event_id: eventId,
          event_id: eventId,
          command_fingerprint: "a".repeat(64),
          duplicate: false,
          sequence: 7,
          aggregate_version: 7,
          server_received_at: "2026-07-28T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          client_event_id: "00000000-0000-4000-8000-000000000104",
          event_id: "00000000-0000-4000-8000-000000000105",
          command_fingerprint: "b".repeat(64),
          duplicate: false,
          match_id: matchId,
          sequence: 8,
          aggregate_version: 8,
          result_version: 2,
          publication_version: 2,
          server_received_at: "2026-07-28T00:00:01.000Z",
          published_at: "2026-07-28T00:00:01.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const port = createScoringCommandPort("api");
    const accessToken = "one-time-access-secret-that-is-never-in-a-fetch-url-01";

    const device = { id: "00000000-0000-4000-8000-000000000106", label: "Test device" };
    const session = await port.exchangeAccess({ token: accessToken, device });
    await port.recoverSession();
    await port.appendEvent({
      clientEventId: eventId,
      expectedSequence: session.throughSequence,
      matchId,
      eventType: phase2Machine.goal,
      canonical: true,
      team: "home",
      scorer: "A. Player",
      period: 1,
      manualTime: "01:35",
    });
    const receipt = await port.finalizeResult({
      clientEventId: "00000000-0000-4000-8000-000000000104",
      matchId,
      expectedSequence: session.throughSequence + 1,
      homeScore: 1,
      awayScore: 0,
      scorer: "A. Player",
      occurredAt: "2026-07-28T00:00:00.500Z",
    });

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
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      expected_sequence: session.throughSequence,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
      expected_sequence: session.throughSequence + 1,
    });
    expect(session.competitionSlug).toBe("singapore-open");
    expect(receipt.receiptId).toBe(`${matchId}:v2`);
  });

  it("maps a canonical five-sport action and reasoned reversal without legacy aliases", async () => {
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => Response.json({ sequence: 9 }));
    vi.stubGlobal("fetch", fetchMock);
    const port = createScoringCommandPort("api");

    await port.appendEvent({
      clientEventId: eventId,
      expectedSequence: 8,
      matchId,
      eventType: "three_point_score",
      canonical: true,
      team: "away",
      scorer: "Player 14",
      participantId: "Player 14",
      period: 4,
      segmentNumber: 4,
      manualTime: "00:42",
      manualTimeSeconds: 42,
      occurredAt: "2026-07-28T00:00:00.000Z",
    });
    await port.appendEvent({
      clientEventId: "00000000-0000-4000-8000-000000000104",
      expectedSequence: 9,
      matchId,
      eventType: "reversal",
      canonical: true,
      scorer: "",
      period: 4,
      manualTime: "00:42",
      reversalTargetEventId: eventId,
      reason: "Wrong team",
      occurredAt: "2026-07-28T00:00:02.000Z",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      client_event_id: eventId,
      expected_sequence: 8,
      type: "three_point_score",
      occurred_at: "2026-07-28T00:00:00.000Z",
      team_slot: "away",
      participant_id: "Player 14",
      segment_number: 4,
      manual_time_seconds: 42,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      expected_sequence: 9,
      type: "reversal",
      reversal_target_event_id: eventId,
      reason: "Wrong team",
    });
  });

  it("omits participant_id for a canonical action that has no attribution", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ sequence: 6 }));
    vi.stubGlobal("fetch", fetchMock);

    await createScoringCommandPort("api").appendEvent({
      clientEventId: eventId,
      expectedSequence: 5,
      matchId,
      eventType: "point",
      canonical: true,
      team: "home",
      scorer: "",
      period: 1,
      segmentNumber: 1,
      manualTime: "00:00",
      occurredAt: "2026-07-28T00:00:00.000Z",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      client_event_id: eventId,
      expected_sequence: 5,
      type: "point",
      occurred_at: "2026-07-28T00:00:00.000Z",
      team_slot: "home",
      segment_number: 1,
    });
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

  it("returns a promoted candidate recovery before a heartbeat can depend on its rotated cookie", async () => {
    const recovered = sessionView({ generation: 6 });
    const calls: string[] = [];
    const port = {
      recoverSession: vi.fn(async () => {
        calls.push("recover");
        return recovered;
      }),
      heartbeat: vi.fn(async () => {
        calls.push("heartbeat");
        return recovered;
      }),
    };

    const session = await refreshScoringSessionAccess(
      port,
      {
        lastAcknowledgedSequence: 4,
        pendingEventCount: 0,
        pendingThroughSequence: null,
      },
      "promotion",
    );

    expect(calls).toEqual(["recover"]);
    expect(session).toEqual(recovered);
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
      "promotion",
    );

    expect(session).toEqual(candidate);
    expect(port.heartbeat).not.toHaveBeenCalled();
  });

  it("heartbeats an existing writer when no authoritative promotion recovery is required", async () => {
    const heartbeaten = sessionView({ generation: 6, leaseExpiresAt: "2030-01-01T00:00:50.000Z" });
    const port = {
      recoverSession: vi.fn(async () => heartbeaten),
      heartbeat: vi.fn(async () => heartbeaten),
    };

    const session = await refreshScoringSessionAccess(
      port,
      {
        lastAcknowledgedSequence: 4,
        pendingEventCount: 0,
        pendingThroughSequence: null,
      },
      "none",
    );

    expect(session).toEqual(heartbeaten);
    expect(port.recoverSession).not.toHaveBeenCalled();
    expect(port.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("recovers and then heartbeats an expiring writer to renew the authoritative lease", async () => {
    const recovered = sessionView({ generation: 6, leaseExpiresAt: "2030-01-01T00:00:05.000Z" });
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
      "renewal",
    );

    expect(calls).toEqual(["recover", "heartbeat"]);
    expect(session).toEqual(heartbeaten);
  });

  it("preserves authenticated context when a background refresh is transiently unavailable", () => {
    expect(scoringRefreshFailureState("candidate", new ScoringTransportError("unavailable"), true)).toBe("candidate");
    expect(scoringRefreshFailureState("active", new ScoringTransportError("unavailable"), true)).toBe("expiring");
    expect(scoringRefreshFailureState("transferred", new Error("malformed transient response"), true)).toBe(
      "transferred",
    );
  });

  it("delegates terminal refresh failures and unauthenticated failures to the access error handler", () => {
    for (const state of ["access", "conflict", "expired", "invalid", "rate_limited", "revoked"] as const) {
      expect(scoringRefreshFailureState("active", new ScoringTransportError(state), true)).toBeNull();
    }
    expect(scoringRefreshFailureState("candidate", new ScoringTransportError("unavailable"), false)).toBeNull();
  });

  it("fails active scoring writes closed while transient refresh recovery retries", () => {
    const writerState = scoringRefreshFailureState("active", new ScoringTransportError("unavailable"), true);

    expect(writerState).toBe("expiring");
    expect(
      scoringMutationIsLocked({
        writerState: writerState ?? "active",
        offlineState: "online",
        hasOfflineAuthorization: false,
        pendingCount: 0,
        queueLimit: 2_000,
      }),
    ).toBe(true);
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

  it("lets a terminal mutation drain an active heartbeat without aborting it", async () => {
    let resolveRefresh: (value: ScoringSessionView) => void = () => undefined;
    const refresh = new Promise<ScoringSessionView>((resolve) => {
      resolveRefresh = resolve;
    });
    const fence = new LatestRequestFence();
    const run = fence.run(
      () => refresh,
      () => undefined,
    );
    let idle = false;
    const wait = fence.waitForIdle().then(() => {
      idle = true;
    });

    await Promise.resolve();
    expect(idle).toBe(false);
    resolveRefresh(sessionView({ generation: 6 }));
    await Promise.all([run, wait]);

    expect(idle).toBe(true);
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

  it("classifies semantic rejection separately so the scorer can retain interaction context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "invalid" }, { status: 422 })));

    await expect(
      createScoringCommandPort("api").appendEvent({
        clientEventId: eventId,
        expectedSequence: 4,
        matchId,
        eventType: "game_completion",
        canonical: true,
        team: "home",
        scorer: "",
        period: 1,
        segmentNumber: 1,
        manualTime: "00:00",
      }),
    ).rejects.toMatchObject({ state: "invalid" });
  });
});
