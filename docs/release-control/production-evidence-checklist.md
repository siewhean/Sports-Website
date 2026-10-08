# Gate F Production Evidence Checklist and Validation Schemas

**Document Version:** 1.0.0  
**Status:** AUTHORITATIVE COMPLIANCE SPECIFICATION  
**Assurance Profile:** `automated-only-owner-waived-v2` (ADR 0005)  
**Target Release:** MATCHDAY Singapore Launch (Phase 8 Gate F)  
**Enforcement Tooling:** `scripts/validate-gate-f.mjs`, `scripts/validate-external-evidence.mjs`

---

## 1. Overview & Integrity Rules

Under ADR 0005, Gate F certification represents the formal release gate certifying that MATCHDAY is operationally safe, resilient, performant, and compliant for live Singapore tournament operations.

### 1.1 Strict Anti-Fabrication Invariants

To maintain absolute evidence truthfulness, the validation system (`scripts/validate-gate-f.mjs` and `scripts/validate-external-evidence.mjs`) enforces:

1. **Zero Synthetic / Simulated Markers:** Any occurrence of `"synthetic": true`, `"simulated": true`, or environment `"simulation"` / `"staging"` / `"local"` in a production evidence payload results in immediate hard failure.
2. **Strict Candidate SHA Binding:** Every receipt, test record, and deployment manifest must explicitly match the 40-character hexadecimal candidate SHA (`^[0-9a-f]{40}$`).
3. **Freshness Window (<= 24 Hours):** All production evidence timestamps (`observed_at`, `captured_at`, `generated_at`) must be valid UTC ISO 8601 strings generated within 24 hours of the certification run.
4. **Physical File Distinctness:** Evidence bundles referencing physical files (e.g., backup archives, receipts, logs) must resolve to unique physical files on disk. Symlinks, hardlinks, and self-referential paths are detected and rejected via filesystem `dev:ino` inode checks.
5. **Deterministic Checksum Validation:** Every referenced physical file must have its SHA-256 digest independently computed and verified against the declared payload hash.
6. **Waiver & Deferral Invariants:** Human waivers must strictly declare `WAIVED_NOT_EXECUTED`, and commercial legal approval must strictly declare `DEFERRED_TO_FIRST_COMMERCIAL_RELEASE`.

---

## 2. Master Checklist of the 16 Required Evidence Artifacts

| #      | Artifact Relative Path                                   | Requirement ID      | Evidence Class          | Validation Script                      | Current Status             |
| ------ | -------------------------------------------------------- | ------------------- | ----------------------- | -------------------------------------- | -------------------------- |
| **01** | `artifacts/gate-f-certification.json`                    | Gate F Master Gate  | `LOCAL_EXECUTABLE`      | `validate-gate-f.mjs`                  | Pending Prod Run           |
| **02** | `artifacts/gate-f-production-simulation.json`            | Simulation Baseline | `LOCAL_EXECUTABLE`      | `run-gate-f-production-simulation.mjs` | Simulation Only (Test)     |
| **03** | `artifacts/gate-f-backup-restore.json`                   | OPS-011, OPS-012    | `OPERATOR_CAPTURE`      | `run-gate-f-backup-restore-audit.mjs`  | Pending Operator Capture   |
| **04** | `artifacts/production-backup-evidence.json` + 6 receipts | OPS-011, OPS-012    | `OPERATOR_CAPTURE`      | `run-gate-f-backup-restore-audit.mjs`  | Pending Operator Capture   |
| **05** | `artifacts/gate-f-slo-baseline.json`                     | OPS-004, OPS-008    | `PRODUCTION_LIVE_PROBE` | `run-gate-f-ops-audit.mjs`             | Pending Live Probe         |
| **06** | `artifacts/gate-f-alert-routing.json`                    | OPS-005             | `PROVIDER_RECEIPT`      | `run-gate-f-ops-audit.mjs`             | Pending Drill Receipt      |
| **07** | `artifacts/gate-f-cost-controls.json`                    | OPS-016             | `PROVIDER_RECEIPT`      | `run-gate-f-ops-audit.mjs`             | Pending Budget Receipt     |
| **08** | `artifacts/gate-f-dns-tls.json`                          | OPS-014             | `PRODUCTION_LIVE_PROBE` | `run-gate-f-recertifications.mjs`      | Pending Live Probe         |
| **09** | `artifacts/gate-f-seo.json`                              | GATE-F-SEO          | `PRODUCTION_LIVE_PROBE` | `run-gate-f-recertifications.mjs`      | Pending Live Probe         |
| **10** | `artifacts/gate-f-email.json`                            | OPS-017             | `PROVIDER_RECEIPT`      | `run-gate-f-recertifications.mjs`      | Pending DNS/Webhook        |
| **11** | `artifacts/gate-f-cache-purge.json`                      | OPS-009             | `PROVIDER_RECEIPT`      | `run-gate-f-cache-purge.mjs`           | Pending Purge Run          |
| **12** | `artifacts/gate-f-rollback-drill.json`                   | OPS-002             | `OPERATOR_CAPTURE`      | `run-gate-f-rollback-drill.mjs`        | Pending Rollback Run       |
| **13** | `artifacts/gate-f-migration-certification.json`          | OPS-003             | `SOURCE_STATIC`         | `certify-gate-f-migrations.mjs`        | **PASS (Certified)**       |
| **14** | `artifacts/gate-f-security.json`                         | GATE-F-SECURITY     | `HOSTED_CI`             | `run-gate-f-recertifications.mjs`      | **PASS_AUTOMATED_SCOPE**   |
| **15** | `artifacts/gate-f-accessibility.json`                    | GATE-F-A11Y         | `HOSTED_CI`             | `run-gate-f-recertifications.mjs`      | **PASS_AUTOMATED_SCOPE**   |
| **16** | `artifacts/gate-f-legal-technical.json`                  | GATE-F-LEGAL        | `SOURCE_STATIC`         | `run-gate-f-recertifications.mjs`      | **PASS_TECHNICAL_PACKAGE** |

