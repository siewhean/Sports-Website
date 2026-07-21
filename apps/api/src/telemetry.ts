import {
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Attributes,
  type Counter,
  type Context,
  type Exception,
  type Histogram,
  type Span,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { AppConfig } from "@matchday/config";
import {
  createErrorReporter,
  runWithObservabilityContext,
  type ErrorReporter,
  type ErrorReporterProvider,
  type ObservabilityContext,
} from "@matchday/observability";

const serviceName = "matchday-api";
const serviceVersion = "0.1.0";

export interface RequestTelemetryInput {
  requestId: string;
  method: string;
  path: string;
  route: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface RequestTelemetryHandle {
  readonly correlation: Readonly<ObservabilityContext>;
  run<T>(callback: () => T): T;
  reportError(error: unknown): Promise<void>;
  finish(statusCode: number, route: string): void;
}

export interface ApiTelemetry {
  startRequest(input: RequestTelemetryInput): RequestTelemetryHandle;
  shutdown(): Promise<void>;
}

export interface StartApiTelemetryOptions {
  traceExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
  metricExportIntervalMs?: number;
}

class DisabledRequestTelemetry implements RequestTelemetryHandle {
  readonly correlation: Readonly<ObservabilityContext>;

  constructor(requestId: string) {
    this.correlation = Object.freeze({ requestId });
  }

  async reportError(): Promise<void> {}
  finish(): void {}
  run<T>(callback: () => T): T {
    return runWithObservabilityContext(this.correlation, callback);
  }
}

class DisabledApiTelemetry implements ApiTelemetry {
  startRequest(input: RequestTelemetryInput): RequestTelemetryHandle {
    return new DisabledRequestTelemetry(input.requestId);
  }

  async shutdown(): Promise<void> {}
}

export function createDisabledApiTelemetry(): ApiTelemetry {
  return new DisabledApiTelemetry();
}

function appendSignalPath(endpoint: string, signalPath: string): string {
  return `${endpoint.replace(/\/$/, "")}${signalPath}`;
}

function createSpanErrorReporter(): ErrorReporter {
  const provider: ErrorReporterProvider = {
    captureException(error, reportContext) {
      const activeSpan = trace.getActiveSpan();
      if (!activeSpan) return;
      activeSpan.recordException(error as Exception);
      activeSpan.setStatus({ code: SpanStatusCode.ERROR });
      const attributes: Attributes = {
        "error.handled": reportContext.handled,
        "error.severity": reportContext.severity,
      };
      if (reportContext.requestId) attributes["request.id"] = reportContext.requestId;
      if (reportContext.jobId) attributes["job.id"] = reportContext.jobId;
      activeSpan.setAttributes(attributes);
    },
  };
  return createErrorReporter(provider);
}

class OpenTelemetryRequest implements RequestTelemetryHandle {
  readonly correlation: Readonly<ObservabilityContext>;
  readonly #activeContext: Context;
  readonly #errorReporter: ErrorReporter;
  readonly #method: string;
  readonly #requestCount: Counter;
  readonly #requestDuration: Histogram;
  readonly #span: Span;
  readonly #startedAt = performance.now();
  #finished = false;

  constructor(
    input: RequestTelemetryInput,
    instruments: {
      requestCount: Counter;
      requestDuration: Histogram;
    },
    errorReporter: ErrorReporter,
  ) {
    const tracer = trace.getTracer(serviceName, serviceVersion);
    const parentContext = propagation.extract(context.active(), input.headers);
    this.#span = tracer.startSpan(
      `${input.method} ${input.route}`,
      {
        attributes: {
          "http.request.method": input.method,
          "http.route": input.route,
          "request.id": input.requestId,
          "url.path": input.path,
        },
        kind: SpanKind.SERVER,
      },
      parentContext,
    );
    this.#activeContext = trace.setSpan(parentContext, this.#span);
    const spanContext = this.#span.spanContext();
    this.correlation = Object.freeze({
      requestId: input.requestId,
      ...(spanContext.traceId && !/^0+$/.test(spanContext.traceId) ? { traceId: spanContext.traceId } : {}),
      ...(spanContext.spanId && !/^0+$/.test(spanContext.spanId) ? { spanId: spanContext.spanId } : {}),
    });
    this.#errorReporter = errorReporter;
    this.#method = input.method;
    this.#requestCount = instruments.requestCount;
    this.#requestDuration = instruments.requestDuration;
  }

  run<T>(callback: () => T): T {
    return context.with(this.#activeContext, () => runWithObservabilityContext(this.correlation, callback));
  }

  async reportError(error: unknown): Promise<void> {
    try {
      await this.run(() =>
        this.#errorReporter.reportError(error, {
          attributes: { "http.request.method": this.#method },
          handled: true,
          severity: "error",
        }),
      );
    } catch {
      // Telemetry must not become an application failure path.
    }
  }

  finish(statusCode: number, route: string): void {
    if (this.#finished) return;
    this.#finished = true;
    const durationMilliseconds = performance.now() - this.#startedAt;
    const metricAttributes = {
      "http.request.method": this.#method,
      "http.response.status_code": statusCode,
      "http.route": route,
    } satisfies Attributes;

    try {
      this.run(() => {
        try {
          this.#span.updateName(`${this.#method} ${route}`);
          this.#span.setAttributes({
            "http.response.status_code": statusCode,
            "http.route": route,
          });
          if (statusCode >= 500) this.#span.setStatus({ code: SpanStatusCode.ERROR });
          this.#requestCount.add(1, metricAttributes);
          this.#requestDuration.record(durationMilliseconds, metricAttributes);
        } finally {
          this.#span.end();
        }
      });
    } catch {
      // Response completion must not fail because telemetry is unavailable.
    }
  }
}

