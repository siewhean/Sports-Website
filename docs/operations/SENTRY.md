# Sentry error tracking

Sentry is optional and **off unless a DSN is set**. With no DSN there are no SDK handlers, no network calls and no behaviour change in web, API or worker.

## What is reported

| Service              | SDK                                                 | Captured                                                                                                                                     |
| -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (Vercel and OCI) | `@sentry/nextjs` 11.6.0                             | Server render/route errors (`onRequestError`), browser unhandled errors/rejections, React error boundaries (`error.tsx`, `global-error.tsx`) |
| API                  | `@sentry/node` 11.6.0 via `@matchday/observability` | 5xx from the Fastify error handler (never 4xx `ApiError`s), `uncaughtException`, `unhandledRejection`; flushed on SIGTERM/SIGINT             |
| Worker               | same                                                | Jobs dead-lettered after the final retry, `uncaughtException`, `unhandledRejection`; flushed during shutdown                                 |

Release is `MATCHDAY_BUILD_ID` (git SHA); environment is `APP_ENV` (web falls back to `VERCEL_ENV`).

## Privacy (PDPA)

- All SDK data collection is disabled (`dataCollection`: no user info, cookies, headers, bodies, query params, local variables). v11 replaced `sendDefaultPii` with this option.
- `beforeSend` additionally drops `user`, cookies, query strings and request bodies, redacts cookie/authorization/CSRF/`x-scoring-session-*`/token-like keys, strips URL query strings, redacts long opaque path segments and masks email-like text. The scrubber lives in `packages/observability/src/sentry-scrub.ts` and `apps/web/lib/sentry-scrub.ts` (keep both in sync).
- No session replay, tracing, profiling or click/console breadcrumbs.
- The browser posts to the same-origin `/api/monitoring` tunnel, so Sentry sees the server IP, not the visitor's, and the CSP keeps `connect-src 'self'`. The tunnel only forwards envelopes whose DSN host, project and key match the configured DSN.

## Create the free Sentry project

1. Sign up at sentry.io (Developer plan is free) and pick a data region. For PDPA, choose the region you are comfortable holding diagnostics in (EU/US; there is no Singapore region) and note it in your records.
2. Create **one project**, platform **Next.js** (it also works as a single DSN for API and worker). Optionally create separate `matchday-web` and `matchday-api` projects; if so, use each project's DSN for its service, and set `NEXT_PUBLIC_SENTRY_DSN` equal to the web project's `SENTRY_DSN`.
3. Copy the DSN from **Settings > Projects > (project) > Client Keys (DSN)**.

## Configure DSNs

**Vercel** (project `apps/web`, Settings > Environment Variables; Production and Preview as wanted):

- `SENTRY_DSN` = the DSN (server runtime)
- `NEXT_PUBLIC_SENTRY_DSN` = the same DSN (inlined at build, so redeploy after changing)
- Optional source maps: `SENTRY_AUTH_TOKEN` (org token with `project:releases`/source-map upload scope), `SENTRY_ORG`, `SENTRY_PROJECT`. Without the token builds skip the Sentry build plugin entirely and never contact Sentry.

**OCI VM** (`infra/oci/.env.prod`, then run the normal deploy so the web image is rebuilt):

```
SENTRY_DSN=https://<key>@o<org>.ingest.<region>.sentry.io/<project>
NEXT_PUBLIC_SENTRY_DSN=https://<key>@o<org>.ingest.<region>.sentry.io/<project>
```

API and worker read `SENTRY_DSN` through `env_file`; web receives both through `compose.prod.yaml` (the public one as a Docker build arg). The VM needs outbound HTTPS to the Sentry ingest host (API/worker directly, web via the tunnel).

To disable: blank the variables and redeploy.

## Alert rules (email, web, and API)

In Sentry: **Alerts > Create Alert**, configured in each Sentry project you created (the single shared project, or `matchday-web` and `matchday-api` if split):

### Rule 1: Production New Error (Issue Alert)

- **Name**: `Production New Issue Alert`
- **When**: An event is captured and "A new issue is created" (`first_seen_event`).
- **If**: The event's tags match `environment:production`.
- **Then**: "Send a notification to Member/Team" (owner email / SMS / paging integration).
- **Frequency**: Trigger on every new issue.

### Rule 2: Production Error Spike (Metric Alert)

- **Name**: `Production Error Spike Alert`
- **Metric**: `count()` of errors
- **Filter**: `event.type:error environment:production`
- **Time Window**: 5 minutes
- **Thresholds**:
  - **Critical**: `> 20` events in 5 minutes
  - **Warning**: `> 10` events in 5 minutes
- **Actions**: Trigger immediate alert email / notification; send resolved notification when rate drops below warning threshold.

### Rule 3: Production Fatal Event (Issue Alert)

Rule 1 fires only on the first event of a new issue. Rule 3 covers repeats of an existing issue that are fatal (process
crash, unhandled rejection), which Rule 1 would stay silent on.

- **Name**: `Production Fatal Event Alert`
- **When**: "An event is captured" (every event, not only new issues).
- **If**: `environment:production` AND `level:fatal`. Every service tags its events with `service` (`matchday-web`,
  `matchday-api`, `matchday-worker`, set by `initialScope` in `packages/observability/src/sentry.ts`); in a single shared
  project, add `tag[service]:matchday-worker` as a separate copy of this rule if worker crashes need a distinct route.
- **Then**: Send immediate notification to owner/team.
- **Frequency**: at most once per 5 minutes per issue (avoids a crash loop flooding the inbox).

### Inbound Filters & Quota Protection

- Check **Settings > Projects > (project) > Inbound Filters**:
  - Enable "Filter out errors known to be caused by browser extensions".
  - Enable "Filter out events coming from localhost or local IP addresses".
  - Enable "Spike Protection" under Project Settings.
- Check **Settings > Account > Notifications** to ensure email notifications are enabled and verified.

## Verifying after setup

Point a non-production deployment at a non-production DSN with `APP_ENV` set to a non-production value, then trigger a
test error (for example, temporarily throw from a non-production-only code path, or call `Sentry.captureException` from a
Node REPL in the API container on that host). Confirm the event shows release = the deployed SHA, carries the expected
`service` tag (`matchday-web`, `matchday-api` or `matchday-worker`), contains no cookies, headers, query strings or email
addresses, and that the alert rules above notify. Do not test against the production project.