---

## 3. Detailed Artifact Specifications & Schemas

### Artifact 01: `artifacts/gate-f-certification.json`

- **Purpose:** Authoritative Gate F certification seal consumed by `scripts/validate-gate-f.mjs`.
- **Schema Version:** `2026.09.gate-f-production`
- **Assurance Profile:** `automated-only-owner-waived-v2`
- **Required Fields:**
  - `candidate_sha`: Exact 40-character commit SHA.
  - `production_deployment`:
    - `hostname`: `"matchday.poladex.shop"`
    - `deployed_sha`: Must match `candidate_sha`.
    - `environment`: `"production"`
    - `conclusion`: `"PASS"`
  - `hosted_ci`:
    - `head_sha`: Must match `candidate_sha`.
    - `conclusion`: `"PASS"`
    - `jobs`: Exactly 5 jobs (`secrets`, `quality-fast`, `integration`, `browser-e2e`, `gate-d-real-e2e`), each `"PASS"`.
  - `backup_restore`:
    - `conclusion`: `"PASS"`
    - `production_operator_review`: `"PASS"`
    - `evidence_reference`: Relative path to `production-backup-evidence.json`.
    - `evidence_sha256`: SHA-256 digest of `production-backup-evidence.json`.
  - `human_waivers`:
    - Exactly 5 keys: `independent_manual_pentest`, `independent_gate_f_reviewer`, `physical_device_matrix_session`, `human_screen_reader_audit`, `live_organiser_pilot_observation`.
    - Every key must strictly have value `"WAIVED_NOT_EXECUTED"`.
  - `legal_approval`: Strictly `"DEFERRED_TO_FIRST_COMMERCIAL_RELEASE"`.

---

### Artifact 02: `artifacts/gate-f-production-simulation.json`

- **Purpose:** Aggregate output of all 6 local simulation audits.
- **Generator:** `scripts/run-gate-f-production-simulation.mjs`
- **Schema Fields:**
  - `qa_item`: `"GATE-F-PRODUCTION-SIMULATION"`
  - `candidate_sha`: 40-character SHA.
  - `verdict`: `"PASS"` (required for final certification; currently evaluates to `"PENDING"` in development).
  - `receipt_sha256`: SHA-256 digest of payload.
  - `components`: Object summarizing outcomes across all 14 evaluated areas.
  - Invariant: When certifying production, cannot contain `production_certification: false`.

---

### Artifact 03: `artifacts/gate-f-backup-restore.json`

