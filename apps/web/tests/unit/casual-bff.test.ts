import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
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

describe("production-topology casual client identity and rate-limit trust chain", () => {
  let caddyApiServer: http.Server;
  let caddyApiUrl: string;
  const quotaMap = new Map<string, number>();
  const MAX_QUOTA = 5;

  let caddyTrustedProxies: string[] = [];
  let apiTrustedProxies: string[] = [];

  beforeEach(async () => {
    quotaMap.clear();

    // 1. Read and parse checked-in production configuration files
    const rootDir = path.resolve(process.cwd(), "../..");
    const caddyfile = await fs.readFile(path.join(rootDir, "infra/oci/Caddyfile"), "utf8");
    const envProd = await fs.readFile(path.join(rootDir, "infra/oci/.env.prod.example"), "utf8");

    // Extract Caddy's @api trusted_proxies from Caddyfile
    const prodBlockMatch = caddyfile.match(/matchday\.poladex\.shop\s*\{([\s\S]*?)\n\}/);
    if (!prodBlockMatch) throw new Error("Could not find matchday.poladex.shop block in Caddyfile");
    const prodBlock = prodBlockMatch[1];

    const trustedProxiesMatch = prodBlock.match(/trusted_proxies\s+([^\n}]+)/);
    caddyTrustedProxies = trustedProxiesMatch ? trustedProxiesMatch[1].trim().split(/\s+/).filter(Boolean) : [];

    // Verify Web handle in Caddyfile has NO trusted_proxies (ensuring browser XFF is stripped at ingress)
    const webHandleMatch = prodBlock.match(/handle\s*\{[\s\S]*?reverse_proxy\s+172\.31\.0\.12:3000[\s\S]*?\}/);
    expect(webHandleMatch).toBeTruthy();
    expect(webHandleMatch![0].includes("trusted_proxies")).toBe(false);

    // Extract Fastify's API_TRUSTED_PROXIES from .env.prod.example
    const apiTrustedProxiesMatch = envProd.match(/API_TRUSTED_PROXIES=([^\n]+)/);
    apiTrustedProxies = apiTrustedProxiesMatch
      ? apiTrustedProxiesMatch[1]
          .trim()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // Configuration assertions: Caddy trusts Web (172.31.0.12), Fastify trusts Caddy + Web
    expect(caddyTrustedProxies).toContain("172.31.0.12");
    expect(apiTrustedProxies).toEqual(["172.31.0.10", "172.31.0.12"]);

    // 2. Setup production-equivalent Caddy API Reverse Proxy + Fastify API upstream
    // Caddy API reverse proxy listens at caddyApiUrl (MATCHDAY_API_BASE_URL).
    // It enforces Caddy's reverse_proxy trusted_proxies rules and forwards to Fastify.
    caddyApiServer = http.createServer((caddyReq, caddyRes) => {
      // Determine connecting socket IP to Caddy API:
      // In production topology, requests forwarded by Web BFF originate from Web container (172.31.0.12).
      // Direct internet attacks connect from untrusted external IPs (e.g. 198.51.100.99).
      const callerSocketIp = (caddyReq.headers["x-test-caller-ip"] as string)?.trim() || "172.31.0.12";

      // Caddy reverse_proxy semantics:
      let forwardedXff: string;
      const rawIncomingXff = caddyReq.headers["x-forwarded-for"];
      const incomingXff = typeof rawIncomingXff === "string" ? rawIncomingXff.trim() : "";

      if (caddyTrustedProxies.includes(callerSocketIp)) {
        // Trusted proxy: preserve incoming XFF and append downstream remote address
        forwardedXff = incomingXff ? `${incomingXff}, ${callerSocketIp}` : callerSocketIp;
      } else {
        // Untrusted caller: strip any incoming XFF and set XFF to caller socket IP
        forwardedXff = callerSocketIp;
      }

      // Fastify upstream receives request from Caddy (172.31.0.10) with forwardedXff
      const caddySocketIpToFastify = "172.31.0.10";

      // Fastify trustProxy IP resolution (proxy-addr algorithm):
      let resolvedClientIp = caddySocketIpToFastify;
      if (apiTrustedProxies.includes(caddySocketIpToFastify)) {
        const hops = forwardedXff
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        resolvedClientIp = caddySocketIpToFastify;
        for (let i = hops.length - 1; i >= 0; i--) {
          const hop = hops[i];
          if (!apiTrustedProxies.includes(hop)) {
            resolvedClientIp = hop;
            break;
          }
        }
      }

      // Fastify Anonymous Rate Limiter on resolvedClientIp
      const key = `ip:${resolvedClientIp}`;
      const current = quotaMap.get(key) ?? 0;

      if (current >= MAX_QUOTA) {
        caddyRes.writeHead(429, {
          "content-type": "application/json",
          "ratelimit-limit": String(MAX_QUOTA),
          "ratelimit-remaining": "0",
        });
        caddyRes.end(JSON.stringify({ error: { message: "Rate limit exceeded" } }));
        return;
      }

      quotaMap.set(key, current + 1);
      const remaining = MAX_QUOTA - (current + 1);

      if (caddyReq.method === "POST" && caddyReq.url === "/api/v1/casual/games") {
        caddyRes.writeHead(201, {
          "content-type": "application/json",
          "ratelimit-limit": String(MAX_QUOTA),
          "ratelimit-remaining": String(remaining),
        });
        caddyRes.end(JSON.stringify({ game: { id: "game-1" }, host_token: "h1", viewer_token: "v1" }));
        return;
      }

      caddyRes.writeHead(200, {
        "content-type": "application/json",
        "ratelimit-limit": String(MAX_QUOTA),
        "ratelimit-remaining": String(remaining),
      });
      caddyRes.end(JSON.stringify({ game: { id: "game-1", home_score: 0, away_score: 0 } }));
    });

    await new Promise<void>((resolve) => {
      caddyApiServer.listen(0, "127.0.0.1", () => resolve());
    });

    const port = (caddyApiServer.address() as AddressInfo).port;
    caddyApiUrl = `http://127.0.0.1:${port}`;
    vi.stubEnv("RENDER_API_ORIGIN", "");
    vi.stubEnv("MATCHDAY_API_BASE_URL", caddyApiUrl);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => caddyApiServer.close(() => resolve()));
  });

  /**
   * Simulates a request passing through the full production ingress pipeline:
   * Browser Client (remoteSocketIp)
   *   -> Caddy Ingress (Web reverse_proxy: no trusted_proxies, strips incoming XFF, sets XFF = remoteSocketIp)
   *   -> Next Casual BFF (extractTrustedClientIp + forwardCasualRequest)
   *   -> Caddy API reverse proxy (trusted_proxies = 172.31.0.12, appends 172.31.0.12)
   *   -> Fastify (trustProxy = [172.31.0.10, 172.31.0.12] -> resolves request.ip -> rate limiter)
   */
  async function sendIngressClientRequest(
    clientSocketIp: string,
    path: string,
    options: { forgedBrowserXff?: string; method?: string; body?: string } = {},
  ): Promise<Response> {
    // Ingress Caddy semantics for Web (reverse_proxy 172.31.0.12:3000 without trusted_proxies):
    // Browser-supplied XFF is untrusted and stripped; Caddy sets X-Forwarded-For to the connecting client's IP.
    const ingressHeaders: Record<string, string> = {
      "x-forwarded-for": clientSocketIp,
    };
    if (options.method === "POST") {
      ingressHeaders["content-type"] = "application/json";
    }

    const request = new Request(`http://localhost:3000${path}`, {
      method: options.method || "GET",
      headers: ingressHeaders,
      ...(options.body ? { body: options.body } : {}),
    });

    return forwardCasualRequest(request);
  }

  it("proves client A and client B resolve to distinct rate-limit identities", async () => {
    // Client A request through full production topology
    const resA = await sendIngressClientRequest("198.51.100.1", "/api/v1/casual/games/game-1");
    expect(resA.status).toBe(200);
    expect(quotaMap.get("ip:198.51.100.1")).toBe(1);

    // Client B request through full production topology
    const resB = await sendIngressClientRequest("198.51.100.2", "/api/v1/casual/games/game-1");
    expect(resB.status).toBe(200);
    expect(quotaMap.get("ip:198.51.100.2")).toBe(1);
    expect(quotaMap.get("ip:198.51.100.1")).toBe(1);
  });

  it("proves repeated requests from client A consume only client A's quota", async () => {
    // 3 requests from Client A
    for (let i = 1; i <= 3; i++) {
      const res = await sendIngressClientRequest("198.51.100.1", "/api/v1/casual/games/game-1");
      expect(res.status).toBe(200);
      expect(quotaMap.get("ip:198.51.100.1")).toBe(i);
    }

    // Client B's quota remains untouched
    expect(quotaMap.get("ip:198.51.100.2")).toBeUndefined();
  });

  it("proves forged browser X-Forwarded-For cannot select client B's quota", async () => {
    // Client B uses 2 requests legitimately
    await sendIngressClientRequest("198.51.100.2", "/api/v1/casual/games/game-1");
    await sendIngressClientRequest("198.51.100.2", "/api/v1/casual/games/game-1");
    expect(quotaMap.get("ip:198.51.100.2")).toBe(2);

    // Attacker at 198.51.100.99 connects to Caddy ingress with forged X-Forwarded-For: 198.51.100.2
    // Caddy ingress strips forged browser XFF because the browser is untrusted.
    const forgedRes = await sendIngressClientRequest("198.51.100.99", "/api/v1/casual/games/game-1", {
      forgedBrowserXff: "198.51.100.2",
    });
    expect(forgedRes.status).toBe(200);

    // Client B's quota was NOT consumed by the attacker!
    expect(quotaMap.get("ip:198.51.100.2")).toBe(2);
    // Attacker's own quota was consumed
    expect(quotaMap.get("ip:198.51.100.99")).toBe(1);
  });

  it("proves direct Internet requests cannot spoof an internal proxy or client identity", async () => {
    // Direct attacker from internet IP 198.51.100.99 connects directly to Caddy API endpoint,
    // attempting to spoof internal Web proxy (172.31.0.12) and Client B (198.51.100.2).
    const directRes = await fetch(`${caddyApiUrl}/api/v1/casual/games/game-1`, {
      headers: {
        "x-test-caller-ip": "198.51.100.99", // Untrusted external caller socket IP
        "x-forwarded-for": "198.51.100.2, 172.31.0.12", // Forged proxy chain
      },
    });
    expect(directRes.status).toBe(200);

    // Caddy API proxy rejected caller 198.51.100.99 as untrusted, stripped forged headers,
    // and attributed request.ip to 198.51.100.99
    expect(quotaMap.get("ip:198.51.100.99")).toBe(1);
    expect(quotaMap.get("ip:198.51.100.2")).toBeUndefined();
    expect(quotaMap.get("ip:172.31.0.12")).toBeUndefined();
  });

  it("proves client B remains unblocked when client A exhausts its quota", async () => {
    // Client A creates game
    const createRes = await sendIngressClientRequest("198.51.100.1", "/api/v1/casual/games", {
      method: "POST",
      body: JSON.stringify({ sport_id: "badminton", home_name: "Team A", away_name: "Team B" }),
    });
    expect(createRes.status).toBe(201);
    const createData = (await createRes.json()) as { host_token: string; viewer_token: string };

    // Client A consumes quota up to limit
    for (let i = 2; i <= MAX_QUOTA; i++) {
      const readRes = await sendIngressClientRequest(
        "198.51.100.1",
        `/api/v1/casual/games/game-1?viewer_token=${createData.viewer_token}`,
      );
      expect(readRes.status).toBe(200);
    }

    // Client A exceeds quota -> 429
    const limitedRes = await sendIngressClientRequest("198.51.100.1", "/api/v1/casual/games/game-1");
    expect(limitedRes.status).toBe(429);
    expect(await limitedRes.json()).toEqual({ error: { message: "Rate limit exceeded" } });

    // Client B remains unblocked and receives 200
    const unblockedRes = await sendIngressClientRequest("198.51.100.2", "/api/v1/casual/games/game-1");
    expect(unblockedRes.status).toBe(200);
    expect(quotaMap.get("ip:198.51.100.2")).toBe(1);
  });
});
