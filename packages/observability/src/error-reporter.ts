import { getObservabilityContext } from "./context.js";
import { sanitizeExceptionForTelemetry, sanitizeForTelemetry, sanitizeTelemetryText } from "./sanitize.js";

export type ErrorSeverity = "fatal" | "error" | "warning" | "info";
export type TelemetryPrimitive = string | number | boolean;

export interface ErrorReportContext {
  severity: ErrorSeverity;
  handled: boolean;
  timestamp: string;
  requestId?: string;
  correlationId?: string;
  jobId?: string;
  traceId?: string;
  spanId?: string;
  attributes?: Readonly<Record<string, unknown>>;
  fingerprint?: readonly string[];
}

export interface ErrorReporterProvider {
  captureException(error: unknown, context: ErrorReportContext): void | Promise<void>;
  captureMessage?(message: string, context: ErrorReportContext): void | Promise<void>;
  flush?(timeoutMilliseconds?: number): void | Promise<void>;
}

export interface ReportErrorOptions {
  severity?: ErrorSeverity;
  handled?: boolean;
  attributes?: Readonly<Record<string, unknown>>;
  fingerprint?: readonly string[];
}

export interface ErrorReporter {
  reportError(error: unknown, options?: ReportErrorOptions): Promise<void>;
  reportMessage(message: string, options?: ReportErrorOptions): Promise<void>;
  flush(timeoutMilliseconds?: number): Promise<void>;
}

function reportContext(options: ReportErrorOptions = {}): ErrorReportContext {
  const active = getObservabilityContext();
  const context: ErrorReportContext = {
    severity: options.severity ?? "error",
    handled: options.handled ?? true,
    timestamp: new Date().toISOString(),
    ...active,
  };
  if (options.attributes) {
    context.attributes = sanitizeForTelemetry(options.attributes) as Readonly<Record<string, unknown>>;
  }
  if (options.fingerprint) context.fingerprint = options.fingerprint.map(sanitizeTelemetryText);
  return context;
}

async function ignoreProviderFailure(operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Telemetry must not become an application failure path.
  }
}

export function createErrorReporter(provider?: ErrorReporterProvider): ErrorReporter {
  return {
    reportError: async (error, options) => {
      if (!provider) return;
      await ignoreProviderFailure(() =>
        provider.captureException(sanitizeExceptionForTelemetry(error), reportContext(options)),
      );
    },
    reportMessage: async (message, options) => {
      if (!provider) return;
      await ignoreProviderFailure(() =>
        provider.captureMessage
          ? provider.captureMessage(sanitizeTelemetryText(message), reportContext(options))
          : provider.captureException(sanitizeExceptionForTelemetry(new Error(message)), reportContext(options)),
      );
    },
    flush: async (timeoutMilliseconds) => {
      if (!provider) return;
      await ignoreProviderFailure(() => provider.flush?.(timeoutMilliseconds));
    },
  };
}
