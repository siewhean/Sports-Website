# Uptime monitoring

**Status:** live. Better Stack monitors, heartbeat and status page were created on 14 October 2026. The alert test in
"Verifying the setup" has not yet been conducted, so CP5 remains open.

The web app and the API share one public host. Caddy (`infra/oci/Caddyfile`) serves `/api/v1/*`, `/health/live`,
`/health/ready` and `/health/version` from the API container and everything else from the web container, so every
monitor targets `https://matchday.poladex.shop`.

## Deployed monitors (Better Stack)

All monitors run every 3 minutes from the US region and alert by email.

| Monitor                            | Type        | URL                                                        | Healthy when                           |
| ---------------------------------- | ----------- | ---------------------------------------------------------- | -------------------------------------- |
| `matchday web`                     | HTTP status | `https://matchday.poladex.shop`                            | HTTP 200                               |
| `matchday api readiness`           | Keyword     | `https://matchday.poladex.shop/health/ready`               | response contains `"status":"healthy"` |
| `matchday public competitions API` | Keyword     | `https://matchday.poladex.shop/api/v1/public/competitions` | response contains `competitions`       |

Why the readiness monitor uses a keyword rather than the status code: `/health/ready` returns HTTP 200 with
`"status":"degraded"` when Redis or the job queue is unavailable (`apps/api/src/app.ts`, the `ready ? "healthy" :
"degraded"` payload). A status-code check would stay green through a Redis outage; the keyword check alerts on it.

`/health/deep` is private (token protected) and must not be monitored from a third party. Do not put tokens or secrets
in monitor URLs, headers or bodies.

## Backup heartbeat

| Heartbeat                 | Period | Grace | Wiring                                                                                         |
| ------------------------- | ------ | ----- | ---------------------------------------------------------------------------------------------- |
| `matchday nightly backup` | 24 h   | 2 h   | `BACKUP_HEARTBEAT_URL` in `infra/oci/.env.prod`, read by `infra/oci/backup/matchday-backup.sh` |

The backup script pings the heartbeat URL on success and `<url>/fail` on failure, so a failed run alerts immediately
and a skipped run alerts after 26 hours.

## Status page

Public status page: <https://matchday-poladex.betteruptime.com>. The site footer links to it when
`NEXT_PUBLIC_STATUS_PAGE_URL` is set to that URL at build time (OCI: `infra/oci/.env.prod`, passed as a Docker build arg;
Vercel: project environment variable). Only `https://` values are linked; otherwise the footer falls back to
`/maintenance`.

## Alerting

- Contacts: currently owner email only. Recommended: add a second contact (SMS / phone call) before launch.
- Alert after 2 consecutive failures (about 6 minutes) to avoid paging on a single blip. During an active competition (see the deployment freeze policy) lower this to 1 failure.
- Enable "recovery" notifications so an outage is closed out in the same thread.

## When an alert fires

1. Open `https://matchday.poladex.shop/health/ready` from a phone on mobile data to rule out the monitor's network.
2. If it is down, follow `docs/runbooks/incident-response.md`. On the VM: `docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps` and `logs --tail=100 api web`.
3. If only the `matchday nightly backup` heartbeat fires, the backup failed: `journalctl -u matchday-backup --since "26 hours ago"` and see `docs/operations/BACKUP_RESTORE.md`. Do not run migrations or deploys until a fresh backup succeeds.

## Verifying the setup

After creating the checks, confirm each by pausing it, then temporarily pointing it at a non-existent path (for example `/health/ready-test`) and verifying that an alert arrives at both contacts. Restore the real URL and note the date of the test below.

Last alert test: _not yet conducted_
