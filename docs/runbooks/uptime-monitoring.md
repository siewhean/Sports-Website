# Uptime monitoring

**Status:** documentation only. No monitor exists until the owner creates the checks below. Nothing in this repository calls these services.

Free tiers of Better Stack (10 monitors, 3-minute interval) or UptimeRobot (50 monitors, 5-minute interval) provide proactive alerting. Better Stack is recommended as it natively integrates uptime monitors, heartbeat monitors, and hosted status pages.

## Checks to create (Better Stack / UptimeRobot)

| #   | Name                             | Type                                         | URL / target                                                                    | Interval                       | Healthy when                                                                         |
| --- | -------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | MATCHDAY API ready               | HTTPS                                        | `https://matchday.poladex.shop/health/ready`                                    | 3 min                          | HTTP 200 (reflects database, migration state and Redis readiness)                    |
| 2   | MATCHDAY public competition page | HTTPS keyword                                | `https://matchday.poladex.shop/competitions/<slug>` for a published competition | 3-5 min                        | HTTP 200 and a keyword that always appears on the page, such as the competition name |
| 3   | MATCHDAY home                    | HTTPS                                        | `https://matchday.poladex.shop/`                                                | 3-5 min                        | HTTP 200                                                                             |
| 4   | TLS certificate                  | Provider SSL-expiry monitor on the same host | n/a                                                                             | daily                          | more than 14 days remaining                                                          |
| 5   | Nightly backup heartbeat         | Heartbeat / cron monitor (Better Stack)      | Heartbeat URL configured in `BACKUP_HEARTBEAT_URL` in `infra/oci/.env.prod`     | expected every 24 h, grace 2 h | pinged by `matchday-backup.sh` on success; `<url>/fail` on failure                   |

Notes:

- `/health/ready` is the real readiness gate used by `deploy-prod.sh`. `/health/deep` is private (token protected) and must not be monitored from a third party.
- Check 2 proves the web container, the API behind it and Caddy are all serving. Pick a competition that stays published; update the monitor if it is archived.
- Do not put tokens or secrets in monitor URLs, headers or bodies.

## Status Page (Better Stack)

Better Stack includes a free hosted public status page:

1. In Better Stack, go to **Status Pages** > **Create Status Page**.
2. Name: `Matchday Status` (subdomain e.g. `matchday.betteruptime.com` or custom domain `status.matchday.sport`).
3. Add resources: connect Check 1 (API), Check 2 (Public Results), and Check 3 (Web Homepage).
4. Configure in the web app: set `NEXT_PUBLIC_STATUS_PAGE_URL=https://status.matchday.sport` (or your Better Stack status page URL) in Vercel and OCI environment configs. The site footer automatically links to this status page with secure external link attributes.

## Alerting

- Contacts: at least two, for example the owner's email and SMS / phone call alerts.
- Alert after 2 consecutive failures (about 6-10 minutes) to avoid paging on a single blip. During an active competition (see the deployment freeze policy) lower this to 1 failure.
- Enable "recovery" notifications so an outage is closed out in the same thread.

## When an alert fires

1. Open `https://matchday.poladex.shop/health/ready` from a phone on mobile data to rule out the monitor's network.
2. If it is down, follow `docs/runbooks/incident-response.md`. On the VM: `docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps` and `logs --tail=100 api web`.
3. If only check 5 fires, the backup failed: `journalctl -u matchday-backup --since "26 hours ago"` and see `docs/operations/BACKUP_RESTORE.md`. Do not run migrations or deploys until a fresh backup succeeds.

## Verifying the setup

After creating the checks, confirm each by pausing it, then temporarily pointing it at a non-existent path (for example `/health/ready-test`) and verifying that an alert arrives at both contacts. Restore the real URL and note the date of the test below.

Last alert test: _not yet conducted_