- **Purpose:** Audit receipt verifying that production backup and isolated restoration passed all verification checks.
- **Generator:** `scripts/run-gate-f-backup-restore-audit.mjs`
- **Schema Fields:**
  - `qa_item`: `"OPS-011"`
  - `candidate_sha`: 40-character SHA.
  - `evidence_scope`: `"production_backup_and_isolated_restore"`
  - `verdict`: `"PASS"`
  - `evidence_reference`: Path to input evidence JSON.
  - `input_evidence_sha256`: SHA-256 digest matching input file.
  - `receipt_sha256`: SHA-256 digest over receipt body.
  - `generated_at`: Valid ISO 8601 UTC timestamp <= 24h old.

---

### Artifact 04: Production Operator Backup Capture (`production-backup-evidence.json` + 6 receipts)

- **Purpose:** Evidence bundle captured on live production host by human operator following `docs/operations/BACKUP_RESTORE.md`.
- **Schema Version:** `production-backup-v1`
- **Evidence Class:** `production_operator_capture`
- **Required Payload Structure:**
  - `candidate_sha`: 40-character SHA.
  - `source`:
    - `environment`: `"production"`
    - `database_id`: `"matchday-prod-postgres"`
    - `host_id`: Production host identifier (non-loopback).
    - `deployed_sha`: Matching candidate SHA.
    - `observed_at`: Timestamp <= 24h old.
  - `backup`:
    - `id`: Unique backup run ID.
    - `size_bytes`: Integer > 0.
    - `sha256`: SHA-256 digest of backup dump.
    - `format`: `"custom"` (pg_dump -Fc).
    - `postgresql_version`: `"18.4"`
    - `storage`: `class: "oci_object_storage"`, `off_host: true`, `encrypted: true`, `retention_days: 30`.
  - `restore`:
    - `isolated`: `true`
    - `environment`: `"isolated_restore"`
    - `database_id`: Target database name (must differ from source).
    - `checksum_verified`: `true`
    - `integrity`: Keys for `restore_completed`, `migration_ledger`, `schema`, `constraints`, `representative_reads`, `application_schema_compatible` all `"PASS"`.
  - `evidence_files`: Array of exactly 6 distinct physical files with distinct inode identities:
    1. `backup_artifact` (dump file)
    2. `storage` (cloud storage upload confirmation)
    3. `restore` (pg_restore stdout log)
    4. `integrity` (verification query outputs)
    5. `authorization` (signed operator runbook authorization)
    6. `recovery` (RTO/RPO calculation log)

---

### Artifact 05: `artifacts/gate-f-slo-baseline.json`

- **Purpose:** Verifies operational SLO metrics for production traffic.
- **Generator:** `scripts/run-gate-f-ops-audit.mjs`
- **Required Thresholds:**
  - `score_write_p95_ms`: <= 500 ms
  - `public_read_p95_ms`: <= 2500 ms
  - `availability_percentage`: >= 99.9%
  - `error_rate_percentage`: <= 0.1%
- **Evidence Class:** `PRODUCTION_LIVE_PROBE`

---

### Artifact 06: `artifacts/gate-f-alert-routing.json`

- **Purpose:** Confirms automated alerting delivery across all 4 operational routing channels.
- **Generator:** `scripts/run-gate-f-ops-audit.mjs`
- **Verified Routes:**
  - `service_unavailable` -> PagerDuty / Webhook
  - `scoring_latency_breach` -> On-Call Slack
  - `worker_dead` -> Infra Alerts
  - `backup_failed` -> Ops Alerts
- **Required Payload:** `all_routes_verified: true`, `delivery_acknowledged: true`, `alert_drill_id`.

---

### Artifact 07: `artifacts/gate-f-cost-controls.json`

- **Purpose:** Audits cost categories and budget alerting thresholds.
- **Generator:** `scripts/run-gate-f-ops-audit.mjs`
- **Categories Monitored:** `compute_a1_flex`, `block_storage`, `object_storage`, `network_egress`, `transactional_email`.
- **Required Payload:** `budget_alert_active: true`, `anomaly_detection_enabled: true`, `provider_budget_receipt_id`.

---

### Artifact 08: `artifacts/gate-f-dns-tls.json`

- **Purpose:** Live probe verifying TLS 1.3 encryption and HSTS headers.
- **Generator:** `scripts/run-gate-f-recertifications.mjs`
- **Required Verification:**
  - Target: `https://matchday.poladex.shop`
  - TLS Protocol: `TLSv1.3`
  - Certificate Issuer: Let's Encrypt or ZeroSSL
  - HTTP Redirect: `http://matchday.poladex.shop` redirects with 301/308 to `https://`
  - HSTS Header: Contains `max-age=31536000; includeSubDomains`.

