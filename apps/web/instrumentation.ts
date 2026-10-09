import type { Instrumentation } from "next";

import { parseSentryDsn } from "./lib/sentry-config";

function serverSentryEnabled(): boolean {
  return process.env.NEXT_RUNTIME === "nodejs" && parseSentryDsn(process.env.SENTRY_DSN) !== undefined;
}

export async function register() {
  // Fully inert (no SDK import, no network) unless SENTRY_DSN is set.
  if (serverSentryEnabled()) await import("./sentry.server.config");
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!serverSentryEnabled()) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
