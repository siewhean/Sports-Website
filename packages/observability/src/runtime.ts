import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

import { initializeMetrics, type MetricsRuntime } from "./metrics.js";
import { initializeOpenTelemetryMetrics, initializeOpenTelemetryTracing } from "./opentelemetry.js";
import { initializeTracing, type TracingRuntime } from "./tracing.js";

export interface OpenTelemetryRuntime {
  readonly metrics: MetricsRuntime;
  readonly tracing: TracingRuntime;
  shutdown(): Promise<void>;
}

export interface StartOpenTelemetryRuntimeOptions {
  enabled: boolean;
  endpoint?: string;
  metricExportIntervalMs: number;
  serviceName: string;
  serviceVersion?: string;
  traceExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
}

function appendSignalPath(endpoint: string, signalPath: string): string {
  return `${endpoint.replace(/\/$/, "")}${signalPath}`;
}

class DisabledOpenTelemetryRuntime implements OpenTelemetryRuntime {
  readonly metrics: MetricsRuntime;
  readonly tracing: TracingRuntime;

  constructor(serviceName: string, serviceVersion?: string) {
    this.metrics = initializeMetrics({
      serviceName,
      ...(serviceVersion === undefined ? {} : { serviceVersion }),
    });
    this.tracing = initializeTracing({
      serviceName,
      ...(serviceVersion === undefined ? {} : { serviceVersion }),
    });
  }

  async shutdown(): Promise<void> {}
}

class NodeOpenTelemetryRuntime implements OpenTelemetryRuntime {
  readonly metrics: MetricsRuntime;
  readonly tracing: TracingRuntime;
  readonly #sdk: NodeSDK;
  #shutdown: Promise<void> | undefined;

  constructor(sdk: NodeSDK, serviceName: string, serviceVersion?: string) {
    this.#sdk = sdk;
    this.metrics = initializeOpenTelemetryMetrics({
      serviceName,
      ...(serviceVersion === undefined ? {} : { serviceVersion }),
    });
    this.tracing = initializeOpenTelemetryTracing({
      serviceName,
      ...(serviceVersion === undefined ? {} : { serviceVersion }),
    });
  }

  shutdown(): Promise<void> {
    this.#shutdown ??= this.#sdk.shutdown();
    return this.#shutdown;
  }
}

export async function startOpenTelemetryRuntime(
  options: StartOpenTelemetryRuntimeOptions,
): Promise<OpenTelemetryRuntime> {
  if (!options.enabled) {
    return new DisabledOpenTelemetryRuntime(options.serviceName, options.serviceVersion);
  }
  if (!options.endpoint) {
    throw new Error("Telemetry endpoint is required when telemetry is enabled");
  }

  const traceExporter =
    options.traceExporter ??
    new OTLPTraceExporter({
      url: appendSignalPath(options.endpoint, "/v1/traces"),
    });
  const metricExporter =
    options.metricExporter ??
    new OTLPMetricExporter({
      url: appendSignalPath(options.endpoint, "/v1/metrics"),
    });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: options.metricExportIntervalMs,
  });
  const sdk = new NodeSDK({
    metricReaders: [metricReader],
    serviceName: options.serviceName,
    textMapPropagator: new W3CTraceContextPropagator(),
    traceExporter,
  });

  sdk.start();
  return new NodeOpenTelemetryRuntime(sdk, options.serviceName, options.serviceVersion);
}
