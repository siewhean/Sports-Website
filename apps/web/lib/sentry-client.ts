import { parseSentryDsn } from "./sentry-config";

/**
 * Reports an error caught by a React error boundary (app/error.tsx,
 * app/global-error.tsx). A no-op, without loading the SDK, when Sentry is off.
 */
export function captureClientError(error: unknown): void {
  if (!parseSentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN)) return;
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureException(error);
    })
    .catch(() => undefined);
}
