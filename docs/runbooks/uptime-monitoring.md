# Uptime monitoring

**Status:** documentation only. No monitor exists until the owner creates the checks below. Nothing in this repository calls these services.

Free tiers of UptimeRobot (50 monitors, 5-minute interval) or Better Stack (10 monitors, 3-minute interval) are sufficient. Use one provider, or both for independent coverage. Check current free-tier limits on the provider's pricing page before relying on them.

## Checks to create

| #   | Name                                | Type                                         | URL / target                                                                    | Interval                       | Healthy when                                                                         |
| --- | ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | MATCHDAY API ready                  | HTTPS                                        | `https://matchday.poladex.shop/health/ready`                                    | 3-5 min                        | HTTP 200 (the endpoint reflects database and Redis readiness)                        |
| 2   | MATCHDAY public page                | HTTPS keyword                                | `https://matchday.poladex.shop/competitions/<slug>` for a published competition | 5 min                          | HTTP 200 and a keyword that always appears on the page, such as the competition name |
| 3   | MATCHDAY home                       | HTTPS                                        | `https://matchday.poladex.shop/`                                                | 5 min                          | HTTP 200                                                                             |
| 4   | TLS certificate                     | Provider SSL-expiry monitor on the same host | n/a                                                                             | daily                          | more than 14 days remaining                                                          |
| 5   | Nightly backup heartbeat (optional) | Heartbeat / cron monitor                     | URL goes into `BACKUP_HEARTBEAT_URL` in `infra/oci/.env.prod`                   | expected every 24 h, grace 2 h | pinged by the backup job on success; `<url>/fail` on failure                         |

Notes:

- `/health/ready` is the real readiness gate used by `deploy-prod.sh`. `/health/deep` is private (token protected) and must not be monitored from a third party.
- Check 2 proves the web container, the API behind it and Caddy are all serving. Pick a competition that stays published; update the monitor if it is archived.
- Do not put tokens or secrets in monitor URLs, headers or bodies.

## Alerting

- Contacts: at least two, for example the owner's email and an SMS (UptimeRobot SMS and Better Stack phone alerts have free-tier limits, and some regions are paid-only; email is the dependable baseline).
- Alert after 2 consecutive failures (about 6-10 minutes) to avoid paging on a single blip. During an active competition (see the deployment freeze policy) lower this to 1 failure.
- Enable "recovery" notifications so an outage is closed out in the same thread.
- Create a public or private status page only if useful for organisers; it is not required.

## When an alert fires

1. Open `https://matchday.poladex.shop/health/ready` from a phone on mobile data to rule out the monitor's network.
2. If it is down, follow `docs/runbooks/incident-response.md`. On the VM: `docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps` and `logs --tail=100 api web`.
3. If only check 5 fires, the backup failed: `journalctl -u matchday-backup --since "26 hours ago"` and see `docs/operations/BACKUP_RESTORE.md`. Do not run migrations or deploys until a fresh backup succeeds.

## Verifying the setup

After creating the checks, confirm each by pausing it, then temporarily pointing it at a non-existent path (for example `/health/ready-test`) and verifying that an alert arrives at both contacts. Restore the real URL and note the date of the test below.

Last alert test: _not yet conducted_
