import { describe, expect, it } from "vitest";
import { getObservabilityContext } from "@matchday/observability";
import { startApiTelemetry } from "../../src/telemetry.js";
import { testConfig } from "../helpers.js";

describe("disabled API telemetry", () => {
  it("is a safe local no-op while retaining request correlation", async () => {
    const telemetry = await startApiTelemetry(testConfig());
    const request = telemetry.startRequest({
      headers: {},
      method: "GET",
      path: "/health/live",
      requestId: "request-local-0001",
      route: "/health/live",
    });

    expect(request.correlation).toEqual({ requestId: "request-local-0001" });
    expect(request.run(() => getObservabilityContext())).toEqual({
      requestId: "request-local-0001",
    });
    expect(getObservabilityContext()).toEqual({});
    await expect(request.reportError(new Error("ignored locally"))).resolves.toBeUndefined();
    expect(() => request.finish(200, "/health/live")).not.toThrow();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });
});
