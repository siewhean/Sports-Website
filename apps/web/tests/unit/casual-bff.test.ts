import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractTrustedClientIp, forwardCasualRequest } from "@/lib/casual-bff.server";

const fetchMock = vi.fn();

describe("casual API forwarding (mocked fetch)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("RENDER_API_ORIGIN", "");
    vi.stubEnv("MATCHDAY_API_BASE_URL", "http://127.0.0.1:4000");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchMock.mockReset();
  });

  it("starts a guest game using the configured local API without a Render rewrite", async () => {
    const body = JSON.stringify({ sport_id: "badminton", home_name: "A", away_name: "B" });
    fetchMock.mockResolvedValue(
      Response.json({ game: { id: "game-1" }, host_token: "host", viewer_token: "viewer" }, { status: 201 }),
    );
    const response = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ host_token: "host", viewer_token: "viewer" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:4000/api/v1/casual/games"),
      expect.objectContaining({ method: "POST", body }),
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("preserves viewing credentials and host credentials for scoring", async () => {
    fetchMock.mockResolvedValue(Response.json({ home_score: 1 }));
    await forwardCasualRequest(new Request("http://localhost:3000/api/v1/casual/games/game-1?viewer_token=view"));
    expect(fetchMock.mock.calls[0]?.[0].href).toBe(
      "http://127.0.0.1:4000/api/v1/casual/games/game-1?viewer_token=view",
    );
    await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games/game-1/actions", {
        method: "POST",
        headers: { "x-casual-host-token": "secret-host", "content-type": "application/json" },
        body: '{"side":"home"}',
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1].headers.get("x-casual-host-token")).toBe("secret-host");
  });

  it("reports unavailable backend configuration and missing create routes clearly", async () => {
    fetchMock.mockResolvedValue(Response.json({ message: "Route not found" }, { status: 404 }));
    const response = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: expect.stringContaining("temporarily unavailable") });
    vi.stubEnv("MATCHDAY_API_BASE_URL", "");
    expect((await forwardCasualRequest(new Request("http://localhost:3000/api/v1/casual/games"))).status).toBe(503);
  });

  it("preserves missing-game errors rather than turning them into service errors", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { message: "Casual game not found" } }, { status: 404 }));
    expect((await forwardCasualRequest(new Request("http://localhost:3000/api/v1/casual/games/unknown"))).status).toBe(
      404,
    );
  });
});