---

### Artifact 09: `artifacts/gate-f-seo.json`

- **Purpose:** Origin probe checking search engine crawlers and public discovery assets.
- **Generator:** `scripts/run-gate-f-recertifications.mjs`
- **Verified Endpoints:**
  - `/robots.txt`: Returns HTTP 200, contains valid sitemap directive.
  - `/sitemap.xml`: Returns HTTP 200, valid XML sitemap.

---

### Artifact 10: `artifacts/gate-f-email.json`

- **Purpose:** Verifies transactional email domain authentication and bounce tracking.
- **Generator:** `scripts/run-gate-f-recertifications.mjs`
- **Verified Parameters:**
  - Domain verification: SPF (`v=spf1 include:resend.com ~all`), DKIM, DMARC (`v=DMARC1; p=reject`).
  - Webhook: Automated processing of bounce and complaint events.

---

### Artifact 11: `artifacts/gate-f-cache-purge.json`

- **Purpose:** Edge CDN invalidation receipt upon tournament publication.
- **Generator:** `scripts/run-gate-f-cache-purge.mjs`
- **Required Payload:** `purge_scope`, `surrogate_keys`, `provider_receipt_id`, `latency_ms <= 1000`.

---

### Artifact 12: `artifacts/gate-f-rollback-drill.json`

- **Purpose:** Automated zero-downtime rollback drill verification.
- **Generator:** `scripts/run-gate-f-rollback-drill.mjs`
- **Required Payload:** Confirms rollback from candidate back to stable active slot without dropping live scoring connections.

---

### Artifact 13: `artifacts/gate-f-migration-certification.json`

- **Purpose:** SQL migration ledger safety certification.
- **Generator:** `scripts/certify-gate-f-migrations.mjs`
- **Current Status:** Certified `PASS`. Confirms 67 contiguous migrations without destructive SQL statements.

---

### Artifact 14: `artifacts/gate-f-security.json`

- **Purpose:** Recertification of automated security controls.
- **Generator:** `scripts/run-gate-f-recertifications.mjs`
- **Current Status:** Certified `PASS_AUTOMATED_SCOPE`.
- **Waiver:** `independent_manual_pentest: "WAIVED_NOT_EXECUTED"`.

---

### Artifact 15: `artifacts/gate-f-accessibility.json`

- **Purpose:** Recertification of automated WCAG 2.1 AA accessibility controls.
- **Generator:** `scripts/run-gate-f-recertifications.mjs`
- **Current Status:** Certified `PASS_AUTOMATED_SCOPE`.
- **Waivers:** `human_screen_reader_audit: "WAIVED_NOT_EXECUTED"`, `physical_device_matrix_session: "WAIVED_NOT_EXECUTED"`.

---

### Artifact 16: `artifacts/gate-f-legal-technical.json`

- **Purpose:** Recertification of automated privacy, data export, and account deletion technical capabilities.
- **Generator:** `scripts/run-gate-f-recertifications.mjs`
- **Current Status:** Certified `PASS_TECHNICAL_PACKAGE_WITH_DEFERMENT`.
- **Deferral:** `formal_authorised_legal_approval: "DEFERRED_TO_FIRST_COMMERCIAL_RELEASE"`.

---

## 4. Execution Workflow for Final Gate F Certification

When the human infrastructure operator executes the maintenance window:

1. Complete Caddy directory mount migration (`caddy-directory-migration-runbook.md`).
2. Merge Workstream A (`gate-f/ops-015-deployment-freeze`) into `main`.
3. Execute `infra/oci/deploy-prod.sh <candidate_sha>` to deploy candidate to production.
4. Run live external probes and drills, capturing receipts into `artifacts/`.
5. Execute backup and isolated restore drill following `docs/operations/BACKUP_RESTORE.md`.
6. Run authoritative certification validator:
   ```bash
   node scripts/validate-gate-f.mjs <candidate_sha>
   ```
7. Output will verify Gate F production certification:
   ```text
   ✓ GATE F PRODUCTION CERTIFICATION VERIFIED
     Candidate SHA: <candidate_sha>
     Hostname: matchday.poladex.shop
     Assurance Profile: automated-only-owner-waived-v2
   ```
