import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/v1/public/competitions/[slug]/versions/route";

const path = "/api/v1/public/competitions/safe-public/versions";
const request = (headers?: HeadersInit) => new Request(`http://localhost:3103${path}`, { headers });
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
  }
});

async function fixture(handler: RequestListener) {
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  vi.stubEnv("RENDER_API_ORIGIN", "");
  vi.stubEnv("MATCHDAY_API_BASE_URL", `http://127.0.0.1:${address.port}`);
}

describe("same-origin public version stream", () => {
  it("forwards genuine incremental loopback SSE without buffering, credentials or private headers", async () => {
    let nextFrame!: () => void;
    let upstreamClosed!: Promise<unknown[]>;
    await fixture((incoming, reply) => {
      expect(incoming.url).toBe(path);
      expect(incoming.headers.accept).toBe("text/event-stream");
      expect(incoming.headers.cookie).toBeUndefined();
      expect(incoming.headers.authorization).toBeUndefined();
      expect(incoming.headers["x-casual-host-token"]).toBeUndefined();
      reply.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "private=secret", etag: "private" });
      reply.write('event: version\ndata: "4:7:3"\n\n');
      upstreamClosed = once(reply, "close");
      nextFrame = () => reply.end("event: heartbeat\ndata: {}\n\n");
    });
    const response = await GET(
      request({ cookie: "session=secret", authorization: "Bearer secret", "x-casual-host-token": "private" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('event: version\ndata: "4:7:3"\n\n');
    // Headers and initial version arrive before the backend finishes its lease.
    nextFrame();
    const heartbeat = await reader.read();
    expect(new TextDecoder().decode(heartbeat.value)).toBe("event: heartbeat\ndata: {}\n\n");
    expect((await reader.read()).done).toBe(true);
    await upstreamClosed;
  });

  it("propagates downstream abort to the upstream connection", async () => {
    let closed!: Promise<unknown[]>;
    await fixture((_incoming, reply) => {
      reply.writeHead(200, { "content-type": "text/event-stream" });
      reply.write('event: version\ndata: "1:1:1"\n\n');
      closed = once(reply, "close");
    });
    const controller = new AbortController();
    const response = await GET(new Request(`http://localhost:3103${path}`, { signal: controller.signal }));
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await closed;
  });

  it.each([
    [404, "application/json", 404],
    [302, "text/event-stream", 502],
    [200, "text/html", 502],
    [500, "application/json", 502],
  ])(
    "preserves genuine missing routes and rejects invalid upstream responses (%s)",
    async (status, contentType, expected) => {
      await fixture((_incoming, reply) => {
        reply.writeHead(status, { "content-type": contentType, location: "https://other.test/" });
        reply.end("private backend diagnostic");
      });
      const response = await GET(request());
      expect(response.status).toBe(expected);
      expect(await response.text()).not.toContain("private backend diagnostic");
      expect(response.headers.get("location")).toBeNull();
    },
  );

  it.each([
    "",
    "http://localhost:3103",
    "http://backend.example",
    "https://user:secret@api.test",
    "https://api.test/path",
  ])("fails closed for absent, recursive or unsafe backend configuration: %s", async (origin) => {
    vi.stubEnv("RENDER_API_ORIGIN", "");
    vi.stubEnv("MATCHDAY_API_BASE_URL", origin);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await GET(request())).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("limits forwarding to GET on the exact public versions route", async () => {
    expect((await GET(new Request("http://localhost:3103/api/v1/competitions/private/versions"))).status).toBe(404);
    expect((await GET(new Request(`http://localhost:3103${path}`, { method: "POST" }))).status).toBe(405);
  });
});
