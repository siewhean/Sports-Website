import { parseSentryDsn, SENTRY_TUNNEL_PATH, sharedSentryOptions } from "./lib/sentry-config";

// Runs before the app hydrates. With no NEXT_PUBLIC_SENTRY_DSN the SDK chunk is
// never requested and nothing is sent. Events go to the same-origin tunnel
// route, so the CSP `connect-src 'self'` needs no Sentry host.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();

if (dsn && parseSentryDsn(dsn)) {
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.init({
      ...sharedSentryOptions(),
      dsn,
      tunnel: SENTRY_TUNNEL_PATH,
      // Breadcrumbs capture click targets, console output and XHR/fetch URLs.
      // Tracing and session replay are never configured.
      integrations: (defaults) => defaults.filter((integration) => integration.name !== "Breadcrumbs"),
    });
  });
}
