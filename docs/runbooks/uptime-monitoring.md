# Uptime monitoring

**Status:** source contracts and setup instructions. No external monitor or status page is certified until exact-release provider evidence is retained. Owner authorization is required for account configuration and alert drills. See [provider setup and verification](observability-provider-verification.md) and ADR 0005.

## Required probes

| Name                    | Target                                                    | Maximum interval | Timeout   | Healthy result                                    |
| ----------------------- | --------------------------------------------------------- | ---------------- | --------- | ------------------------------------------------- |
| homepage                | `${PRODUCTION_ORIGIN}/`                                   | 60 seconds       | 5 seconds | HTTP 200                                          |
| health_ready            | `${PRODUCTION_ORIGIN}/health/ready`                       | 30 seconds       | 3 seconds | HTTP 200; database and Redis ready                |
| meta_build              | `${PRODUCTION_ORIGIN}/api/v1/meta/build`                  | 60 seconds       | 5 seconds | HTTP 200 and expected exact deployed SHA          |
| public_competition_read | `${PRODUCTION_ORIGIN}/api/v1/competitions/<published-id>` | 60 seconds       | 5 seconds | HTTP 200 and expected public competition identity |

Use the approved production origin from `scripts/lib/hostnames.mjs` and actual public competition ID. Do not expose `/health/deep` tokens or put credentials in monitor URLs. An organiser-facing published web page, daily TLS expiry check (more than 14 days remaining) and nightly backup success heartbeat can supplement the four required probes.

A provider's 3–5-minute free polling tier does not meet OPS-008's 30/60-second requirements. The owner must select a plan that meets the contract and approve any cost. Do not weaken intervals to certify a free tier.

## Alerting and public status

Configure service-unavailable, scoring-latency breach (>500ms p95), dead-worker and backup-failed routes with named on-call owners. Agree threshold windows and delivery contacts in the provider before the authorized drill. During an active competition, account for the deployment freeze and avoid disruptive tests. Verify both failure and recovery delivery; retain provider delivery IDs and acknowledgements, not only configuration screenshots.

OPS-006 requires an independent public status page and component/incident history. Host it outside the primary application infrastructure and verify accessibility while the origin is unavailable. The application readiness endpoint alone does not establish an independent status page.

## Incident response

Check the readiness endpoint from an independent network, compare the exact build SHA, and follow [incident response](incident-response.md). Operator access and any recovery/migration/restart remain separately authorized. A backup-heartbeat incident requires the [backup runbook](../operations/BACKUP_RESTORE.md); do not infer success from a timer definition.

## Verification receipts

Record external provider monitor IDs, observed intervals, target/path, HTTP results, UTC observation window and the actual serving SHA. Retain redacted provider exports with SHA-256 digests and operator identity. Submit a separate synthetic receipt: passing aggregate SLO numbers do not prove the required monitors exist. Never deliberately break a production URL or send a real test alert without authorization.

Last external monitoring/status verification: **not independently verified by this source change**.
Last authorized alert drill: **not executed by this source change**.
