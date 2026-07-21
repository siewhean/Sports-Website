import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScoringCommandPort, ScoringTransportError } from "../../lib/phase2-scoring";
import { phase2Machine } from "../../lib/phase2";

const matchId = "00000000-0000-4000-8000-000000000102";
const eventId = "00000000-0000-4000-8000-000000000103";

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
    writer: { generation: 3, expires_at: "2030-01-01T00:00:00.000Z", read_only: false },
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
  it("settles token exchange before sanitising the App Router URL", async () => {
    const source = await readFile(new URL("../../components/phase2/PhoneScoring.tsx", import.meta.url), "utf8");
    const tokenBranch = source.indexOf("if (tokenMatch?.[1])");
    const exchange = source.indexOf(".exchangeAccess({ token })", tokenBranch);
    const resolution = source.indexOf(".then((session)", exchange);
    const sanitisation = source.indexOf("window.history.replaceState", resolution);

    expect(tokenBranch).toBeGreaterThan(-1);
    expect(exchange).toBeGreaterThan(tokenBranch);
    expect(resolution).toBeGreaterThan(exchange);
    expect(sanitisation).toBeGreaterThan(resolution);
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

    const session = await port.exchangeAccess({ token: accessToken });
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
      .mockResolvedValueOnce(Response.json({ error: "access" }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: "conflict" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const port = createScoringCommandPort("api");

    await expect(port.recoverSession()).resolves.toBeNull();
    await expect(port.exchangeAccess({ shortCode: "123456789012" })).rejects.toMatchObject({
      state: "conflict",
      message: "conflict",
    } satisfies Partial<ScoringTransportError>);
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

    const session = await createScoringCommandPort("api").exchangeAccess({ shortCode: "123456789012" });

    expect(session.events).toEqual([]);
  });
});
