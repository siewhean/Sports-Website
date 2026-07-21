import { getObservabilityContext, runWithObservabilityContext } from "./context.js";
import type { MetricAttributeValue } from "./metrics.js";
import { sanitizeExceptionForTelemetry } from "./sanitize.js";

export type TraceAttributes = Readonly<Record<string, MetricAttributeValue>>;

// Numeric values intentionally align with OpenTelemetry SpanKind.
export enum TraceSpanKind {
  Internal = 0,
  Server = 1,
  Client = 2,
  Producer = 3,
  Consumer = 4,
}

export interface SpanContextLike {
  traceId: string;
  spanId: string;
  traceFlags?: number;
}

export interface SpanLike {
  setAttribute(name: string, value: MetricAttributeValue): this;
  setAttributes(attributes: TraceAttributes): this;
  addEvent(name: string, attributes?: TraceAttributes): this;
  setStatus(status: { code: number; message?: string }): this;
  recordException(error: unknown): void;
  spanContext(): SpanContextLike;
  end(endTime?: number): void;
}

export interface TracerLike {
  startSpan(
    name: string,
    options?: { kind?: TraceSpanKind; attributes?: TraceAttributes },
    parentContext?: unknown,
  ): SpanLike;
}

export interface TracerProviderLike {
  getTracer(name: string, version?: string): TracerLike;
}

/** Adapter for OpenTelemetry's `context.active/with` and `trace.setSpan` APIs. */
export interface ActiveTraceContextAdapter {
  active(): unknown;
  setSpan(context: unknown, providerSpan: unknown): unknown;
  with<T>(context: unknown, callback: () => T): T;
}

const invalidSpanContext: SpanContextLike = {
  traceId: "00000000000000000000000000000000",
  spanId: "0000000000000000",
  traceFlags: 0,
};

class NoopSpan implements SpanLike {
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  addEvent(): this {
    return this;
  }
  setStatus(): this {
    return this;
  }
  recordException(): void {}
  spanContext(): SpanContextLike {
    return invalidSpanContext;
  }
  end(): void {}
}

const providerSpans = new WeakMap<SpanLike, unknown>();

function safeSpan(span?: SpanLike): SpanLike {
  if (!span) return new NoopSpan();
  const wrapped: SpanLike = {
    setAttribute(name, value) {
      try {
        span.setAttribute(name, value);
      } catch {}
      return this;
    },
    setAttributes(attributes) {
      try {
        span.setAttributes(attributes);
      } catch {}
      return this;
    },
    addEvent(name, attributes) {
      try {
        span.addEvent(name, attributes);
      } catch {}
      return this;
    },
    setStatus(status) {
      try {
        span.setStatus(status);
      } catch {}
      return this;
    },
    recordException(error) {
      try {
        span.recordException(sanitizeExceptionForTelemetry(error));
      } catch {}
    },
    spanContext() {
      try {
        return span.spanContext();
      } catch {
        return invalidSpanContext;
      }
    },
    end(endTime) {
      try {
        span.end(endTime);
      } catch {}
    },
  };
  providerSpans.set(wrapped, span);
  return wrapped;
}

export interface StartSpanOptions {
  kind?: TraceSpanKind;
  attributes?: TraceAttributes;
  parentContext?: unknown;
}

export interface TracingRuntime {
  startSpan(name: string, options?: StartSpanOptions): SpanLike;
  withSpan<T>(name: string, options: StartSpanOptions, callback: (span: SpanLike) => T): T;
}

export interface InitializeTracingOptions {
  serviceName: string;
  serviceVersion?: string;
  provider?: TracerProviderLike;
  activeContext?: ActiveTraceContextAdapter;
}

function validIdentifier(value: string, zeroValue: string): boolean {
  return value.length === zeroValue.length && value !== zeroValue;
}

export function initializeTracing(options: InitializeTracingOptions): TracingRuntime {
  let tracer: TracerLike | undefined;
  try {
    tracer = options.provider?.getTracer(options.serviceName, options.serviceVersion);
  } catch {
    tracer = undefined;
  }

  const startSpan = (name: string, spanOptions: StartSpanOptions = {}): SpanLike => {
    try {
      const providerOptions: { kind?: TraceSpanKind; attributes?: TraceAttributes } = {};
      if (spanOptions.kind !== undefined) providerOptions.kind = spanOptions.kind;
      if (spanOptions.attributes !== undefined) providerOptions.attributes = spanOptions.attributes;
      let parentContext = spanOptions.parentContext;
      if (parentContext === undefined) {
        try {
          parentContext = options.activeContext?.active();
        } catch {
          parentContext = undefined;
        }
      }
      return safeSpan(tracer?.startSpan(name, providerOptions, parentContext));
    } catch {
      return new NoopSpan();
    }
  };

  const withSpan = <T>(name: string, spanOptions: StartSpanOptions, callback: (span: SpanLike) => T): T => {
    const span = startSpan(name, spanOptions);
    const spanContext = span.spanContext();
    const propagated = {
      ...getObservabilityContext(),
      ...(validIdentifier(spanContext.traceId, invalidSpanContext.traceId) ? { traceId: spanContext.traceId } : {}),
      ...(validIdentifier(spanContext.spanId, invalidSpanContext.spanId) ? { spanId: spanContext.spanId } : {}),
    };

    const invoke = () => runWithObservabilityContext(propagated, () => callback(span));

    try {
      let result: T;
      if (options.activeContext) {
        let activeContext: unknown;
        let spanContextForCallback: unknown;
        try {
          activeContext = options.activeContext.active();
          const providerSpan = providerSpans.get(span);
          spanContextForCallback =
            providerSpan === undefined ? undefined : options.activeContext.setSpan(activeContext, providerSpan);
        } catch {
          spanContextForCallback = undefined;
        }
        if (spanContextForCallback === undefined) {
          result = invoke();
        } else {
          let invocationStarted = false;
          let invocationReturned = false;
          let callbackResult: T | undefined;
          try {
            result = options.activeContext.with(spanContextForCallback, () => {
              invocationStarted = true;
              callbackResult = invoke();
              invocationReturned = true;
              return callbackResult;
            });
          } catch (error) {
            if (!invocationStarted) result = invoke();
            else if (invocationReturned) result = callbackResult as T;
            else throw error;
          }
        }
      } else {
        result = invoke();
      }
      if (result instanceof Promise) {
        return result
          .catch((error: unknown) => {
            span.recordException(error);
            span.setStatus({ code: 2 });
            throw error;
          })
          .finally(() => span.end()) as T;
      }
      span.end();
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: 2 });
      span.end();
      throw error;
    }
  };

  return {
    startSpan,
    withSpan,
  };
}
