import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const incomingHeaders = vi.hoisted(() => ({ current: null as Headers | null }));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (!incomingHeaders.current) throw new Error("headers() was called outside a request scope");
    return incomingHeaders.current;
  },
}));

import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIGNATURE_HEADER,
  apiFetch,
  clientIpHeadersFor,
  clientIpSource,
  resolveIncomingClientIp,
  signClientIp,
} from "./client-ip.server";

const secret = "matchday-client-ip-test-vector-secret-32b";
// Pinned identically in apps/api/tests/unit/client-ip.test.ts so the two sides cannot drift.
const vector = "v1.1760000000.SYzq7I5Ou0DLX5J8sqb3rhh7FuwweB0FQauV1C9qu1Q";

describe("client IP signing", () => {
  it("matches the API's pinned HMAC vector", () => {
    expect(signClientIp("203.0.113.7", secret, 1_760_000_000_000)).toBe(vector);
  });
});

describe("resolveIncomingClientIp", () => {
  it("auto-selects the topology from the deployment environment", () => {
    expect(clientIpSource({ VERCEL: "1" })).toBe("vercel");
    expect(clientIpSource({})).toBe("proxy");
    expect(clientIpSource({ VERCEL: "1", MATCHDAY_CLIENT_IP_SOURCE: "none" })).toBe("none");
  });

  it("behind Caddy, uses only the right-most hop and ignores browser-forged entries", () => {
    const forged = new Headers({ "x-forwarded-for": "1.1.1.1, 10.0.0.1, 203.0.113.7", "x-real-ip": "9.9.9.9" });
    expect(resolveIncomingClientIp(forged, {})).toBe("203.0.113.7");
    // A malformed right-most hop is not "repaired" by searching leftwards.
    expect(resolveIncomingClientIp(new Headers({ "x-forwarded-for": "1.1.1.1, nonsense" }), {})).toBeNull();
    expect(resolveIncomingClientIp(new Headers({ "x-forwarded-for": "::ffff:198.51.100.4" }), {})).toBe("198.51.100.4");
    expect(resolveIncomingClientIp(new Headers(), {})).toBeNull();
  });

  it("on Vercel, trusts the edge-overwritten x-real-ip then the first forwarded entry", () => {
    expect(
      resolveIncomingClientIp(new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1" }), {
        VERCEL: "1",
      }),
    ).toBe("203.0.113.9");
    expect(resolveIncomingClientIp(new Headers({ "x-forwarded-for": "2001:DB8::1, 10.0.0.1" }), { VERCEL: "1" })).toBe(
      "2001:db8::1",
    );
  });

  it("never forwards when disabled", () => {
    expect(
      resolveIncomingClientIp(new Headers({ "x-forwarded-for": "203.0.113.7" }), {
        MATCHDAY_CLIENT_IP_SOURCE: "none",
      }),
    ).toBeNull();
  });
});

describe("clientIpHeadersFor", () => {
  const incoming = new Headers({ "x-forwarded-for": "203.0.113.7" });

  it("signs the derived IP when a secret is configured", () => {
    expect(clientIpHeadersFor(incoming, { MATCHDAY_CLIENT_IP_SECRET: secret }, 1_760_000_000_000)).toEqual({
      [CLIENT_IP_HEADER]: "203.0.113.7",
      [CLIENT_IP_SIGNATURE_HEADER]: vector,
    });
  });

  it("sends nothing without a usable secret", () => {
    expect(clientIpHeadersFor(incoming, {})).toEqual({});
    expect(clientIpHeadersFor(incoming, { MATCHDAY_CLIENT_IP_SECRET: "too-short" })).toEqual({});
  });
});

describe("apiFetch", () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MATCHDAY_CLIENT_IP_SOURCE", "proxy");
  });

  afterEach(() => {
    incomingHeaders.current = null;
    fetchMock.mockClear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("passes the request through untouched outside a request scope", async () => {
    vi.stubEnv("MATCHDAY_CLIENT_IP_SECRET", secret);
    const init = { headers: { accept: "application/json" } };
    await apiFetch("https://api.matchday.test/api/v1/status", init);
    expect(fetchMock).toHaveBeenCalledWith("https://api.matchday.test/api/v1/status", init);
  });

  it("adds the signed end-user IP of the request being served", async () => {
    vi.stubEnv("MATCHDAY_CLIENT_IP_SECRET", secret);
    incomingHeaders.current = new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
    await apiFetch("https://api.matchday.test/api/v1/scoring/access/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = new Headers(init.headers);
    expect(init.method).toBe("POST");
    expect(sent.get("content-type")).toBe("application/json");
    expect(sent.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
    expect(sent.get(CLIENT_IP_SIGNATURE_HEADER)).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/u);
  });

  it("never forwards caller-supplied client IP headers", async () => {
    await apiFetch("https://api.matchday.test/api/v1/status", {
      headers: { [CLIENT_IP_HEADER]: "6.6.6.6", [CLIENT_IP_SIGNATURE_HEADER]: "v1.1.forged" },
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = new Headers(init.headers);
    expect(sent.has(CLIENT_IP_HEADER)).toBe(false);
    expect(sent.has(CLIENT_IP_SIGNATURE_HEADER)).toBe(false);
  });
});
