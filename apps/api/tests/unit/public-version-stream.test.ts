import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGateCC4PublicTruthRoutes } from "../../src/gate-c-c4-public-truth.js";

type Handler = (request: { params: { slug: string } }, reply: unknown) => Promise<unknown>;

async function openStream(version = vi.fn().mockResolvedValue("4:7:3")) {
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
    expect(frame(stream)).toBe('event: version\ndata: "4:7:3"\n\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe("event: heartbeat\ndata: {}\n\n");
    expect(read).toHaveBeenCalledTimes(1);
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
      version: vi.fn().mockResolvedValueOnce("4:7:3").mockResolvedValueOnce(null),
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
        'event: version\ndata: "4:7:3"',
        "event: heartbeat\ndata: {}",
        "event: unavailable\ndata: {}",
        "",
      ]);
      expect(result.payload).not.toContain("Private official");
    } finally {
      await app.close();
    }
  });

  it("only emits new versions when publication truth changes, then ends when unavailable", async () => {
    vi.useFakeTimers();
    const version = vi.fn().mockResolvedValueOnce("4:8:4").mockResolvedValueOnce(null);
    const { stream } = await openStream(version);
    frame(stream);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe('event: version\ndata: "4:8:4"\n\n');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe("event: unavailable\ndata: {}\n\n");
    expect(vi.getTimerCount()).toBe(0);
    stream.destroy();
  });

  it("ends failed lookups with a reconnect event and cancels timers", async () => {
    vi.useFakeTimers();
    const { stream } = await openStream(vi.fn().mockRejectedValue(new Error("database unavailable")));
    frame(stream);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(stream)).toBe("event: reconnect\ndata: {}\n\n");
    expect(vi.getTimerCount()).toBe(0);
    stream.destroy();
  });

  it.each(["lifetime", "disconnect"])("does not push a late version after %s ends the stream", async (end) => {
    vi.useFakeTimers();
    let resolve!: (version: string) => void;
    const version = vi.fn(
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
    resolve("5:8:4");
    await vi.advanceTimersByTimeAsync(0);
    expect(frame(stream)).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    expect(version).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    stream.destroy();
  });
});
