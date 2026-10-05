import {
  context,
  propagation,
  createNoopMeter,
  ProxyTracerProvider,
  type MeterProvider,
  type TracerProvider,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider as SdkMeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface TelemetryRuntimeConfig {
  enabled: boolean;
  endpoint?: string;
  metricExportIntervalMs: number;
  environment: string;
  serviceName: string;
  serviceVersion?: string;
}

export interface StartTelemetryRuntimeOptions {
  traceExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
  metricExportIntervalMs?: number;
  shutdownTimeoutMs?: number;
}

export interface TelemetryRuntime {
  readonly enabled: boolean;
  readonly meterProvider: MeterProvider;
  readonly tracerProvider: TracerProvider;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

interface ContextLease {
  manager: AsyncLocalStorageContextManager;
  count: number;
  ownsContext: boolean;
  ownsPropagation: boolean;
}
let contextLease: ContextLease | undefined;

function acquireContext(): () => void {
  if (!contextLease) {
    const manager = new AsyncLocalStorageContextManager().enable();
    contextLease = {
      manager,
      count: 0,
      ownsContext: context.setGlobalContextManager(manager),
      ownsPropagation: propagation.setGlobalPropagator(new W3CTraceContextPropagator()),
    };
  }
  const lease = contextLease;
  lease.count += 1;
  return () => {
    lease.count -= 1;
    if (lease.count !== 0) return;
    if (lease.ownsContext) context.disable();
    else lease.manager.disable();
    if (lease.ownsPropagation) propagation.disable();
    if (contextLease === lease) contextLease = undefined;
  };
}

function disabledRuntime(): TelemetryRuntime {
  // Independent providers avoid picking up another runtime's registered global SDK.
  const tracerProvider = new ProxyTracerProvider();
  return {
    enabled: false,
    meterProvider: { getMeter: () => createNoopMeter() },
    tracerProvider,
    flush: async () => undefined,
    shutdown: async () => undefined,
  };
}

async function bounded(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Export outages must never turn application shutdown or work into a failure.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Explicit, credential-free exporters. No automatic HTTP/SQL instrumentation or env resource detectors. */
export async function startTelemetryRuntime(
  config: TelemetryRuntimeConfig,
  options: StartTelemetryRuntimeOptions = {},
): Promise<TelemetryRuntime> {
  if (!config.enabled) return disabledRuntime();
  if (!config.endpoint) throw new Error("Telemetry endpoint is required when telemetry is enabled");
  if (
    ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_HEADERS"].some(
      (key) => Boolean(process.env[key]?.trim()),
    )
  ) {
    throw new Error("Application telemetry authentication headers must be configured at the collector boundary");
  }
  const endpoint = new URL(config.endpoint);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Telemetry endpoint must be an HTTP URL without credentials, query or fragment");
  }
  const timeoutMs = options.shutdownTimeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Telemetry shutdown timeout must be positive");
  const intervalMs = options.metricExportIntervalMs ?? config.metricExportIntervalMs;
  const base = endpoint.href.replace(/\/$/, "");
  // Never source attributes from OTEL_RESOURCE_ATTRIBUTES or process environment.
  const resource = resourceFromAttributes({
    "service.name": config.serviceName,
    "service.version": config.serviceVersion ?? "0.1.0",
    "deployment.environment.name": config.environment,
  });
  const traceExporter =
    options.traceExporter ?? new OTLPTraceExporter({ url: `${base}/v1/traces`, headers: {}, timeoutMillis: timeoutMs });
  const metricExporter =
    options.metricExporter ??
    new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers: {}, timeoutMillis: timeoutMs });
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter, { exportTimeoutMillis: timeoutMs })],
  });
  const meterProvider = new SdkMeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: intervalMs,
        exportTimeoutMillis: Math.min(intervalMs, timeoutMs),
      }),
    ],
  });
  const releaseContext = acquireContext();
  let shutdown: Promise<void> | undefined;
  const flush = async (): Promise<void> => {
    await bounded(async () => {
      await Promise.allSettled([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    }, timeoutMs);
  };
  return {
    enabled: true,
    meterProvider,
    tracerProvider,
    flush: () => shutdown ?? flush(),
    shutdown: () => {
      shutdown ??= (async () => {
        await flush();
        await bounded(async () => {
          await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
        }, timeoutMs);
        releaseContext();
      })();
      return shutdown;
    },
  };
}
