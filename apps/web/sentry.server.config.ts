import * as Sentry from "@sentry/nextjs";

import { parseSentryDsn, sharedSentryOptions } from "./lib/sentry-config";

// Loaded from instrumentation.ts only when SENTRY_DSN is a valid DSN.
const dsn = process.env.SENTRY_DSN?.trim();

if (dsn && parseSentryDsn(dsn)) {
  Sentry.init({ ...sharedSentryOptions(), dsn });
}
