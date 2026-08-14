import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { healthyProbes, oidcEnvironment, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function stagingConfig(extra: NodeJS.ProcessEnv = {}) {
  return testConfig({
    APP_ENV: "staging",
    IDENTITY_CSRF_HMAC_SECRET: "staging-csrf-secret-that-is-at-least-32-bytes",
    ...oidcEnvironment("https://app.matchday.test"),
    ...extra,
  });
}

describe("deployed API surface hardening", () => {
  it("does not expose interactive API documentation outside local/test", async () => {
    const app = await buildApp({ config: stagingConfig(), probes: healthyProbes });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/docs" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("fails closed for deep health when a deployed environment has no secret", async () => {
    const app = await buildApp({ config: stagingConfig(), probes: healthyProbes });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/deep" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("requires the exact deep-health secret when configured", async () => {
    const app = await buildApp({
      config: stagingConfig({ DEEP_HEALTH_TOKEN: "d".repeat(32) }),
      probes: healthyProbes,
    });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/health/deep" })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/health/deep",
          headers: { "x-deep-health-token": "d".repeat(32) },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("sends long-lived HSTS and disables browser device permissions in deployed environments", async () => {
    const app = await buildApp({ config: stagingConfig(), probes: healthyProbes });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["strict-transport-security"]).toContain("max-age=63072000");
    expect(response.headers["strict-transport-security"]).toContain("includeSubDomains");
    expect(response.headers["strict-transport-security"]).toContain("preload");
    expect(response.headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("keeps local/test developer documentation available", async () => {
    const app = await buildApp({ config: testConfig(), probes: healthyProbes });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/docs/" });
    expect(response.statusCode).toBe(200);
  });
});