class OpenTelemetryApiTelemetry implements ApiTelemetry {
  readonly #errorReporter = createSpanErrorReporter();
  readonly #requestCount = metrics.getMeter(serviceName, serviceVersion).createCounter("http.server.request.count", {
    description: "Completed inbound HTTP requests",
    unit: "{request}",
  });
  readonly #requestDuration = metrics
    .getMeter(serviceName, serviceVersion)
    .createHistogram("http.server.request.duration", {
      description: "Inbound HTTP request duration",
      unit: "ms",
    });
  readonly #sdk: NodeSDK;
  #shutdown: Promise<void> | undefined;

  constructor(sdk: NodeSDK) {
    this.#sdk = sdk;
  }

  startRequest(input: RequestTelemetryInput): RequestTelemetryHandle {
    try {
      return new OpenTelemetryRequest(
        input,
        { requestCount: this.#requestCount, requestDuration: this.#requestDuration },
        this.#errorReporter,
      );
    } catch {
      return new DisabledRequestTelemetry(input.requestId);
    }
  }

  shutdown(): Promise<void> {
    this.#shutdown ??= this.#sdk.shutdown();
    return this.#shutdown;
  }
}

export async function startApiTelemetry(
  config: AppConfig,
  options: StartApiTelemetryOptions = {},
): Promise<ApiTelemetry> {
  if (!config.telemetry.enabled) return createDisabledApiTelemetry();
  if (!config.telemetry.endpoint) {
    throw new Error("Telemetry endpoint is required when telemetry is enabled");
  }

  const traceExporter =
    options.traceExporter ??
    new OTLPTraceExporter({
      url: appendSignalPath(config.telemetry.endpoint, "/v1/traces"),
    });
  const metricExporter =
    options.metricExporter ??
    new OTLPMetricExporter({
      url: appendSignalPath(config.telemetry.endpoint, "/v1/metrics"),
    });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: options.metricExportIntervalMs ?? config.telemetry.metricExportIntervalMs,
  });
  const sdk = new NodeSDK({
    metricReaders: [metricReader],
    serviceName,
    textMapPropagator: new W3CTraceContextPropagator(),
    traceExporter,
  });
  sdk.start();
  return new OpenTelemetryApiTelemetry(sdk);
}
