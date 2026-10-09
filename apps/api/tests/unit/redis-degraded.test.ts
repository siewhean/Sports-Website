import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { CLIENT_IP_HEADER, CLIENT_IP_SIGNATURE_HEADER, signClientIp } from "../../src/client-ip.js";
import type { GateCC4PublicTruthRuntime } from "../../src/gate-c-c4-public-truth.js";
import { RedisScoringAccessRateLimiter } from "../../src/scoring-access-rate-limit.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

/** An ioredis stand-in whose every command fails, like a Redis outage with the offline queue disabled. */
function unavailableRedis(): Redis {
  const fail = (...args: unknown[]) => {
    const callback = args.at(-1);
    const error = new Error("Stream isn't writeable and enableOfflineQueue options is false");
    if (typeof callback === "function") return (callback as (error: Error) => void)(error);
    return Promise.reject(error);
  };
  return {
    status: "end",
    defineCommand: () => undefined,
    rateLimit: fail,
    rateLimitRead: fail,
    multi: () => ({
      ttl: function () {
        return this;
      },
      get: function () {
        return this;
      },
      exec: fail,
    }),
    eval: fail,
    del: fail,
    quit: async () => "OK",
  } as unknown as Redis;
}

function logCapture() {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    destination: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  };
}

describe("readiness with a Redis outage", () => {
  it("stays ready-but-degraded when only Redis and the queue are down", async () => {
    const app = await buildApp({
      config: testConfig(),
      probes: { database: async () => true, redis: async () => false, queue: async () => false },
    });
    apps.push(app);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "degraded",
      dependencies: { database: true, redis: false, queue: false },
    });
  });

  it("is not ready without the database", async () => {
    const app = await buildApp({
      config: testConfig(),
      probes: { database: async () => false, redis: async () => true, queue: async () => true },
    });
    apps.push(app);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().status).toBe("unhealthy");
  });

  it("closes long-lived probe connections with the app", async () => {
    let closed = false;
    const app = await buildApp({
      config: testConfig(),
      probes: { ...healthyProbes, close: async () => void (closed = true) },
    });
    await app.close();
    expect(closed).toBe(true);
  });
});

describe("global rate limiter with a Redis outage", () => {
  it("keeps serving and enforces per-instance in-memory limits, with a logged warning", async () => {
    const logs = logCapture();
    const app = await buildApp({
      config: testConfig({ LOG_LEVEL: "warn" }),
      probes: healthyProbes,
      rateLimitRedis: unavailableRedis(),
      anonymousRateLimitMax: 2,
      loggerDestination: logs.destination,
    });
    apps.push(app);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const warnings = logs.lines.filter((line) => line.event === "rate_limit_redis_unavailable");
    // Throttled: one warning for the burst, not one per request.
    expect(warnings).toHaveLength(1);
  });
});

