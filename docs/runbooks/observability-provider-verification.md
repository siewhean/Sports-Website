# Observability provider setup and verification

Source review is not evidence of delivery. All external setup below requires separate owner authorization. Do not enable telemetry, change provider settings, send test alerts, restart services or edit production secrets during source certification. ADR 0005 keeps machine-verifiable OPS requirements mandatory. No paid subscription is authorized by this runbook.

| Requirement | Available source                                                                          | Remaining operator/provider proof                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPS-004     | Instance-bound API/worker OTLP runtime, collector traces/metrics, scrubbed Sentry adapter | Dashboard capture of API latency/errors, queue depth, active scoring sessions and public reads on exact release; SLO observation window and propagation latency |
| OPS-005     | Incident severity/routing contracts and receipt validator                                 | All four configured alert rules, actual recipient routes and acknowledged delivery captures; errors-only Sentry event receipt                                   |
| OPS-006     | Status page acceptance requirements                                                       | Independently hosted public status page, component health linkage and public incident history; accessible during origin outage                                  |
| OPS-007     | Structured NDJSON/Pino and credential/PII scrubbing                                       | Host log shipping, restricted provider access, 90-day retention lifecycle and expiry evidence; current collector has no logs pipeline                           |
| OPS-008     | Readiness/public endpoint and 30/60-second probe contracts                                | External monitors covering all four targets at required intervals, provider monitor IDs and successful observations                                             |
| OPS-016     | Cost category and budget/anomaly contracts                                                | OCI budget subscriptions and anomaly detection plus compute, block/object storage, egress and transactional-email captures                                      |
| OPS-018     | Privileged feature flag UI/API, PostgreSQL overrides and audit logging                    | Authorized operator access, unauthorized access denied, safe test-flag toggle and audit receipt on exact production release                                     |

## Setup requiring owner approval

1. **Sentry:** select the project, region, data access and retention. Put server `SENTRY_DSN` and browser `NEXT_PUBLIC_SENTRY_DSN` in the approved secret/configuration stores. The browser DSN is public configuration; never embed server auth tokens. Browser configuration is build-bound and requires a separately authorized exact-SHA web release. Sentry tracing is disabled and the application retains its own OTEL providers. Capture one authorized benign test error per API/worker/web surface, provider event IDs, service/environment/release tags, and scrubbed payloads. Never include a scorer token, email address, HMAC material or request body. No receipt exists merely because a DSN is populated.
2. **OTEL:** approve the provider endpoint, ingestion cost and limits. Use exact internal `http://otel-collector:4318` application endpoint; provider endpoint must be HTTPS with verified TLS. Authentication stays in the collector's mounted bearer-token secret. Keep application `OTEL_EXPORTER_OTLP_HEADERS`, `_TRACES_HEADERS` and `_METRICS_HEADERS` absent/empty; populated values fail preflight/runtime. Enable the observability compose profile only during an authorized rollout. Verify live HTTP, scoring HMAC and worker metrics in the provider plus dashboard coverage. SDK fake-exporter tests establish source behavior only.
3. **External uptime/status:** use a provider independent of OCI/application hosting; configure the targets in the uptime runbook with required intervals. Provision a public status page and incident communication ownership. Record provider monitor IDs, routing and component sync. An origin `/health` page cannot serve as the independent status page.
4. **Incident routes:** approve on-call ownership and two reachable contacts. Configure service-unavailable, scoring-latency, dead-worker and failed-backup rules. Agree a safe alert drill window; send no test notifications until authorized. Retain delivery and acknowledgement IDs for every route, plus recovery notification proof.
5. **Logs:** choose host shipper/provider, restricted access and 90-day retention. Review scrub rules before forwarding. Retain shipper config capture, successful redacted ingestion, policy ID and retention expiry behavior. Do not substitute local Docker log rotation for centralized 90-day retention.
6. **Costs:** in OCI billing/budgets, approve currency, monthly limits, actual/forecast thresholds and notification subscription. Include storage and egress; separately approve email quota/budget monitoring. Capture billing-account references and all five categories, budget delivery and anomaly configuration. No numeric budget is invented here.
7. **Feature flags:** operator captures require production authorization. Use a reversible designated test flag; do not toggle privileged access/billing or active event behavior. Verify privileged access, unauthorized denial, persisted override and audited reversal. Source-path detection stays PENDING until this proof is supplied.

