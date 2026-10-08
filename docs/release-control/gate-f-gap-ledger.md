# Gate F Production Release Gap Ledger: OPS-001 Through OPS-018

**Document Version:** 1.0.0  
**Status:** ACTIVE AUDIT LEDGER  
**Assurance Profile:** `automated-only-owner-waived-v2` (ADR 0005)  
**Target Release:** MATCHDAY Singapore Launch (Phase 8 Gate F)  
**Evaluation Commit:** `3bbe7cc59dba2eb77808e6a04e0ffefc8ccccc1a` (PR #66 merged to main; live certification pending)  
**Governance Scope:** Operations, Infrastructure, Deployment, Reliability, and Operational Controls

---

## 1. Executive Summary & Governance Framework

This ledger provides the authoritative requirement gap inventory for all operational readiness criteria governing Gate F production qualification for the MATCHDAY sports tournament management platform.

### 1.1 Assurance Profile & Evidence Truthfulness

Under Architecture Decision Record 0005 (`ADR 0005: Phase 8 Gate F production assurance profile`), MATCHDAY operates under the `automated-only-owner-waived-v2` framework:

1. **Mandatory Automated Rigor:** Every machine-verifiable operational requirement (`OPS-001` through `OPS-018`) must be strictly satisfied and pass automated audit verification without exception.
2. **Strict Truthfulness Invariant:** Human-only and physical-device verifications cannot be performed by automated processes and must never be fabricated as passed. They are explicitly recorded as `WAIVED_NOT_EXECUTED`.
3. **Commercial Legal Deferral:** Formal authorised legal and external privacy counsel review is recorded as `DEFERRED_TO_FIRST_COMMERCIAL_RELEASE`. All substantive technical privacy features, terms, data export, and account deletion capabilities are fully implemented and verified.
4. **Candidate SHA Binding:** All verification receipts, Docker images, and deployed instances must bind strictly to the exact 40-character hexadecimal commit SHA.
5. **Zero Production Mutations:** All development and validation activities are strictly prohibited from mutating live production infrastructure (no SSH access, no container recreation, no Caddy reload, no database migration against live instances).

---

## 2. Requirement Status Matrix (OPS-001 to OPS-018)

| ID          | Priority | Requirement Name                      | Source Implementation | Operational Evidence          | Gate F Status            | Active Blocker ID |
| ----------- | -------- | ------------------------------------- | --------------------- | ----------------------------- | ------------------------ | ----------------- |
| **OPS-001** | P0       | Deployment Pipeline                   | `SOURCE_COMPLETE`     | `PRODUCTION_EVIDENCE_PENDING` | Ready for Prod Run       | BLK-11            |
| **OPS-002** | P0       | Zero-Downtime Deployment & Rollback   | `SOURCE_COMPLETE`     | `PRODUCTION_EVIDENCE_PENDING` | Blocked by Mount         | BLK-01            |
| **OPS-003** | P0       | Database Migration Safety             | `SOURCE_COMPLETE`     | `VERIFIED_IN_AUTOMATION`      | PASS                     | None              |
| **OPS-004** | P0       | Monitoring Dashboards & Metrics       | `SOURCE_COMPLETE`     | `PRODUCTION_EVIDENCE_PENDING` | Pending Prod Telemetry   | BLK-04            |
| **OPS-005** | P0       | Alerting Rules & Routing              | `SOURCE_COMPLETE`     | `EXTERNAL_PROVIDER_PENDING`   | Pending Alert Drill      | BLK-05            |
| **OPS-006** | P0       | External Status Page                  | `SOURCE_MISSING`      | `EXTERNAL_PROVIDER_PENDING`   | Missing Setup            | BLK-05            |
| **OPS-007** | P0       | Log Aggregation & 90-Day Retention    | `SOURCE_PARTIAL`      | `PRODUCTION_EVIDENCE_PENDING` | Partial (Daemon missing) | BLK-04            |
| **OPS-008** | P0       | Synthetic Health Monitoring           | `SOURCE_COMPLETE`     | `PRODUCTION_EVIDENCE_PENDING` | Pending Probe Run        | BLK-04            |
| **OPS-009** | P0       | CDN Edge Caching & Purge-on-Publish   | `SOURCE_COMPLETE`     | `EXTERNAL_PROVIDER_PENDING`   | Pending CDN Purge        | BLK-06            |
| **OPS-010** | P0       | Database Read Replica / Topology      | `SOURCE_COMPLETE`     | `VERIFIED_IN_AUTOMATION`      | PASS (ADR 0001)          | None              |
| **OPS-011** | P0       | Automated Backup Schedule             | `SOURCE_COMPLETE`     | `PRODUCTION_EVIDENCE_PENDING` | Pending Prod Backup      | BLK-03            |
| **OPS-012** | P0       | Disaster Recovery & Restoration       | `SOURCE_COMPLETE`     | `PRODUCTION_EVIDENCE_PENDING` | Pending Prod DR Run      | BLK-03            |
| **OPS-013** | P0       | Auto-Scaling / Vertical Topology      | `SOURCE_COMPLETE`     | `VERIFIED_IN_AUTOMATION`      | PASS (Fixed Topology)    | None              |
| **OPS-014** | P0       | SSL / TLS Certificate Auto-Renewal    | `SOURCE_COMPLETE`     | `PRODUCTION_EVIDENCE_PENDING` | Pending Live TLS Probe   | BLK-09            |
| **OPS-015** | P0       | Deployment Freeze Policy              | `SOURCE_COMPLETE`     | `PRODUCTION_EVIDENCE_PENDING` | Merged; Prod Pending     | None              |
| **OPS-016** | P1       | Cloud Cost Monitoring & Controls      | `SOURCE_COMPLETE`     | `EXTERNAL_PROVIDER_PENDING`   | Pending Budget Receipt   | BLK-08            |
| **OPS-017** | P0       | Email Infrastructure & Bounce Webhook | `SOURCE_PARTIAL`      | `PRODUCTION_EVIDENCE_PENDING` | Pending Webhook Config   | BLK-10            |
| **OPS-018** | P0       | Feature Flag Administration           | `SOURCE_COMPLETE`     | `PRODUCTION_EVIDENCE_PENDING` | UI Merged; Audit Pending | BLK-07            |

---

## 3. Comprehensive Requirement Analysis & Gap Inventory

### OPS-001: Deployment Pipeline

- **Specification:** Automated pipeline ensuring lint, test, build, staging deployment, smoke verification, and production promotion.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Complete CI workflow in `.github/workflows/ci.yml` covering 5 required hosted jobs (`secrets`, `quality-fast`, `integration`, `browser-e2e`, `gate-d-real-e2e`). Production deployment orchestrated by `infra/oci/deploy-prod.sh`.
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. Hosted CI runs green on PR #65 (run 37750848489, 5/5 jobs green). Production pipeline execution receipt on live host pending.
- **Identified Gap:** The production deployment pipeline script `deploy-prod.sh` has not yet been executed for the production release candidate because the live host Caddy mount must first be migrated (see OPS-002 / BLK-01).
- **Remediation Action:** Execute `deploy-prod.sh` during the approved maintenance window once Caddy directory mount migration is complete.

---

### OPS-002: Zero-Downtime Deployment & Health-Gated Rollback

- **Specification:** Blue-green rolling slot deployments across web, api, and worker containers with automated health verification and zero-downtime rollback if health checks fail.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. PR #65 implemented dual-slot orchestration in `infra/oci/deploy-prod.sh` with active slot tracking (`/etc/matchday/active-slot`), preflight mount checks, candidate health polling at `/health/ready`, atomic Caddyfile replacement via `mv -f`, and cleanup/rollback trap handlers. Unit tests in `infra/oci/deploy-prod.test.mjs` pass (19/19 tests).
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. Audited in `scripts/run-gate-f-rollback-drill.mjs`. Evaluates to `PENDING` without live production drill capture.
- **Identified Gap:** The live production Caddy container `matchday-oci-caddy-1` was started prior to PR #65 with a single-file bind mount (`/etc/caddy/Caddyfile`). Docker file bind mounts track the host inode. When `deploy-prod.sh` atomically updates the Caddyfile using `mv -f`, a new inode is created on the host; the Caddy container continues pointing to the stale inode. To prevent broken deployments, `deploy-prod.sh` lines 580–617 enforces a preflight check that blocks execution (`DEPLOYMENT_BLOCKED=YES`, `REASON=LEGACY_OR_INCOMPATIBLE_CADDY_MOUNT`).
- **Remediation Action:** Execute non-executing operator runbook `docs/release-control/caddy-directory-migration-runbook.md` during scheduled maintenance window to migrate Caddy to directory bind mount (`/etc/matchday/caddy:/etc/caddy:ro`). Then capture production rollback drill evidence.

---

### OPS-003: Database Migration Safety (Expand-Contract)

- **Specification:** All SQL schema migrations must adhere to expand-contract methodology: backward-compatible, non-destructive, safe against active replicas, repeatable, and idempotent.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. 67 sequential migrations in `packages/database/migrations/`. Verified by `scripts/certify-gate-f-migrations.mjs`.
- **Operational Evidence:** `VERIFIED_IN_AUTOMATION`. Passes automated audit:
  - Sequence contiguity: 0001 through 0067 unbroken.
  - Zero destructive `DROP TABLE`, `DROP COLUMN`, or `TRUNCATE` operations without safe conditions.
  - Generates `artifacts/gate-f-migration-certification.json` with `verdict: "PASS"`.
- **Identified Gap:** None. Fully satisfied and certified.

---

### OPS-004: Monitoring Dashboards & Metrics

- **Specification:** Core observability capturing API latency, error rates, queue depth, active scoring sessions, and public query performance.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Implemented in `@matchday/observability` package (`packages/observability/src/metrics.ts`, `runtime.ts`). OpenTelemetry collector daemon config declared in `infra/oci/otel-collector.yaml`. Audit routine in `scripts/run-gate-f-ops-audit.mjs` verifies SLO thresholds:
  - Scoring write latency: p95 <= 500ms
  - Public read latency: p95 <= 2500ms
  - Availability: >= 99.9%
  - Error rate: <= 0.1%
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. Without live external probe receipt, `scripts/run-gate-f-ops-audit.mjs` returns `sloBaseline.verdict: "PENDING"`.
- **Identified Gap:** Cloud dashboard provisioning (OCI Monitoring / Grafana) and production telemetry streaming receipt from external monitor are pending deployment.
- **Remediation Action:** Stream metrics to OpenTelemetry collector on production, run external synthetic probes, and capture `artifacts/gate-f-slo-baseline.json`.

---

### OPS-005: Alerting Rules & Routing

- **Specification:** Automated alerting routing critical operational failure conditions to on-call responders with acknowledged receipt drills.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Four core routes defined in `scripts/run-gate-f-ops-audit.mjs`:
  - `service_unavailable` -> PagerDuty / Webhook (S1)
  - `scoring_latency_breach` -> Slack On-Call (S2, p95 > 500ms)
  - `worker_dead` -> Infra Alerts (Crash/fatal exit)
  - `backup_failed` -> Ops Alerts (WAL or daily backup failure)
- **Operational Evidence:** `EXTERNAL_PROVIDER_PENDING`. Requires external alert drill delivery receipt with `all_routes_verified: true` and `delivery_acknowledged: true`.
- **Identified Gap:** Alert notification drill has not yet been triggered and captured against production notification channels.
- **Remediation Action:** Execute alert delivery drill and record provider receipt conforming to `validate-external-evidence.mjs`.

---

### OPS-006: External Status Page

- **Specification:** Independent public platform status page accessible to tournament organisers during platform incidents.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_MISSING`. Repository contains no third-party status page configuration or integration.
- **Operational Evidence:** `EXTERNAL_PROVIDER_PENDING`.
- **Identified Gap:** No hosted status page provider (e.g., Instatus, BetterUptime, Statuspage) has been configured or connected to public DNS `status.matchday.poladex.shop`.
- **Remediation Action:** Provision third-party status page service, configure automated component probes (`API`, `Web`, `Scoring WebSockets`), and publish operator link in `docs/runbooks/incident-response.md`.

---

### OPS-007: Log Aggregation & 90-Day Retention

- **Specification:** Structured JSON logging across all services with recursive PII scrubbing and 90-day retention for operational compliance.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_PARTIAL`.
  - Structured JSON logging: `SOURCE_COMPLETE` (Pino engine in `packages/observability/src/logger.ts`).
  - PII Scrubbing: `SOURCE_COMPLETE` (Recursive redactor in `packages/observability/src/sanitize.ts` redacting tokens, passwords, cookies, email addresses, and auth headers).
  - 90-Day Log Aggregation Daemon: `SOURCE_MISSING`. Docker container log shipping to OCI Logging / external syslog bucket not declared in `infra/oci/compose.prod.yaml`.
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`.
- **Identified Gap:** Log retention relies on default Docker json-file driver on the host without automated retention pruning or off-host sync to 90-day storage.
- **Remediation Action:** Configure Docker log daemon options (`max-size: 50m`, `max-file: 20`) or OCI Logging agent to enforce 90-day retention policy.

---

### OPS-008: Synthetic Health Monitoring

- **Specification:** External continuous probes checking availability and performance across 4 critical endpoints at 30- to 60-second intervals.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Synthetic endpoints verified in `scripts/run-gate-f-ops-audit.mjs`:
  - Homepage (`/`): 60s probe
  - Health Ready (`/health/ready`): 30s probe
  - Build Metadata (`/api/v1/meta/build`): 60s probe
  - Public Competition Read (`/api/v1/competitions/:id`): 60s probe
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. Returns `PENDING` without live external probe receipt.
- **Identified Gap:** Probe definitions are specified in audit tooling, but external monitoring harness (e.g. UptimeRobot, Checkly, or synthetic runner) has not been scheduled against live production origin.
- **Remediation Action:** Enable external probes against `https://matchday.poladex.shop` and capture verification receipt.

---

### OPS-009: CDN Edge Caching & Purge-on-Publish

- **Specification:** Edge CDN caching for static assets and public competition projections with automated cache invalidation upon tournament publication.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Static assets use immutable content hashes (`_next/static/...` with 1-year cache headers). Purge-on-publish API integration implemented in `packages/api/src/services/cache-invalidation.ts`. Verified in `scripts/run-gate-f-cache-purge.mjs`.
- **Operational Evidence:** `EXTERNAL_PROVIDER_PENDING`. Audit script returns `cachePurge.verdict: "PENDING"` without external provider purge receipt.
- **Identified Gap:** Edge CDN (Cloudflare / Fastly) purge webhook test has not been executed against production zone.
- **Remediation Action:** Execute cache purge drill via API and capture provider receipt containing `purge_id` and `timestamp`.

---

### OPS-010: Database Topology & Read Replicas

- **Specification:** Architectural assurance that public query read traffic does not starve live tournament scoring transactions.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Architecture governed by `ADR 0001: Phase 0 Architecture Contracts`. Single primary PostgreSQL instance with aggressive connection pooling, query timeouts, and strict read/write transaction boundaries. Documented and audited by `scripts/certify-gate-f-migrations.mjs` emitting `gate-f-database-topology.json` (`verdict: "PASS"`).
- **Operational Evidence:** `VERIFIED_IN_AUTOMATION`. Compliant with ADR 0001 topology policy.
- **Identified Gap:** None. Fully certified.

---

### OPS-011: Automated Backup Schedule

- **Specification:** Point-in-time recovery with 15-minute WAL archiving, daily full backup, off-host encrypted storage, and 30-day retention.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Backup and WAL archive strategy codified in `docs/operations/BACKUP_RESTORE.md` and automated harness `scripts/verify-backup-restore.sh`.
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. Evaluated by `scripts/run-gate-f-backup-restore-audit.mjs`. Requires production operator capture with 6 distinct physical receipt files.
- **Identified Gap:** Live production database backup capture receipt has not been generated by the human operator.
- **Remediation Action:** Execute production backup on host, verify SHA-256 digest, upload to off-host bucket, and generate `artifacts/production-backup-evidence.json`.

---

### OPS-012: Disaster Recovery & Isolated Restoration

- **Specification:** Tested disaster recovery procedure verifying full database restoration into an isolated disposable target without altering production data.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Test harness `scripts/verify-backup-restore.sh` enforces 6 lifecycle verification phases (`BACKUP_CREATED`, `BACKUP_CHECKSUM_VALID`, `RESTORE_TARGET_ISOLATED`, `RESTORE_COMPLETED`, `DATA_INTEGRITY_VERIFIED`, `PRODUCTION_TARGET_NEVER_MODIFIED`).
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. Verified by `scripts/run-gate-f-backup-restore-audit.mjs`. Fails closed if physical restore receipt is missing or has synthetic markers.
- **Identified Gap:** Live disaster recovery exercise into isolated staging database must be conducted and certified by human operator.
- **Remediation Action:** Conduct isolated restore drill from production backup into temporary database container; verify schema, constraints, and representative reads.

---

### OPS-013: Auto-Scaling & Vertical Topology

- **Specification:** Defined compute capacity management ensuring API and worker resilience under peak tournament load.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Governed by ADR 0001: Dedicated OCI Ampere A1 Flex VM (4 OCPU, 24 GB RAM). Vertical resource limits configured in `infra/oci/compose.prod.yaml`:
  - API: 1.0 CPU, 2.0 GB memory limit
  - Web: 1.0 CPU, 1.5 GB memory limit
  - Worker: 0.5 CPU, 1.0 GB memory limit
  - Postgres: 1.0 CPU, 2.0 GB memory limit
  - Redis: 0.5 CPU, 768 MB memory limit
- **Operational Evidence:** `VERIFIED_IN_AUTOMATION`. Compose resource reservations and load test benchmarks pass.
- **Identified Gap:** None. Fixed vertical topology certified for Singapore tournament launch volume.

---

### OPS-014: SSL / TLS Certificate Auto-Renewal

- **Specification:** Automated TLS 1.3 issuance and renewal with Let's Encrypt / ZeroSSL, HSTS enforcement, and automated HTTP-to-HTTPS redirection.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Caddy web server handles automated ACME certificate management. Configured in `infra/oci/Caddyfile` with HSTS headers (`max-age=31536000; includeSubDomains; preload`). Verified in `scripts/run-gate-f-recertifications.mjs`.
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. Live TLS probe receipt `artifacts/gate-f-dns-tls.json` returns `verdict: "PENDING"` until executed against production domain.
- **Identified Gap:** Live TLS 1.3 handshake verification receipt against `matchday.poladex.shop` is pending deployment.
- **Remediation Action:** Execute external TLS probe against production domain and record receipt.

---

### OPS-015: Deployment Freeze Policy

- **Specification:** Fail-closed authoritative activity checks before forward deployment and immediately before traffic promotion; internal OPS-002 emergency rollback remains available.
- **Priority:** P0 (Critical Deployment Safety Requirement)
- **Source Implementation:** `SOURCE_COMPLETE`. PR #66 was squash-merged to `main` at `3bbe7cc59dba2eb77808e6a04e0ffefc8ccccc1a`. `infra/oci/deploy-prod.sh` invokes the authoritative freeze policy in preflight and pre-promotion phases.
- **Exception Policy:** Forward-deployment overrides fail closed without independently verified notification evidence, scoped expiring authorisation, and replay protection; arbitrary environment rollback flags cannot authorise forward promotion.
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. CI is not proof of a live deployment, freeze drill or rollback receipt.
- **Identified Gap:** BLK-02's source-merge condition is resolved. Live Gate F operational certification remains pending separately authorised operator activity.
- **Remediation Action:** Capture authentic production evidence only under separately approved release procedures.

---

### OPS-016: Cost Monitoring & Controls

- **Specification:** Infrastructure cost tracking across compute, storage, egress, and email with billing alert thresholds.
- **Priority:** P1 (Governance Blocker)
- **Source Implementation:** `SOURCE_COMPLETE`. Five cost categories audited in `scripts/run-gate-f-ops-audit.mjs`:
  - Compute (`compute_a1_flex`)
  - Boot and database storage (`block_storage`)
  - Backups (`object_storage`)
  - Bandwidth (`network_egress`)
  - Email (`transactional_email`)
- **Operational Evidence:** `EXTERNAL_PROVIDER_PENDING`. Audit script returns `costControls.verdict: "PENDING"` without OCI budget alert receipt.
- **Identified Gap:** OCI Cloud Billing budget alert receipt not yet captured in repository artifacts.
- **Remediation Action:** Capture OCI Cost Analysis budget alert screenshot/receipt and record `artifacts/gate-f-cost-controls.json`.

---

### OPS-017: Email Infrastructure & Bounce Handling

- **Specification:** Transactional email delivery via Resend with domain verification (SPF, DKIM, DMARC) and automated bounce processing.
- **Priority:** P0 (Critical Release Blocker)
- **Source Implementation:** `SOURCE_PARTIAL`.
  - Resend client and transactional templates: `SOURCE_COMPLETE`.
  - Durable email delivery outbox: `SOURCE_COMPLETE` (Migration 0067).
  - Bounce webhook receiver: `SOURCE_PARTIAL`. Endpoint route defined, but webhook signature verification and automated participant suppression require production verification.
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. Verified by `scripts/run-gate-f-recertifications.mjs`. Evaluates to `PENDING` without provider domain verification receipt.
- **Identified Gap:** Live DNS SPF/DKIM verification receipt and test bounce webhook delivery receipt pending.
- **Remediation Action:** Complete bounce webhook testing on production and capture `artifacts/gate-f-email.json`.

---

### OPS-018: Feature Flag Administration

- **Specification:** Role-controlled feature-flag administration with safe defaults, audited changes, and UI control without deployment.
- **Priority:** P0 (Operational Control Requirement)
- **Source Implementation:** `SOURCE_COMPLETE` for the web UI and control plane merged in PR #64: `apps/web/app/internal/feature-flags/page.tsx`, `apps/web/components/phase3/FeatureFlagsAdmin.tsx`, `apps/api/src/admin-routes.ts`, and `packages/feature-flags/src/postgres-storage.ts`.
- **Operational Evidence:** `PRODUCTION_EVIDENCE_PENDING`. The original Gate F ops audit hardcoded `admin_ui_present: false` despite the source being present; PR #68 reconciles the audit without certifying live operations.
- **Identified Gap:** Source/UI exist, but exact-head audit reconciliation and live operator/kill-switch evidence remain outstanding.
- **Remediation Action:** Verify PR #68's source receipt and run authorised operational checks before closing BLK-07. File existence is not proof of live UI functionality.

---

## 4. Conclusion and Release Readiness Assessment

1. **Automated Codebase Foundations:** 15 out of 18 requirements are marked `SOURCE_COMPLETE` in this ledger. OPS-003 and OPS-010 have automated source evidence, not live production certification.
2. **Open Implementation Items:**
   - OPS-006 (External Status Page) is missing third-party provider integration.
   - OPS-007 (Log Aggregation Daemon) requires host shipping/retention controls.
   - OPS-017 remains partially verified pending production email and bounce-provider evidence.
   - OPS-018 admin UI is in main; the operations audit and production verification still need completion.
   - OPS-015 is merged to main, but production freeze evidence remains pending.
3. **Production Operation Blockers:**
   - OPS-002 requires executing the Caddy directory mount migration runbook on the live host before any deployment can proceed.
   - Live external evidence receipts (OPS-004, OPS-005, OPS-008, OPS-009, OPS-011, OPS-012, OPS-014, OPS-016, OPS-017) are pending maintenance window execution.
4. **Governance Alignment:** All findings strictly maintain ADR 0005 truthfulness. No receipts are faked, and no production infrastructure was touched during development.
