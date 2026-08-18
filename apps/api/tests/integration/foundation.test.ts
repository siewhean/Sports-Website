import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { edgeCacheEnvironment, healthyProbes, oidcEnvironment, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("foundation API controls", () => {
  it("keeps liveness independent and reports readiness degradation", async () => {
    const app = await buildApp({
      config: testConfig(),
      probes: { ...healthyProbes, database: async () => false },
    });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().dependencies).toEqual({ database: false, queue: true, redis: true });
  });

  it("protects deep health when a token is configured", async () => {
    const token = "a".repeat(32);
    const app = await buildApp({ config: testConfig({ DEEP_HEALTH_TOKEN: token }), probes: healthyProbes });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health/deep" })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/health/deep", headers: { "x-deep-health-token": token } })).statusCode,
    ).toBe(200);
  });

  it("allowlists CORS origins", async () => {
    const app = await buildApp({ config: testConfig(), probes: healthyProbes });
    apps.push(app);
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/status",
      headers: { origin: "http://127.0.0.1:3000", "access-control-request-method": "GET" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3000");
    const rejected = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/status",
      headers: { origin: "https://attacker.example", "access-control-request-method": "GET" },
    });
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("adds security, request and rate-limit headers", async () => {
    const app = await buildApp({ config: testConfig(), probes: healthyProbes, rateLimitMax: 2 });
    apps.push(app);
    const first = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(first.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect(first.headers["x-frame-options"]).toBe("DENY");
    expect(first.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(first.headers["permissions-policy"]).toContain("camera=()");
    expect(first.headers["x-ratelimit-limit"]).toBe("2");
    await app.inject({ method: "GET", url: "/api/v1/status" });
    expect((await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode).toBe(429);
  });

  it("enforces HSTS in production", async () => {
    const app = await buildApp({
      config: testConfig({
        APP_ENV: "production",
        API_ALLOWED_ORIGINS: "https://app.matchday.example",
        DATABASE_URL: "postgres://matchday:secret@db.internal/matchday",
        DEEP_HEALTH_TOKEN: "a".repeat(32),
        IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.internal:4318",
        REDIS_URL: "redis://cache.internal:6379",
        ...edgeCacheEnvironment(),
        ...oidcEnvironment("https://app.matchday.example", "https://api.matchday.example"),
      }),
      probes: healthyProbes,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(response.headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(response.headers["strict-transport-security"]).toContain("includeSubDomains");
  });

  it("does not expose interactive API documentation in production", async () => {
    const app = await buildApp({
      config: testConfig({
        APP_ENV: "production",
        API_ALLOWED_ORIGINS: "https://app.matchday.example",
        DATABASE_URL: "postgres://matchday:secret@db.internal/matchday",
        DEEP_HEALTH_TOKEN: "a".repeat(32),
        IDENTITY_CSRF_HMAC_SECRET: "c".repeat(32),
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.internal:4318",
        REDIS_URL: "redis://cache.internal:6379",
        ...edgeCacheEnvironment(),
        ...oidcEnvironment("https://app.matchday.example", "https://api.matchday.example"),
      }),
      probes: healthyProbes,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/docs" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("ROUTE_NOT_FOUND");
  });
});
