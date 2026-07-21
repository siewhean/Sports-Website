import { context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import {
  createOpenTelemetryActiveContextAdapter,
  initializeOpenTelemetryMetrics,
  initializeOpenTelemetryTracing,
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
});
