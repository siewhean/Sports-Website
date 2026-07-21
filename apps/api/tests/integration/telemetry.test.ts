import { AggregationTemporality, InMemoryMetricExporter, type MetricData } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { getObservabilityContext } from "@matchday/observability";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { startApiTelemetry } from "../../src/telemetry.js";
import { healthyProbes, testConfig } from "../helpers.js";

function exportedMetrics(exporter: InMemoryMetricExporter): MetricData[] {
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics);
}

describe("API OpenTelemetry integration", () => {
  it("exports parented request spans, correlated metrics, sanitized exceptions, and shuts down", async () => {
    const traceExporter = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const traceShutdown = vi.spyOn(traceExporter, "shutdown").mockResolvedValue();
    const metricShutdown = vi.spyOn(metricExporter, "shutdown");
    const config = testConfig({
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
    });
    const telemetry = await startApiTelemetry(config, {
      metricExporter,
      metricExportIntervalMs: 60_000,
      traceExporter,
    });
    const probeError = new Error("database failed for person@example.com with token=private", {
      cause: { password: "secret" },
    });
    let runtimeProbe: { activeSpan: boolean; requestId?: string; spanId?: string; traceId?: string } | undefined;
    const app = await buildApp({
      config,
      probes: {
        ...healthyProbes,
        database: async () => {
          const correlation = getObservabilityContext();
          runtimeProbe = {
            activeSpan: Boolean(trace.getActiveSpan()),
            ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
            ...(correlation.spanId ? { spanId: correlation.spanId } : {}),
            ...(correlation.traceId ? { traceId: correlation.traceId } : {}),
          };
          throw probeError;
        },
      },
      telemetry,
    });

    const traceId = "1".repeat(32);
    const parentSpanId = "2".repeat(16);
    const successRequestId = "request-success-0001";
    const failedRequestId = "request-failed-0001";
    const success = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: {
        traceparent: `00-${traceId}-${parentSpanId}-01`,
        "x-request-id": successRequestId,
      },
    });
    const failed = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { "x-request-id": failedRequestId },
    });
    expect(success.statusCode).toBe(200);
    expect(failed.statusCode).toBe(500);

    await app.close();
    await telemetry.shutdown();

    const spans = traceExporter.getFinishedSpans();
    const successSpan = spans.find((span) => span.attributes["request.id"] === successRequestId);
    const failedSpan = spans.find((span) => span.attributes["request.id"] === failedRequestId);
    expect(
      successSpan,
      JSON.stringify(spans.map((span) => ({ attributes: span.attributes, name: span.name }))),
    ).toBeDefined();
    expect(failedSpan).toBeDefined();
    expect(successSpan?.parentSpanContext).toMatchObject({ spanId: parentSpanId, traceId });
    expect(successSpan?.name).toBe("GET /api/v1/status");
    expect(failedSpan?.status.code).toBe(2);
    expect(failedSpan?.attributes).toMatchObject({
      "error.handled": true,
      "error.severity": "error",
      "request.id": failedRequestId,
    });
    expect(runtimeProbe).toEqual({
      activeSpan: true,
      requestId: failedRequestId,
      spanId: failedSpan?.spanContext().spanId,
      traceId: failedSpan?.spanContext().traceId,
    });
    const exceptionText = JSON.stringify(failedSpan?.events);
    expect(exceptionText).toContain("[REDACTED_EMAIL]");
    expect(exceptionText).toContain("[REDACTED]");
    expect(exceptionText).not.toContain("person@example.com");
    expect(exceptionText).not.toContain("token=private");
    expect(exceptionText).not.toContain('"password":"secret"');

    const metrics = exportedMetrics(metricExporter);
    const requestCount = metrics.find((metric) => metric.descriptor.name === "http.server.request.count");
    const requestDuration = metrics.find((metric) => metric.descriptor.name === "http.server.request.duration");
    expect(requestCount?.dataPoints.map((point) => point.attributes)).toEqual(
      expect.arrayContaining([
        {
          "http.request.method": "GET",
          "http.response.status_code": 200,
          "http.route": "/api/v1/status",
        },
        {
          "http.request.method": "GET",
          "http.response.status_code": 500,
          "http.route": "/health/ready",
        },
      ]),
    );
    expect(requestDuration?.dataPoints).toHaveLength(2);
    expect(traceShutdown).toHaveBeenCalledOnce();
    expect(metricShutdown).toHaveBeenCalledOnce();
  });
});
