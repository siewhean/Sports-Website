import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostgresJsSql } from "@matchday/identity";
import {
  GateCC4PublicTruthRuntime,
  PublicVersionHub,
  registerGateCC4PublicTruthRoutes,
} from "../../src/gate-c-c4-public-truth.js";
import { applyLiveOverlay, parseLiveOverlay, type LiveOverlayEntry } from "../../src/public-live-overlay.js";

const competitionId = "11111111-1111-4111-8111-111111111111";
const divisionId = "22222222-2222-4222-8222-222222222222";
const reserveDivisionId = "33333333-3333-4333-8333-333333333333";
const finalMatchId = "44444444-4444-4444-8444-444444444444";
const liveMatchId = "55555555-5555-4555-8555-555555555555";
const newLiveMatchId = "66666666-6666-4666-8666-666666666666";

function result(id: string, state: string, home: number) {
  return {
    id,
    code: `M-${id.slice(0, 2)}`,
    stage: "group",
    home: { id: null, name: "Marina Blue" },
    away: { id: null, name: "Harbour Gold" },
    home_score: home,
    away_score: 0,
    state,
    updated_at: "2026-08-01T00:00:04.000Z",
  };
}

function projection() {
  const open = {
    division: { id: divisionId, name: "Open" },
    schedule: [],
    results: [result(finalMatchId, "final", 3), result(liveMatchId, "in_progress", 1)],
    standings: null,
    bracket: null,
  };
  const reserve = {
    division: { id: reserveDivisionId, name: "Reserve" },
    schedule: [],
    results: [],
    standings: null,
    bracket: null,
  };
  return {
    competition: {
      id: competitionId,
      name: "National Open",
      slug: "national-open",
      sport_code: "badminton",
      timezone: "Asia/Singapore",
      starts_on: "2026-08-01",
      ends_on: "2026-08-03",
      status: "active",
    },
    divisions: [open, reserve],
    division: open.division,
    publication: { schedule_version: 4, result_version: 7 },
    schedule: [],
    results: open.results,
    standings: null,
    bracket: null,
  };
}

function overlayEntry(matchId: string, division: string, home: number, revision: number): LiveOverlayEntry {
  return {
    match_id: matchId,
    division_id: division,
    revision,
    updated_at: `2026-08-01T00:0${revision}:00.000Z`,
    result: { ...result(matchId, "in_progress", home), updated_at: `2026-08-01T00:0${revision}:00.000Z` },
  };
}

describe("live score overlay", () => {
  it("replaces stale live entries, adds newly live matches, and keeps the legacy division view in step", () => {
    const base = projection();
    const snapshot = JSON.stringify(base);
    const overlaid = applyLiveOverlay(base, [
      overlayEntry(liveMatchId, divisionId, 9, 3),
      overlayEntry(newLiveMatchId, reserveDivisionId, 2, 4),
    ]);
    expect(JSON.stringify(base)).toBe(snapshot);
    const [open, reserve] = overlaid.divisions;
    expect(open?.results.map((entry) => [entry.id, entry.home_score])).toEqual([
      [finalMatchId, 3],
      [liveMatchId, 9],
    ]);
    expect(reserve?.results.map((entry) => entry.id)).toEqual([newLiveMatchId]);
    expect(overlaid.results).toBe(open?.results);
    expect(applyLiveOverlay(base, [])).toBe(base);
  });

  it("rejects overlay rows whose entry does not belong to the row's match", () => {
    expect(() =>
      parseLiveOverlay([{ ...overlayEntry(liveMatchId, divisionId, 1, 1), match_id: newLiveMatchId }]),
    ).toThrow(/malformed/u);
    expect(parseLiveOverlay(null)).toEqual([]);
  });
});

function truthRow(overrides: Record<string, unknown> = {}) {
  return {
    competition_id: competitionId,
    // Stored projections arrive from JSON, so nothing in them is shared by reference.
    payload: JSON.parse(JSON.stringify(projection())) as Record<string, unknown>,
    schedule_version: 4,
    result_version: 7,
    projection_version: 3,
    live_revision: 2,
    projection_digest: "0123456789abcdef0123456789abcdef",
    base_key: `${competitionId}:4:7:2:0123456789abcdef0123456789abcdef`,
    live_overlay: [],
    live_overlay_digest: null,
    division_projection_versions: { [divisionId]: 3, [reserveDivisionId]: 2 },
    generated_at: "2026-08-01T00:00:05.000Z",
    source_updated_at: "2026-08-01T00:00:04.000Z",
    ...overrides,
  };
}