Provider cost depends on region, ingestion volume, retention, polling interval and contacts. Confirm current provider quotation before accepting a plan. Free polling at several minutes does not satisfy the required 30/60 seconds. Setup can proceed in parallel after approval; DSN/browser build and compose changes require a controlled rollout, with possible service restart and separately prepared rollback. Provider-only status/budget setup normally does not require application downtime.

## Read-only operator preflight

Run only in an authorized environment; do not print secret values or full environment files. From repository root, validate a protected production configuration using the existing validator's documented file option. Review collector configuration and mounted secret existence/permissions without printing its contents. Capture exact release identity from the public endpoints:

```sh
curl --fail --silent --show-error "$PRODUCTION_ORIGIN/health/ready"
curl --fail --silent --show-error "$PRODUCTION_ORIGIN/api/v1/meta/build"
curl --fail --silent --show-error "$PRODUCTION_ORIGIN/api/v1/competitions/$PUBLIC_COMPETITION_ID"
```

A single curl does not prove external synthetic polling, SLO windows, alert delivery or provider retention. Record UTC observation window, exact deployed SHA, provider capture and operator identity. Do not use a localhost/test/simulation receipt as production proof.

## Audit receipt inputs

For OPS-004/005/008/016 the source audit accepts `sloEvidenceFile`, `alertEvidenceFile`, `syntheticEvidenceFile`, `costEvidenceFile` through `runGateFOpsAudit(candidateSha, options)`. Every receipt needs the exact 40-character `candidate_sha`, a production environment/host, UTC capture within 24 hours, accepted evidence class and distinct hashed `evidence_files` including `kind: provider_capture`. Capture files contain redacted provider observations, never credentials.

- Dashboard: `dashboard_id`, all five `observed_metrics` (`api_latency`, `error_rate`, `queue_depth`, `active_scoring_sessions`, `public_reads`), `availability_observed_percent` >=99.9 and <=100, nonnegative `scoring_p95_observed_ms` <=500, `public_read_p95_observed_ms` <=2500 and `result_propagation_observed_ms` <=2000. Require positive integer `observation_sample_count` and UTC `observation_window.started_at/completed_at` with start before end and end not in the future.
- Alerts: `alert_drill_id`, `all_routes_verified`, `delivery_acknowledged`, and `routes` containing each of the four conditions with acknowledged delivery and `receipt_id`.
- Synthetic: `probes` covering each named target, `external: true`, HTTP `status: 200`, positive `interval_sec` <= required interval and `provider_monitor_id`. Retain `target_url` on the approved production origin and expected path, receipt-level `serving_sha`, meta-build `observed_candidate_sha`, and public probe `observed_competition_id` matching receipt-level `public_competition_id`. Dashboard evidence alone cannot verify these monitors.
- Costs: `billing_account_id`, `budget_alerts_configured`, `anomaly_detection_active` and all five `monitored_categories`.

OPS-006/007/018 remain pending manual/operator evidence review; source audit does not auto-certify them. No CLI audit may return success while mandatory operations remain pending. Production-source evidence references must not be fabricated from unit-test fixtures.

Recertification of automated security/accessibility/privacy needs a separately retained exact-SHA `HOSTED_CI` or `LOCAL_EXECUTABLE` receipt (`automatedEvidenceFile`) with a distinct hashed `test_log`. Its `checks` must contain PASS entries for security dependency audit/secret scan/headers, accessibility axe/reduced motion/high contrast, and privacy policies/terms/cookies/retention/export/deletion. This establishes only automated source scope; independent defect counts remain unknown until review. Human-only checks stay `WAIVED_NOT_EXECUTED` and legal approval stays `DEFERRED_TO_FIRST_COMMERCIAL_RELEASE`.
