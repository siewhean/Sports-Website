import { afterEach, describe, expect, it, vi } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { startTelemetryRuntime } from "./runtime.js";

const config = {
  enabled: true,
  endpoint: "http://127.0.0.1:4318",
  environment: "test",
  serviceName: "matchday-test",
  metricExportIntervalMs: 60_000,
};
afterEach(() => {
  trace.disable();
  context.disable();
  propagation.disable();
  vi.unstubAllEnvs();
});

describe("shared telemetry runtime", () => {
  it("disabled mode has isolated no-op providers and safe repeated shutdown", async () => {
    const runtime = await startTelemetryRuntime({ ...config, enabled: false });
    expect(runtime.enabled).toBe(false);
    runtime.meterProvider.getMeter("test").createCounter("counter").add(1);
    expect(runtime.tracerProvider.getTracer("test").startSpan("span").isRecording()).toBe(false);
    await runtime.flush();
    await runtime.shutdown();
    await runtime.shutdown();
  });

  it("exports real metrics/traces with only explicit resources and flushes once on shutdown", async () => {
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "secret=private,email=private@example.com");
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const traceExporter = new InMemorySpanExporter();
    const traceShutdown = vi.spyOn(traceExporter, "shutdown").mockResolvedValue();
    const runtime = await startTelemetryRuntime(config, { metricExporter, traceExporter });
    runtime.meterProvider.getMeter("test").createCounter("test.jobs").add(3);
    runtime.tracerProvider.getTracer("test").startSpan("test.job").end();
    await runtime.flush();
    expect(traceExporter.getFinishedSpans()).toHaveLength(1);
    expect(
      metricExporter
        .getMetrics()
        .flatMap((m) => m.scopeMetrics)
        .flatMap((m) => m.metrics)
        .some((m) => m.descriptor.name === "test.jobs"),
    ).toBe(true);
    expect(traceExporter.getFinishedSpans()[0]?.resource.attributes).toEqual({
      "service.name": "matchday-test",
      "service.version": "0.1.0",
      "deployment.environment.name": "test",
    });
    expect(runtime.shutdown()).toBe(runtime.shutdown());
    await runtime.shutdown();
    expect(traceShutdown).toHaveBeenCalledOnce();
  });

  it("bounds flush/shutdown and contains exporter failures", async () => {
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const traceExporter = new InMemorySpanExporter();
    vi.spyOn(metricExporter, "forceFlush").mockRejectedValue(new Error("outage"));
    vi.spyOn(traceExporter, "shutdown").mockImplementation(() => new Promise(() => {}));
    const runtime = await startTelemetryRuntime(config, { metricExporter, traceExporter, shutdownTimeoutMs: 20 });
    runtime.tracerProvider.getTracer("test").startSpan("job").end();
    await expect(runtime.flush()).resolves.toBeUndefined();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it.each(["first", "second"])(
    "re-registers context and preserves surviving runtime when %s shuts down",
    async (order) => {
      const first = await startTelemetryRuntime(config, {
        traceExporter: new InMemorySpanExporter(),
        metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      });
      const second = await startTelemetryRuntime(config, {
        traceExporter: new InMemorySpanExporter(),
        metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      });
      const surviving = order === "first" ? second : first;
      const stopping = order === "first" ? first : second;
      const span = surviving.tracerProvider.getTracer("test").startSpan("survivor");
      await stopping.shutdown();
      expect(context.with(trace.setSpan(context.active(), span), () => trace.getActiveSpan())).toBe(span);
      span.end();
      await surviving.shutdown();
      const restarted = await startTelemetryRuntime(config, {
        traceExporter: new InMemorySpanExporter(),
        metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      });
      const nextSpan = restarted.tracerProvider.getTracer("test").startSpan("restart");
      expect(context.with(trace.setSpan(context.active(), nextSpan), () => trace.getActiveSpan())).toBe(nextSpan);
      nextSpan.end();
      await restarted.shutdown();
    },
  );

  it.each(["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_HEADERS"])(
    "rejects implicit credential headers: %s",
    async (key) => {
      vi.stubEnv(key, "authorization=private");
      await expect(startTelemetryRuntime(config)).rejects.toThrow("collector boundary");
    },
  );
});
