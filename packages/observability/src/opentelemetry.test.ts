import { context, trace } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import {
  createOpenTelemetryActiveContextAdapter,
  initializeOpenTelemetryMetrics,
  initializeOpenTelemetryTracing,
  startOpenTelemetryRuntime,
  TraceSpanKind,
} from "./index.js";

describe("OpenTelemetry API adapter", () => {
  it("places a real provider Span in an OpenTelemetry Context", () => {
    const providerSpan = trace.getTracer("adapter-test").startSpan("real-span");
    const adapter = createOpenTelemetryActiveContextAdapter();

    const childContext = adapter.setSpan(context.active(), providerSpan);

    expect(trace.getSpan(childContext as ReturnType<typeof context.active>)).toBe(providerSpan);
    expect(adapter.with(childContext, () => "ok")).toBe("ok");
    providerSpan.end();
  });

  it("runs tracing and metrics safely with the real no-op OpenTelemetry API", () => {
    const tracing = initializeOpenTelemetryTracing({ serviceName: "api" });
    const metrics = initializeOpenTelemetryMetrics({ serviceName: "api" });

    expect(tracing.withSpan("http.request", { kind: TraceSpanKind.Server }, () => "ok")).toBe("ok");
    expect(() => metrics.counter("http.server.request.count").add(1)).not.toThrow();
    expect(() => metrics.histogram("http.server.request.duration").record(12)).not.toThrow();
  });

  it("starts a shared SDK that exports metrics and traces and shuts down idempotently", async () => {
    const traceExporter = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const traceShutdown = vi.spyOn(traceExporter, "shutdown").mockResolvedValue();
    const metricShutdown = vi.spyOn(metricExporter, "shutdown");
    const runtime = await startOpenTelemetryRuntime({
      enabled: true,
      endpoint: "http://collector.example.test:4318",
      metricExportIntervalMs: 60_000,
      metricExporter,
      serviceName: "shared-runtime-test",
      serviceVersion: "1.0.0",
      traceExporter,
    });

    runtime.metrics.counter("worker.jobs.completed").add(1, { job: "foundation.probe" });
    runtime.tracing.withSpan(
      "job foundation.probe",
      {
        attributes: { "job.name": "foundation.probe" },
        kind: TraceSpanKind.Consumer,
      },
      () => undefined,
    );

    await Promise.all([runtime.shutdown(), runtime.shutdown()]);

    expect(traceExporter.getFinishedSpans()).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({ "job.name": "foundation.probe" }),
        name: "job foundation.probe",
      }),
    ]);
    const metricNames = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .map((metric) => metric.descriptor.name);
    expect(metricNames).toContain("worker.jobs.completed");
    expect(traceShutdown).toHaveBeenCalledOnce();
    expect(metricShutdown).toHaveBeenCalledOnce();
  });

  it("keeps disabled shared telemetry a safe no-op", async () => {
    const runtime = await startOpenTelemetryRuntime({
      enabled: false,
      metricExportIntervalMs: 10_000,
      serviceName: "disabled-runtime",
    });

    expect(() => runtime.metrics.counter("noop.counter").add(1)).not.toThrow();
    expect(runtime.tracing.withSpan("noop.span", {}, () => "ok")).toBe("ok");
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});
