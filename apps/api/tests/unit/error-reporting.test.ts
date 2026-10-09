import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorReporter } from "@matchday/observability";
import { buildApp } from "../../src/app.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function spyReporter() {
  const reportError = vi.fn<ErrorReporter["reportError"]>().mockResolvedValue(undefined);
  const reporter: ErrorReporter = { reportError, reportMessage: vi.fn(), flush: vi.fn() };
  return { reporter, reportError };
}

describe("API error reporting", () => {
  it("reports unexpected 5xx failures but not 4xx rejections", async () => {
    const { reporter, reportError } = spyReporter();
    const failure = new Error("database exploded");
    // A rejecting dependency probe surfaces as an unexpected 500 on /health/deep.
    const app = await buildApp({
      config: testConfig(),
      probes: {
        ...healthyProbes,
        database: async () => {
          throw failure;
        },
      },
      errorReporter: reporter,
    });
    apps.push(app);

    const bad = await app.inject({ method: "GET", url: "/api/v1/missing" });
    expect(bad.statusCode).toBe(404);
    expect(reportError).not.toHaveBeenCalled();

    const boom = await app.inject({ method: "GET", url: "/health/deep" });
    expect(boom.statusCode).toBe(500);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBe(failure);
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({ attributes: { status_code: 500, method: "GET" } });
  });

  it("behaves identically with no reporter configured", async () => {
    const app = await buildApp({
      config: testConfig(),
      probes: {
        ...healthyProbes,
        database: async () => {
          throw new Error("x");
        },
      },
    });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/health/deep" })).statusCode).toBe(500);
  });
});
