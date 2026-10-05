import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

import { initializeMetrics, type MetricsRuntime } from "./metrics.js";
import {
  initializeOpenTelemetryMetrics,
  initializeOpenTelemetryTracing,
} from "./opentelemetry.js";
import { initializeTracing, type TracingRuntime } from "./tracing.js";

export interface OpenTelemetryRuntime {
  metrics: MetricsRuntime;
  tracing: TracingRuntime;
  shutdown(): Promise<void>;
}

export interface StartOpenTelemetryRuntimeOptions {
  enabled: boolean;
  endpoint?: string;
  metricExportIntervalMs: number;
  metricExporter?: PushMetricExporter;
  serviceName: string;
  serviceVersion?: string;
  traceExporter?: SpanExporter;
}

function appendSignalPath(endpoint: string, signalPath: string): string {
  return `${endpoint.replace(/\/$/, "")}${signalPath}`;
}

function createDisabledRuntime(options: StartOpenTelemetryRuntimeOptions): OpenTelemetryRuntime {
  return {
    metrics: initializeMetrics({
      serviceName: options.serviceName,
      ...(options.serviceVersion ? { serviceVersion: options.serviceVersion } : {}),
    }),
    tracing: initializeTracing({
      serviceName: options.serviceName,
      ...(options.serviceVersion ? { serviceVersion: options.serviceVersion } : {}),
    }),
    async shutdown() {},
  };
}

export async function startOpenTelemetryRuntime(
  options: StartOpenTelemetryRuntimeOptions,
): Promise<OpenTelemetryRuntime> {
  if (!options.enabled) return createDisabledRuntime(options);
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

  let shutdown: Promise<void> | undefined;
  return {
    metrics: initializeOpenTelemetryMetrics({
      serviceName: options.serviceName,
      ...(options.serviceVersion ? { serviceVersion: options.serviceVersion } : {}),
    }),
    tracing: initializeOpenTelemetryTracing({
      serviceName: options.serviceName,
      ...(options.serviceVersion ? { serviceVersion: options.serviceVersion } : {}),
    }),
    shutdown() {
      shutdown ??= sdk.shutdown();
      return shutdown;
    },
  };
}