function scriptedRuntime(responses: Array<Record<string, unknown>>) {
  const calls: Array<{ query: string; parameters: readonly unknown[] }> = [];
  const sql = {
    unsafe: async (query: string, parameters: readonly unknown[]) => {
      calls.push({ query, parameters });
      const next = responses.shift();
      if (!next) throw new Error("unexpected query");
      // The database withholds the stored projection when the caller already holds it.
      return [parameters[1] !== null && parameters[1] === next.base_key ? { ...next, payload: null } : next];
    },
  } as unknown as PostgresJsSql;
  return { runtime: new GateCC4PublicTruthRuntime(sql), calls };
}

describe("public truth read path", () => {
  it("parses and privacy-checks a stored projection once, then serves cached reads per version", async () => {
    const row = truthRow();
    const { runtime, calls } = scriptedRuntime([row, row, row]);
    const first = await runtime.read("national-open");
    const second = await runtime.read("national-open");
    const reserve = await runtime.read("national-open", reserveDivisionId);
    expect(calls.map((call) => call.parameters[1])).toEqual([null, row.base_key, row.base_key]);
    // Same version: the identical composed result object is reused.
    expect(second).toBe(first);
    expect(reserve?.payload.divisions).toEqual([projection().divisions[1]]);
    expect(reserve?.freshness.etag).not.toBe(first?.freshness.etag);
    expect(first?.version).toBe("4:7:3:2");
  });

  it("changes the version, ETag and source time on every live point without a projection rewrite", async () => {
    const before = truthRow({
      live_overlay: [overlayEntry(liveMatchId, divisionId, 4, 5)],
      live_overlay_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const after = truthRow({
      live_overlay: [overlayEntry(liveMatchId, divisionId, 5, 6)],
      live_overlay_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const { runtime, calls } = scriptedRuntime([before, after]);
    const first = await runtime.read("national-open");
    const second = await runtime.read("national-open");
    // The stored projection (live_revision 2) was fetched once; the second read reused it.
    expect(calls[1]?.parameters[1]).toBe(before.base_key);
    expect(first?.version).toBe("4:7:3:2.aaaaaaaaaaaaaaaa");
    expect(second?.version).toBe("4:7:3:2.bbbbbbbbbbbbbbbb");
    expect(first?.freshness.etag).toMatch(/^c4-4-7-3-2\.aaaaaaaaaaaaaaaa-[a-f0-9]{64}$/u);
    expect(second?.freshness.etag).not.toBe(first?.freshness.etag);
    expect(second?.freshness.source_updated_at).toBe("2026-08-01T00:06:00.000Z");
    expect(second?.freshness.generated_at).toBe("2026-08-01T00:06:00.000Z");
    const open = (second?.payload.divisions as Array<{ results: Array<Record<string, unknown>> }>)[0]!;
    expect(open.results.find((entry) => entry.id === liveMatchId)?.home_score).toBe(5);
  });

  it("rejects private data in an overlay row", async () => {
    const leaked = overlayEntry(liveMatchId, divisionId, 1, 1);
    const { runtime } = scriptedRuntime([
      truthRow({
        live_overlay: [{ ...leaked, result: { ...leaked.result, scoring_session_id: "secret" } }],
        live_overlay_digest: "cccccccccccccccccccccccccccccccc",
      }),
    ]);
    await expect(runtime.read("national-open")).rejects.toThrow(/forbidden/u);
  });

  it("serves identical bytes from the route serializer and honours If-None-Match", async () => {
    const row = truthRow();
    const { runtime } = scriptedRuntime([row, row, row]);
    const app = Fastify();
    await registerGateCC4PublicTruthRoutes(app, runtime);
    await app.ready();
    try {
      const first = await app.inject("/api/v1/public/competitions/national-open/current");
      const second = await app.inject("/api/v1/public/competitions/national-open/current");
      expect(first.statusCode).toBe(200);
      expect(first.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(second.payload).toBe(first.payload);
      expect(first.json()).toMatchObject({ freshness: { projection_version: 3 }, publication: { result_version: 7 } });
      const cached = await app.inject({
        url: "/api/v1/public/competitions/national-open/current",
        headers: { "if-none-match": String(first.headers.etag) },
      });
      expect(cached.statusCode).toBe(304);
    } finally {
      await app.close();
    }
  });
});

describe("public competition listing", () => {
  const listRow = (index: number) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Open ${index}`,
    slug: `open-${index}`,
    sport_code: "badminton",
    timezone: "UTC",
    starts_on: "2026-08-01",
    ends_on: "2026-08-02",
    status: "completed",
  });

  it("pages with an opaque keyset cursor", async () => {
    const calls: Array<readonly unknown[]> = [];
    const sql = {
      unsafe: async (_query: string, parameters: readonly unknown[]) => {
        calls.push(parameters);
        return [listRow(1), listRow(2), listRow(3)].slice(0, Number(parameters[3]));
      },
    } as unknown as PostgresJsSql;
    const runtime = new GateCC4PublicTruthRuntime(sql);
    const page = await runtime.listPage({ limit: 2 });
    expect(page.competitions.map((entry) => entry.slug)).toEqual(["open-1", "open-2"]);
    expect(page.next_cursor).toEqual(expect.any(String));
    await runtime.listPage({ limit: 2, cursor: page.next_cursor! });
    expect(calls[1]).toEqual(["2026-08-01", "Open 2", listRow(2).id, 3]);
    expect((await runtime.listPage({})).next_cursor).toBeNull();
    expect(calls[2]?.[3]).toBe(51);
    await expect(runtime.listPage({ cursor: "not-a-cursor" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("exposes next_cursor only when another page exists", async () => {
    const app = Fastify();
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({ competitions: [listRow(1)], next_cursor: "abc" })
      .mockResolvedValueOnce({ competitions: [listRow(2)], next_cursor: null });
    await registerGateCC4PublicTruthRoutes(app, { list: vi.fn(), read: vi.fn(), listPage } as never);
    await app.ready();
    try {
      const first = await app.inject("/api/v1/public/competitions?limit=1");
      expect(first.json()).toMatchObject({ next_cursor: "abc" });
      expect(listPage).toHaveBeenCalledWith({ limit: 1 });
      const last = await app.inject("/api/v1/public/competitions?limit=1&cursor=abc");
      expect(last.json()).not.toHaveProperty("next_cursor");
      // Schema validation rejects the request before the runtime is called.
      expect((await app.inject("/api/v1/public/competitions?limit=0")).statusCode).toBeGreaterThanOrEqual(400);
      expect(listPage).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

describe("shared public version poller", () => {
  afterEach(() => vi.useRealTimers());

  it("polls once per slug per interval regardless of subscriber count", async () => {
    vi.useFakeTimers();
    const lookup = vi.fn().mockResolvedValueOnce("4:7:3:1").mockResolvedValue("4:7:3:2");
    const hub = new PublicVersionHub(lookup, 2_000);
    const events: unknown[][] = [[], [], []];
    expect(await hub.current("national-open")).toBe("4:7:3:1");
    // Further openings within the interval reuse the observation.
    expect(await hub.current("national-open")).toBe("4:7:3:1");
    const unsubscribes = events.map((sink) => hub.subscribe("national-open", (event) => sink.push(event)));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(lookup).toHaveBeenCalledTimes(3);
    for (const sink of events) {
      expect(sink).toEqual([
        { type: "version", version: "4:7:3:2" },
        { type: "version", version: "4:7:3:2" },
      ]);
    }
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    unsubscribes[0]!();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fans one poll out to concurrent SSE streams through the route", async () => {
    vi.useFakeTimers();
    let handler: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    const app = {
      get: (path: string, _options: unknown, callback: typeof handler) => {
        if (path.endsWith("/versions")) handler = callback;
      },
    } as unknown as FastifyInstance;
    const version = vi
      .fn()
      .mockResolvedValueOnce("4:7:3:1")
      .mockResolvedValueOnce("4:7:3:1")
      .mockResolvedValue("4:7:3:2");
    await registerGateCC4PublicTruthRoutes(app, { list: vi.fn(), read: vi.fn(), version });
    const streams: Readable[] = [];
    for (let index = 0; index < 5; index += 1) {
      await handler!(
        { params: { slug: "national-open" } },
        { header: () => undefined, send: (stream: Readable) => streams.push(stream) },
      );
    }
    // Five openings, one lookup: the opening token comes from the shared observation.
    expect(version).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(version).toHaveBeenCalledTimes(3);
    for (const stream of streams) {
      let frames = "";
      for (let chunk = stream.read(); chunk !== null; chunk = stream.read()) frames += String(chunk);
      expect(frames).toBe(
        'event: version\ndata: "4:7:3:1"\n\nevent: heartbeat\ndata: {}\n\nevent: version\ndata: "4:7:3:2"\n\n',
      );
      stream.destroy();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
