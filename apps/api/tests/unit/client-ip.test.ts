import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIGNATURE_HEADER,
  createClientIpResolver,
  rateLimitIpSubject,
  signClientIp,
  verifySignedClientIp,
} from "../../src/client-ip.js";
import { healthyProbes, testConfig } from "../helpers.js";

const secret = "matchday-client-ip-test-vector-secret-32b";
// Pinned identically in apps/web/lib/client-ip.server.test.ts so the two sides cannot drift.
const vector = "v1.1760000000.SYzq7I5Ou0DLX5J8sqb3rhh7FuwweB0FQauV1C9qu1Q";
const vectorNow = 1_760_000_000_000;

function signed(ip: string, now = Date.now(), key = secret) {
  return { [CLIENT_IP_HEADER]: ip, [CLIENT_IP_SIGNATURE_HEADER]: signClientIp(ip, key, now) };
}

describe("signed client IP verification", () => {
  it("accepts the pinned cross-service vector", () => {
    expect(signClientIp("203.0.113.7", secret, vectorNow)).toBe(vector);
    expect(
      verifySignedClientIp(
        { [CLIENT_IP_HEADER]: "203.0.113.7", [CLIENT_IP_SIGNATURE_HEADER]: vector },
        secret,
        vectorNow + 30_000,
      ),
    ).toEqual({ status: "valid", ip: "203.0.113.7" });
  });

  it("reports missing headers separately from invalid ones", () => {
    expect(verifySignedClientIp({}, secret)).toEqual({ status: "missing" });
    expect(verifySignedClientIp({ [CLIENT_IP_HEADER]: "203.0.113.7" }, secret)).toEqual({
      status: "invalid",
      reason: "malformed",
    });
    expect(verifySignedClientIp(signed("203.0.113.7"), undefined)).toEqual({
      status: "invalid",
      reason: "unconfigured",
    });
  });

  it("rejects expired and future-dated signatures", () => {
    const headers = signed("203.0.113.7", vectorNow);
    expect(verifySignedClientIp(headers, secret, vectorNow + 61_000)).toEqual({ status: "invalid", reason: "expired" });
    expect(verifySignedClientIp(headers, secret, vectorNow - 61_000)).toEqual({ status: "invalid", reason: "expired" });
  });

  it("rejects forged, re-targeted and ambiguous headers", () => {
    const now = Date.now();
    expect(
      verifySignedClientIp(signed("203.0.113.7", now, "another-secret-that-is-at-least-32-bytes"), secret, now),
    ).toEqual({ status: "invalid", reason: "signature" });
    // A valid signature cannot be replayed for a different IP.
    const replayed = { ...signed("203.0.113.7", now), [CLIENT_IP_HEADER]: "203.0.113.8" };
    expect(verifySignedClientIp(replayed, secret, now)).toEqual({ status: "invalid", reason: "signature" });
    expect(
      verifySignedClientIp({ ...signed("203.0.113.7", now), [CLIENT_IP_HEADER]: "not-an-ip" }, secret, now),
    ).toEqual({ status: "invalid", reason: "malformed" });
    expect(
      verifySignedClientIp(
        {
          [CLIENT_IP_HEADER]: ["203.0.113.7", "203.0.113.8"],
          [CLIENT_IP_SIGNATURE_HEADER]: signClientIp("203.0.113.7", secret, now),
        },
        secret,
        now,
      ),
    ).toEqual({ status: "invalid", reason: "malformed" });
  });

  it("falls back to the transport address and throttles warnings for invalid signatures", () => {
    const warnings: unknown[] = [];
    let now = vectorNow;
    const resolve = createClientIpResolver({
      secret,
      now: () => now,
      logger: { warn: (payload) => warnings.push(payload) },
    });
    const request = (headers: Record<string, string>) => ({ headers, ip: "172.31.0.12" }) as never;
    expect(resolve(request(signed("203.0.113.7", now)))).toBe("203.0.113.7");
    expect(resolve(request({ [CLIENT_IP_HEADER]: "6.6.6.6", [CLIENT_IP_SIGNATURE_HEADER]: "v1.1.x" }))).toBe(
      "172.31.0.12",
    );
    expect(resolve(request({ [CLIENT_IP_HEADER]: "6.6.6.7", [CLIENT_IP_SIGNATURE_HEADER]: "v1.1.x" }))).toBe(
      "172.31.0.12",
    );
    expect(resolve(request({}))).toBe("172.31.0.12");
    expect(warnings).toHaveLength(1);
    now += 31_000;
    resolve(request({ [CLIENT_IP_HEADER]: "6.6.6.8", [CLIENT_IP_SIGNATURE_HEADER]: "v1.1.x" }));
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatchObject({ rejected_since_last_warning: { malformed: 2 } });
  });
});

describe("rate-limit IP subjects", () => {
  it("keys IPv4 exactly and IPv6 by /64", () => {
    expect(rateLimitIpSubject("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitIpSubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitIpSubject("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitIpSubject("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(rateLimitIpSubject("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitIpSubject("64:ff9b::192.0.2.33")).toBe("64:ff9b:0:0::/64");
  });
});

describe("rate-limit key selection", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function app(overrides: NodeJS.ProcessEnv = { MATCHDAY_CLIENT_IP_SECRET: secret }) {
    const instance = await buildApp({ config: testConfig(overrides), probes: healthyProbes, anonymousRateLimitMax: 1 });
    apps.push(instance);
    return instance;
  }

  it("gives each verified end user behind the BFF an independent bucket", async () => {
    const api = await app();
    const call = (headers: Record<string, string>) =>
      api.inject({ method: "GET", url: "/api/v1/status", headers }).then((response) => response.statusCode);
    expect(await call(signed("203.0.113.7"))).toBe(200);
    expect(await call(signed("203.0.113.7"))).toBe(429);
    expect(await call(signed("203.0.113.8"))).toBe(200);
    expect(await call(signed("2001:db8:1:2::10"))).toBe(200);
    // Same IPv6 /64: same subscriber, same bucket.
    expect(await call(signed("2001:db8:1:2::99"))).toBe(429);
  });

  it("ignores browser-forged X-Forwarded-For and unsigned client IP headers", async () => {
    const api = await app();
    const call = (headers: Record<string, string>) =>
      api.inject({ method: "GET", url: "/api/v1/status", headers }).then((response) => response.statusCode);
    expect(await call({ "x-forwarded-for": "198.51.100.1" })).toBe(200);
    // Different forged values still land in the transport peer's bucket.
    expect(await call({ "x-forwarded-for": "198.51.100.2" })).toBe(429);
    expect(await call({ [CLIENT_IP_HEADER]: "198.51.100.3" })).toBe(429);
    expect(
      await call({
        [CLIENT_IP_HEADER]: "198.51.100.4",
        [CLIENT_IP_SIGNATURE_HEADER]: signClientIp("198.51.100.4", "forged-secret-that-is-at-least-32-bytes"),
      }),
    ).toBe(429);
  });

  it("does not honour signed headers when the API has no secret configured", async () => {
    const api = await app({});
    const call = (headers: Record<string, string>) =>
      api.inject({ method: "GET", url: "/api/v1/status", headers }).then((response) => response.statusCode);
    expect(await call(signed("203.0.113.7"))).toBe(200);
    expect(await call(signed("203.0.113.8"))).toBe(429);
  });
});