describe("trusted client IP extraction", () => {
  it("extracts the client IP from a single X-Forwarded-For header", () => {
    const request = new Request("http://localhost:3000/api/v1/casual/games", {
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    expect(extractTrustedClientIp(request)).toBe("198.51.100.1");
  });

  it("extracts the rightmost valid IP when multiple proxies or forged headers exist", () => {
    // Attacker forged 10.0.0.1, Caddy appended real client 198.51.100.2
    const request = new Request("http://localhost:3000/api/v1/casual/games", {
      headers: { "x-forwarded-for": "10.0.0.1, 198.51.100.2" },
    });
    expect(extractTrustedClientIp(request)).toBe("198.51.100.2");
  });

  it("ignores non-IP junk in X-Forwarded-For and picks the rightmost valid IP", () => {
    const request = new Request("http://localhost:3000/api/v1/casual/games", {
      headers: { "x-forwarded-for": "forged_client, 198.51.100.42, not_an_ip" },
    });
    expect(extractTrustedClientIp(request)).toBe("198.51.100.42");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is missing", () => {
    const request = new Request("http://localhost:3000/api/v1/casual/games", {
      headers: { "x-real-ip": "203.0.113.10" },
    });
    expect(extractTrustedClientIp(request)).toBe("203.0.113.10");
  });

  it("falls back to 127.0.0.1 when no forwarding headers exist", () => {
    const request = new Request("http://localhost:3000/api/v1/casual/games");
    expect(extractTrustedClientIp(request)).toBe("127.0.0.1");
  });
});

describe("real web→API proxy rate-limit identity path", () => {
  let server: http.Server;
  let serverUrl: string;
  const quotaMap = new Map<string, number>();
  const MAX_QUOTA = 5;

  beforeEach(async () => {
    quotaMap.clear();

    server = http.createServer((req, res) => {
      // In Fastify/API with trustProxy, the client IP is read from the forwarded header.
      const rawHeader = req.headers["x-forwarded-for"];
      const clientIp = typeof rawHeader === "string" ? rawHeader.split(",").pop()?.trim() : req.socket.remoteAddress;
      const key = `ip:${clientIp}`;
      const current = quotaMap.get(key) ?? 0;

      if (current >= MAX_QUOTA) {
        res.writeHead(429, {
          "content-type": "application/json",
          "ratelimit-limit": String(MAX_QUOTA),
          "ratelimit-remaining": "0",
        });
        res.end(JSON.stringify({ error: { message: "Rate limit exceeded" } }));
        return;
      }

      quotaMap.set(key, current + 1);
      const remaining = MAX_QUOTA - (current + 1);

      if (req.method === "POST" && req.url === "/api/v1/casual/games") {
        res.writeHead(201, {
          "content-type": "application/json",
          "ratelimit-limit": String(MAX_QUOTA),
          "ratelimit-remaining": String(remaining),
        });
        res.end(JSON.stringify({ game: { id: "game-1" }, host_token: "h1", viewer_token: "v1" }));
        return;
      }

      res.writeHead(200, {
        "content-type": "application/json",
        "ratelimit-limit": String(MAX_QUOTA),
        "ratelimit-remaining": String(remaining),
      });
      res.end(JSON.stringify({ game: { id: "game-1", home_score: 0, away_score: 0 } }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://127.0.0.1:${port}`;
    vi.stubEnv("RENDER_API_ORIGIN", "");
    vi.stubEnv("MATCHDAY_API_BASE_URL", serverUrl);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("proves client A and client B do not share the same anonymous casual quota", async () => {
    // Client A request through real web BFF proxy
    const resA = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games/game-1", {
        headers: { "x-forwarded-for": "198.51.100.1" },
      }),
    );
    expect(resA.status).toBe(200);
    // Quota for A used 1, remaining = 4
    expect(quotaMap.get("ip:198.51.100.1")).toBe(1);

    // Client B request through real web BFF proxy
    const resB = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games/game-1", {
        headers: { "x-forwarded-for": "198.51.100.2" },
      }),
    );
    expect(resB.status).toBe(200);
    // Quota for B used 1, remaining = 4 (separate quota!)
    expect(quotaMap.get("ip:198.51.100.2")).toBe(1);
    expect(quotaMap.get("ip:198.51.100.1")).toBe(1);
  });

  it("proves repeated requests from client A remain in client A's quota", async () => {
    // 3 requests from Client A
    for (let i = 1; i <= 3; i++) {
      const res = await forwardCasualRequest(
        new Request("http://localhost:3000/api/v1/casual/games/game-1", {
          headers: { "x-forwarded-for": "198.51.100.1" },
        }),
      );
      expect(res.status).toBe(200);
      expect(quotaMap.get("ip:198.51.100.1")).toBe(i);
    }

    // Client B quota remains 0
    expect(quotaMap.get("ip:198.51.100.2")).toBeUndefined();
  });

  it("proves forged browser forwarding headers cannot select another client's rate-limit identity", async () => {
    // Client A has used 2 requests
    await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games/game-1", {
        headers: { "x-forwarded-for": "198.51.100.1" },
      }),
    );
    await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games/game-1", {
        headers: { "x-forwarded-for": "198.51.100.1" },
      }),
    );
    expect(quotaMap.get("ip:198.51.100.1")).toBe(2);

    // Attacker at 198.51.100.99 attempts to forge Client A's IP (198.51.100.1)
    // In Caddy -> web topology, Caddy appends the attacker's IP: "198.51.100.1, 198.51.100.99"
    const forgedRes = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games/game-1", {
        headers: { "x-forwarded-for": "198.51.100.1, 198.51.100.99" },
      }),
    );
    expect(forgedRes.status).toBe(200);

    // Client A's quota was NOT consumed by the forged request!
    expect(quotaMap.get("ip:198.51.100.1")).toBe(2);
    // Attacker's own quota was consumed instead
    expect(quotaMap.get("ip:198.51.100.99")).toBe(1);
  });

  it("proves normal casual BFF create/read flows remain functional and enforce 429 upon exhaustion", async () => {
    // Normal create flow
    const createRes = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.5",
        },
        body: JSON.stringify({ sport_id: "badminton", home_name: "Team A", away_name: "Team B" }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createData = (await createRes.json()) as { host_token: string; viewer_token: string };
    expect(createData.host_token).toBe("h1");
    expect(createData.viewer_token).toBe("v1");

    // Normal read flows up to limit
    for (let i = 2; i <= MAX_QUOTA; i++) {
      const readRes = await forwardCasualRequest(
        new Request(`http://localhost:3000/api/v1/casual/games/game-1?viewer_token=${createData.viewer_token}`, {
          headers: { "x-forwarded-for": "198.51.100.5" },
        }),
      );
      expect(readRes.status).toBe(200);
    }

    // Exceed quota -> 429
    const limitedRes = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games/game-1", {
        headers: { "x-forwarded-for": "198.51.100.5" },
      }),
    );
    expect(limitedRes.status).toBe(429);

    // Different client at 198.51.100.6 is NOT affected by 198.51.100.5's exhaustion
    const unblockedRes = await forwardCasualRequest(
      new Request("http://localhost:3000/api/v1/casual/games/game-1", {
        headers: { "x-forwarded-for": "198.51.100.6" },
      }),
    );
    expect(unblockedRes.status).toBe(200);
  });
});
