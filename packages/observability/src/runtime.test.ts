import { AggregationTemporality, InMemoryMetricExporter, type MetricData } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { startOpenTelemetryRuntime } from "./runtime.js";
import { TraceSpanKind } from "./tracing.js";

function exportedMetrics(exporter: InMemoryMetricExporter): MetricData[] {
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics);
}

describe("OpenTelemetry runtime", () => {
  it("uses provider-neutral no-op instrumentation when disabled", async () => {
    const runtime = await startOpenTelemetryRuntime({
      enabled: false,
      metricExportIntervalMs: 10_000,
      serviceName: "disabled-test",
    });

    expect(() => runtime.metrics.counter("disabled.counter").add(1)).not.toThrow();
    expect(runtime.tracing.withSpan("disabled.span", {}, () => "ok")).toBe("ok");
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it("exports worker-compatible metrics and spans and makes shutdown idempotent", async () => {
    const traceExporter = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const traceShutdown = vi.spyOn(traceExporter, "shutdown").mockResolvedValue();
    const metricShutdown = vi.spyOn(metricExporter, "shutdown");
    const runtime = await startOpenTelemetryRuntime({
      enabled: true,
      endpoint: "http://127.0.0.1:4318",
      metricExportIntervalMs: 60_000,
      metricExporter,
      serviceName: "matchday-worker",
      serviceVersion: "0.1.0",
      traceExporter,
    });

    runtime.metrics.counter("worker.jobs.completed").add(1, { job: "foundation.probe" });
    expect(
      runtime.tracing.withSpan("worker.job foundation.probe", { kind: TraceSpanKind.Consumer }, () => "done"),
    ).toBe("done");

    await runtime.shutdown();
    await runtime.shutdown();

    expect(traceExporter.getFinishedSpans().map((span) => span.name)).toContain("worker.job foundation.probe");
    expect(exportedMetrics(metricExporter).map((metric) => metric.descriptor.name)).toContain("worker.jobs.completed");
    expect(traceShutdown).toHaveBeenCalledOnce();
    expect(metricShutdown).toHaveBeenCalledOnce();
  });
});