describe("public read limits", () => {
  const secret = "matchday-client-ip-test-vector-secret-32b";
  const signed = (ip: string) => ({ [CLIENT_IP_HEADER]: ip, [CLIENT_IP_SIGNATURE_HEADER]: signClientIp(ip, secret) });
  const runtime = {
    list: async () => [],
    read: async () => ({ freshness: { schedule_version: 1, result_version: 1, projection_version: 1 } }),
    version: async () => "1:1:1",
  } as unknown as GateCC4PublicTruthRuntime;

  it("gives anonymous public reads a separate, larger bucket", async () => {
    const app = await buildApp({
      config: testConfig({ MATCHDAY_CLIENT_IP_SECRET: secret }),
      probes: healthyProbes,
      anonymousRateLimitMax: 1,
      publicReadRateLimitMax: 3,
      gateCC4PublicTruthRuntime: runtime,
    });
    apps.push(app);
    const call = (url: string) =>
      app.inject({ method: "GET", url, headers: signed("203.0.113.7") }).then((response) => response.statusCode);
    expect(await call("/api/v1/status")).toBe(200);
    expect(await call("/api/v1/status")).toBe(429);
    // The exhausted anonymous bucket does not block spectators' public reads.
    expect([
      await call("/api/v1/public/competitions"),
      await call("/api/v1/public/competitions"),
      await call("/api/v1/public/competitions"),
      await call("/api/v1/public/competitions"),
    ]).toEqual([200, 200, 200, 429]);
  });

  it("caps concurrent public SSE streams per client and releases slots on disconnect", async () => {
    const app = await buildApp({
      config: testConfig({ MATCHDAY_CLIENT_IP_SECRET: secret }),
      probes: healthyProbes,
      publicSseMaxStreamsPerClient: 2,
      gateCC4PublicTruthRuntime: runtime,
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/v1/public/competitions/national-open/versions`;
    const controllers: AbortController[] = [];
    const open = async (ip: string) => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(url, { headers: signed(ip), signal: controller.signal });
      if (response.status !== 200) await response.body?.cancel();
      return { response, controller };
    };
    try {
      expect((await open("203.0.113.7")).response.status).toBe(200);
      const second = await open("203.0.113.7");
      expect(second.response.status).toBe(200);
      expect((await open("203.0.113.7")).response.status).toBe(429);
      // Another spectator is unaffected.
      expect((await open("203.0.113.8")).response.status).toBe(200);
      second.controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await open("203.0.113.7")).response.status).toBe(200);
    } finally {
      for (const controller of controllers) controller.abort();
    }
  });
});

describe("scoring access limiter with a Redis outage", () => {
  const keyring = {
    primary: { version: "v2", secret: "synthetic-key-material-at-least-32-bytes" },
    verificationOnly: [],
  };
  const policy = { windowSeconds: 600, cooldownSeconds: 900, pairLimit: 5, ipLimit: 20 };

  function limiter(threshold = 1_000) {
    const warnings: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];
    let now = 1_760_000_000_000;
    const instance = new RedisScoringAccessRateLimiter(unavailableRedis(), keyring, "synthetic:", policy, undefined, {
      now: () => now,
      globalFailureAlarmThreshold: threshold,
      logger: { warn: (payload) => warnings.push(payload), error: (payload) => errors.push(payload) },
    });
    return { instance, warnings, errors, advance: (ms: number) => (now += ms) };
  }

  it("keeps brute-force protection in memory instead of failing open or closed", async () => {
    const { instance, warnings } = limiter();
    expect(await instance.assertAllowed("credential-a", "198.51.100.1")).toEqual({
      limit: 5,
      remaining: 5,
      resetSeconds: 0,
    });
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect((await instance.recordInvalid("credential-a", "198.51.100.1")).remaining).toBe(5 - attempt);
    }
    const locked = await instance.recordInvalid("credential-a", "198.51.100.1");
    expect(locked).toMatchObject({ remaining: 0, retryAfterSeconds: 900 });
    expect((await instance.assertAllowed("credential-a", "198.51.100.1")).retryAfterSeconds).toBe(900);
    // Other scorers (different IP) are not affected by one client's cooldown.
    expect((await instance.assertAllowed("credential-a", "198.51.100.2")).retryAfterSeconds).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeLessThan(5);
  });

  it("enforces the per-IP limit and its cooldown across credentials", async () => {
    const { instance, advance } = limiter();
    for (let attempt = 0; attempt < 19; attempt += 1) {
      await instance.recordInvalid(`credential-${attempt}`, "198.51.100.9");
    }
    expect((await instance.recordInvalid("credential-final", "198.51.100.9")).retryAfterSeconds).toBe(900);
    expect((await instance.assertAllowed("never-tried", "198.51.100.9")).retryAfterSeconds).toBe(900);
    advance(901_000);
    expect((await instance.assertAllowed("never-tried", "198.51.100.9")).retryAfterSeconds).toBeUndefined();
  });

  it("does not abort a valid exchange when success accounting cannot reach Redis", async () => {
    const { instance } = limiter();
    await instance.recordInvalid("credential-a", "198.51.100.1");
    await expect(instance.recordSuccess("credential-a", "198.51.100.1")).resolves.toBeUndefined();
    expect((await instance.assertAllowed("credential-a", "198.51.100.1")).remaining).toBe(5);
  });

  it("raises one global brute-force alarm per window across many clients", async () => {
    const { instance, errors, advance } = limiter(3);
    await instance.recordInvalid("c1", "198.51.100.1");
    await instance.recordInvalid("c2", "198.51.100.2");
    expect(errors).toHaveLength(0);
    await instance.recordInvalid("c3", "198.51.100.3");
    await instance.recordInvalid("c4", "198.51.100.4");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      event: "scoring_access_global_failure_alarm",
      failed_attempts: 3,
      distinct_clients: 3,
      rate_limit_store_degraded: true,
    });
    expect(instance.globalFailureSnapshot()).toMatchObject({ failures: 4, alarmed: true });
    advance(601_000);
    await instance.recordInvalid("c5", "198.51.100.5");
    expect(instance.globalFailureSnapshot()).toMatchObject({ failures: 1, alarmed: false });
  });
});
