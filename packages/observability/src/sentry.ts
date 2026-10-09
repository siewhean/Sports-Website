import { createRequire } from "node:module";
import type * as SentryNode from "@sentry/node";

import type { ErrorReportContext, ErrorReporterProvider } from "./error-reporter.js";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "./sentry-scrub.js";

export interface SentryNodeOptions {
  /** Short service label, e.g. `matchday-api`. Attached as a tag. */
  service: string;
  /** Overrides `process.env`; used by tests. */
  env?: Readonly<Record<string, string | undefined>>;
}

const levelBySeverity = { fatal: "fatal", error: "error", warning: "warning", info: "info" } as const;

function validDsn(value: string | undefined): string | undefined {
  const dsn = value?.trim();
  if (!dsn) return undefined;
  try {
    const parsed = new URL(dsn);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.username) return undefined;
    return dsn;
  } catch {
    return undefined;
  }
}

/**
 * Initialises @sentry/node only when SENTRY_DSN is a valid DSN. Returns
 * undefined otherwise, in which case nothing is installed (no handlers, no
 * network). Tracing is off and no OpenTelemetry provider is registered (the app
 * owns its own); only errors are reported.
 */
export function initSentryNode(options: SentryNodeOptions): ErrorReporterProvider | undefined {
  const env = options.env ?? process.env;
  const dsn = validDsn(env.SENTRY_DSN);
  if (!dsn) return undefined;

  // Loaded only when a DSN is configured: @sentry/node is heavy to import, and every
  // API/worker process (and short-lived child processes) imports this package.
  const Sentry = createRequire(import.meta.url)("@sentry/node") as typeof SentryNode;
  Sentry.init({
    dsn,
    release: env.MATCHDAY_BUILD_ID?.trim() || env.GIT_SHA?.trim() || undefined,
    environment: env.APP_ENV?.trim() || "development",
    // SDK v11 replaced `sendDefaultPii` with `dataCollection`; everything personal is off.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // No OpenTelemetry provider registration or module hooks: errors only.
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    defaultIntegrations: false,
    integrations: [
      Sentry.dedupeIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      // "strict" re-raises after capture so Node's default crash-on-rejection
      // semantics (and supervisor restarts) are preserved.
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
    ],
    beforeSend: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
    initialScope: { tags: { service: options.service } },
  });

  const apply = (scope: SentryNode.Scope, context: ErrorReportContext) => {
    scope.setLevel(levelBySeverity[context.severity]);
    scope.setTag("handled", String(context.handled));
    if (context.requestId) scope.setTag("request_id", context.requestId);
    if (context.correlationId) scope.setTag("correlation_id", context.correlationId);
    if (context.jobId) scope.setTag("job_id", context.jobId);
    if (context.traceId) scope.setTag("trace_id", context.traceId);
    if (context.fingerprint) scope.setFingerprint([...context.fingerprint]);
    if (context.attributes) scope.setContext("attributes", { ...context.attributes });
  };

  return {
    captureException: (error, context) => {
      Sentry.withScope((scope) => {
        apply(scope, context);
        Sentry.captureException(error);
      });
    },
    captureMessage: (message, context) => {
      Sentry.withScope((scope) => {
        apply(scope, context);
        Sentry.captureMessage(message);
      });
    },
    flush: async (timeoutMilliseconds = 2_000) => {
      await Sentry.flush(timeoutMilliseconds);
    },
  };
}
