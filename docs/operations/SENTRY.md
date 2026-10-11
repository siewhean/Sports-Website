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

## Alert rules (email)

In Sentry: **Alerts > Create Alert > Issues**, per project.

1. **New issue**: When "A new issue is created", filter `environment:production`, action "Send a notification to Member/Team" (email).
2. **Spike**: Issue alert, When "Issue is seen more than 20 times in 1 hour" (tune the threshold), filter `environment:production`, action email. Alternatively a Metric alert on `count()` of errors with a critical threshold.
3. Optionally an issue alert for tag `service:matchday-api` or `service:matchday-worker` with a lower threshold, since those include dead-lettered jobs.

Check **Settings > Account > Notifications** so your email receives issue alerts. Free plan quotas are small; enable "spike protection" and set an inbound filter for noisy browser extensions.

## Verifying after setup

Deploy to staging with a staging DSN/`APP_ENV=staging`, then trigger a test event from a Node REPL on the VM or temporarily throw in a non-production route. Confirm the event shows release = the deployed SHA, no cookies/headers/query strings, and no email addresses. Do not test against the production project.
