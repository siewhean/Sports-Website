import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGateCC4PublicTruthRoutes } from "../../src/gate-c-c4-public-truth.js";

type Handler = (request: { params: { slug: string } }, reply: unknown) => Promise<unknown>;

async function openStream(version = vi.fn().mockResolvedValue("4:7:3:1")) {
  let handler: Handler | undefined;
  const app = {
    get: (path: string, _options: unknown, callback: Handler) => {
      if (path.endsWith("/versions")) handler = callback;
    },
  } as unknown as FastifyInstance;
  const headers: Record<string, string> = {};
  let stream: Readable | undefined;
  const read = vi.fn().mockResolvedValue({
    freshness: { schedule_version: 4, result_version: 7, projection_version: 3 },
    payload: { private_official_name: "Must never leave the public projection" },
  });
  await registerGateCC4PublicTruthRoutes(app, { list: vi.fn(), read, version });
  await handler!(
    { params: { slug: "national-open" } },
    {
      header: (name: string, value: string) => {
        headers[name] = value;
      },
      send: (value: Readable) => {
        stream = value;
      },
    },
  );
  return { stream: stream!, headers, read, version };
}

function frame(stream: Readable) {
  return stream.read()?.toString() as string | undefined;
}

afterEach(() => vi.useRealTimers());

describe("public version SSE protocol", () => {
  it("sends valid version and heartbeat frames with no private projection or cacheable stream", async () => {
    vi.useFakeTimers();
    const { stream, headers, read, version } = await openStream();
    expect(headers).toEqual({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    expect(frame(stream)).toBe('event: version\ndata: "4:7:3:1"\n\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe("event: heartbeat\ndata: {}\n\n");
    // The opening token and every poll use the single-row version lookup, never a full projection read.
    expect(read).not.toHaveBeenCalled();
    expect(version).toHaveBeenCalledTimes(2);
    expect(version).toHaveBeenCalledWith("national-open");
    stream.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serves browser-parseable public frames through the actual Fastify route", async () => {
    vi.useFakeTimers();
    const app = Fastify();
    const runtime = {
      list: vi.fn(),
      read: vi.fn().mockResolvedValue({
        freshness: { schedule_version: 4, result_version: 7, projection_version: 3 },
        payload: { private_official_name: "Private official" },
      }),
      version: vi.fn().mockResolvedValueOnce("4:7:3:1").mockResolvedValueOnce("4:7:3:1").mockResolvedValueOnce(null),
    };
    await registerGateCC4PublicTruthRoutes(app, runtime);
    await app.ready();
    try {
      const response = app.inject({ method: "GET", url: "/api/v1/public/competitions/national-open/versions" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await response;
      expect(result.statusCode).toBe(200);
      expect(result.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.payload.split("\n\n")).toEqual([
        'event: version\ndata: "4:7:3:1"',
        "event: heartbeat\ndata: {}",
        "event: unavailable\ndata: {}",
        "",
      ]);
      expect(result.payload).not.toContain("Private official");
    } finally {
      await app.close();
    }
  });

  it("emits a new version when publication truth changes, then ends when unavailable", async () => {
    vi.useFakeTimers();
    const version = vi
      .fn()
      .mockResolvedValueOnce("4:7:3:1")
      .mockResolvedValueOnce("4:8:4:1")
      .mockResolvedValueOnce(null);
    const { stream } = await openStream(version);
    frame(stream);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe('event: version\ndata: "4:8:4:1"\n\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe("event: unavailable\ndata: {}\n\n");
    expect(vi.getTimerCount()).toBe(0);
    stream.destroy();
  });

  it("emits live score updates that keep the same schedule and result versions", async () => {
    vi.useFakeTimers();
    // A scored point rewrites the current projection row in place: only the live revision moves.
    const version = vi
      .fn()
      .mockResolvedValueOnce("4:7:3:1")
      .mockResolvedValueOnce("4:7:3:2")
      .mockResolvedValueOnce("4:7:3:2")
      .mockResolvedValueOnce("4:7:3:3");
    const { stream } = await openStream(version);
    expect(frame(stream)).toBe('event: version\ndata: "4:7:3:1"\n\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe('event: version\ndata: "4:7:3:2"\n\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe("event: heartbeat\ndata: {}\n\n");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe('event: version\ndata: "4:7:3:3"\n\n');
    stream.destroy();
  });

  it("returns 404 without opening a stream when the competition has no public version", async () => {
    const app = Fastify();
    await registerGateCC4PublicTruthRoutes(app, {
      list: vi.fn(),
      read: vi.fn(),
      version: vi.fn().mockResolvedValue(null),
    });
    await app.ready();
    try {
      const result = await app.inject({ method: "GET", url: "/api/v1/public/competitions/missing/versions" });
      expect(result.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("falls back to the read token, including its live revision, when no version lookup exists", async () => {
    vi.useFakeTimers();
    let handler: Handler | undefined;
    const app = {
      get: (path: string, _options: unknown, callback: Handler) => {
        if (path.endsWith("/versions")) handler = callback;
      },
    } as unknown as FastifyInstance;
    let stream: Readable | undefined;
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        freshness: { schedule_version: 4, result_version: 7, projection_version: 3 },
        payload: {},
        version: "4:7:3:5",
      })
      .mockResolvedValueOnce({
        freshness: { schedule_version: 4, result_version: 7, projection_version: 3 },
        payload: {},
        version: "4:7:3:6",
      });
    await registerGateCC4PublicTruthRoutes(app, { list: vi.fn(), read });
    await handler!(
      { params: { slug: "national-open" } },
      { header: () => undefined, send: (value: Readable) => (stream = value) },
    );
    expect(frame(stream!)).toBe('event: version\ndata: "4:7:3:5"\n\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream!)).toBe('event: version\ndata: "4:7:3:6"\n\n');
    stream!.destroy();
  });

  it("ends failed lookups with a reconnect event and cancels timers", async () => {
    vi.useFakeTimers();
    const { stream } = await openStream(
      vi.fn().mockResolvedValueOnce("4:7:3:1").mockRejectedValue(new Error("database unavailable")),
    );
    frame(stream);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe("event: reconnect\ndata: {}\n\n");
    expect(vi.getTimerCount()).toBe(0);
    stream.destroy();
  });

  it.each(["lifetime", "disconnect"])("does not push a late version after %s ends the stream", async (end) => {
    vi.useFakeTimers();
    let resolve!: (version: string) => void;
    const version = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("4:7:3:1")
      .mockImplementation(
        () =>
          new Promise<string>((done) => {
            resolve = done;
          }),
      );
    const { stream } = await openStream(version);
    frame(stream);
    const error = vi.fn();
    stream.on("error", error);
    await vi.advanceTimersByTimeAsync(2_000);
    if (end === "lifetime") await vi.advanceTimersByTimeAsync(26_000);
    else stream.destroy();
    resolve("5:8:4:1");
    await vi.advanceTimersByTimeAsync(0);
    expect(frame(stream)).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    expect(version).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    stream.destroy();
  });
});
