import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("API request contract", () => {
  it("accepts a valid caller request ID", async () => {
    const app = await buildApp({ config: testConfig(), probes: healthyProbes });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { "x-request-id": "client-req-1234" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("client-req-1234");
    expect(response.json().request_id).toBe("client-req-1234");
  });

  it("replaces malformed request IDs", async () => {
    const app = await buildApp({ config: testConfig(), probes: healthyProbes });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v1/status", headers: { "x-request-id": "bad id" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses the structured error envelope on unknown and unversioned routes", async () => {
    const app = await buildApp({ config: testConfig(), probes: healthyProbes });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/status" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route not found",
        request_id: response.headers["x-request-id"],
      },
    });
  });

  it("rejects an unsupported negotiated API version with the validation envelope", async () => {
    const app = await buildApp({ config: testConfig(), probes: healthyProbes });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { "accept-version": "2" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        request_id: response.headers["x-request-id"],
      },
    });
  });
});
