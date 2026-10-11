import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

import { scrubSentryBreadcrumb, scrubSentryEvent } from "./sentry-scrub";

/** Same-origin tunnel path; keeps CSP `connect-src 'self'` intact. */
export const SENTRY_TUNNEL_PATH = "/api/monitoring";

export interface ParsedSentryDsn {
  readonly host: string;
  readonly projectId: string;
  readonly publicKey: string;
  readonly protocol: "http:" | "https:";
}

/** Returns undefined for blank or malformed values so Sentry stays fully off. */
export function parseSentryDsn(value: string | undefined): ParsedSentryDsn | undefined {
  const dsn = value?.trim();
  if (!dsn) return undefined;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.split("/").filter(Boolean).pop() ?? "";
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.username || !/^\d+$/u.test(projectId)) {
      return undefined;
    }
    return { host: url.host, projectId, publicKey: url.username, protocol: url.protocol };
  } catch {
    return undefined;
  }
}

/**
 * Options shared by the browser and Node runtimes. Tracing, profiling and
 * session replay are deliberately never enabled (errors only). `process.env.NEXT_PUBLIC_*`
 * reads are written literally so Next inlines them at build time.
 */
export function sharedSentryOptions() {
  return {
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || "development",
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
    maxBreadcrumbs: 20,
    beforeSend: (event: ErrorEvent) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb: Breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
  };
}
