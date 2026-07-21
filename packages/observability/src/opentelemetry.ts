import { context, metrics, trace, type Context, type Meter, type Span, type Tracer } from "@opentelemetry/api";

import { initializeMetrics, type MetricsRuntime } from "./metrics.js";
import {
  initializeTracing,
  type ActiveTraceContextAdapter,
  type InitializeTracingOptions,
  type TracerLike,
  type TracingRuntime,
} from "./tracing.js";

export function createOpenTelemetryActiveContextAdapter(): ActiveTraceContextAdapter {
  return {
    active: () => context.active(),
    setSpan: (activeContext, providerSpan) => trace.setSpan(activeContext as Context, providerSpan as Span),
    with: <T>(activeContext: unknown, callback: () => T): T => context.with(activeContext as Context, callback),
  };
}

export function initializeOpenTelemetryTracing(
  options: Omit<InitializeTracingOptions, "provider" | "activeContext">,
): TracingRuntime {
  return initializeTracing({
    ...options,
    activeContext: createOpenTelemetryActiveContextAdapter(),
    provider: {
      getTracer: (name, version) => trace.getTracer(name, version) as Tracer as TracerLike,
    },
  });
}

export function initializeOpenTelemetryMetrics(options: {
  serviceName: string;
  serviceVersion?: string;
}): MetricsRuntime {
  return initializeMetrics({
    ...options,
    provider: {
      getMeter: (name, version) => metrics.getMeter(name, version) as Meter,
    },
  });
}
