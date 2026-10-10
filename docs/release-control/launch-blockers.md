# MATCHDAY Singapore Launch Blockers & Prerequisites Catalog

**Document Version:** 1.0.0  
**Status:** ACTIVE GOVERNANCE CATALOG  
**Target Event:** MATCHDAY Singapore Launch  
**Assurance Profile:** `automated-only-owner-waived-v2` (ADR 0005)  
**Evaluation Baseline:** Commit `3bbe7cc59dba2eb77808e6a04e0ffefc8ccccc1a` (PR #66 merged; no production certification)

---

## 1. Executive Summary

This document catalogs all active operational, architectural, and governance launch blockers that must be cleared prior to commencing live tournament operations in Singapore.

Each blocker is tracked with an authoritative ID (`BLK-01` through `BLK-11`), severity, owning workstream, detailed risk description, resolution prerequisites, explicit operator actions, and verifiable machine-checkable acceptance criteria.

---

## 2. Launch Blocker Summary Ledger

| ID         | Title                                                 | Severity | Owning Workstream    | Category               | Current Status                       |
| ---------- | ----------------------------------------------------- | -------- | -------------------- | ---------------------- | ------------------------------------ |
| **BLK-01** | Production Caddy Directory Mount Not Migrated         | **P0**   | Workstream D / Infra | Ingress Infrastructure | Blocked (Pending Maintenance Window) |
| **BLK-02** | OPS-015 Source Merge Completed; Prod Evidence Pending | **P0**   | Workstream A / Ops   | Deployment Safety      | Source Resolved; Prod Pending        |
| **BLK-03** | Production Backup & DR Evidence Pending               | **P0**   | Workstream B / Ops   | Data Reliability       | Pending Operator Capture             |
| **BLK-04** | Live SLO Baseline External Evidence Pending           | **P0**   | Workstream C / QA    | Performance & SLO      | Pending Probe Execution              |
| **BLK-05** | Alert Routing Drill External Evidence Pending         | **P0**   | Workstream C / Ops   | Operations & Incident  | Pending Alert Drill                  |
| **BLK-06** | Edge CDN Cache Purge External Evidence Pending        | **P0**   | Workstream C / Infra | Ingress & Edge CDN     | Pending Provider Drill               |
| **BLK-07** | Feature Flag Admin Operational Verification Pending   | **P0**   | Workstream C / Web   | Operations Management  | UI Merged; Audit Pending             |
| **BLK-08** | Cloud Cost Budget Alert External Evidence Pending     | **P1**   | Workstream C / Ops   | Governance & Finance   | Pending OCI Receipt                  |
| **BLK-09** | Production DNS/TLS & SEO Live Probes Pending          | **P0**   | Workstream C / Web   | Security & Search      | Pending Live Probe                   |
| **BLK-10** | Email SPF/DKIM/DMARC & Bounce Webhook Pending         | **P0**   | Workstream C / Comms | Email Communications   | Pending DNS / Webhook Run            |
| **BLK-11** | Gate F Final Production Certification Pending         | **P0**   | Central Coordination | Release Gate           | Blocked by BLK-01..10                |

---

## 3. Comprehensive Blocker Breakdown & Resolution Specifications

### BLK-01: Production Caddy Directory Mount Not Migrated

- **Severity:** **P0** (Critical Infrastructure Blocker)
- **Owning Workstream:** Workstream D / Infrastructure Operations
- **Affected Requirements:** `OPS-001`, `OPS-002`
- **Description & Risk:**
  - The live production Caddy container `matchday-oci-caddy-1` runs with a legacy file bind mount (`/etc/caddy/Caddyfile`).
  - Docker file bind mounts pin the host file's inode. When `deploy-prod.sh` performs atomic replacement (`mv -f .Caddyfile.candidate /etc/matchday/caddy/Caddyfile`), the container continues observing the unlinked old inode.
  - Caddy reload reloads the stale configuration, causing zero-downtime traffic switches and automatic rollbacks to fail silently.
  - To prevent catastrophic production deployment state drift, `deploy-prod.sh` lines 580–617 fails closed (`DEPLOYMENT_BLOCKED=YES`, `REASON=LEGACY_OR_INCOMPATIBLE_CADDY_MOUNT`).
- **Prerequisites for Resolution:**
  - Scheduled 15-minute off-peak maintenance window.
  - Authorised operator access to the OCI production VM.
- **Resolution Procedure:**
  - Operator executes `docs/release-control/caddy-directory-migration-runbook.md`.
  - Recreates Caddy container using `docker compose -f infra/oci/compose.yaml up -d --force-recreate caddy`.
  - Attaches container to `matchday-prod_backend` network.
  - Executes inode visibility test and verifies zero-downtime reload.
- **Acceptance Criteria:**
  - `docker inspect <caddy_id>` confirms bind mount source `/etc/matchday/caddy`, destination `/etc/caddy`, mode `ro` (read-only), with zero file mounts targeting `/etc/caddy/Caddyfile`.
  - `deploy-prod.sh` preflight mount inspection outputs `VALID`.

---

### BLK-02: OPS-015 Source Merge Completed; Production Evidence Pending

- **Severity:** **P0** (Production Deployment Safety)
- **Owning Workstream:** Workstream A / Operations
- **Affected Requirements:** `OPS-015`
- **Source Status:** PR #66 was squash-merged into protected `main` as `3bbe7cc59dba2eb77808e6a04e0ffefc8ccccc1a`. This closes the source-merge blocker.
- **Policy:** Production activity is checked at preflight and immediately before traffic promotion. No forward-deployment override is available solely from asserted notifications or emergency environment flags. OPS-002 internal rollback remains distinct.
- **Operational Gap:** Live production freeze and rollback evidence are still pending; no approval for Caddy, database or traffic changes is implied.
- **Acceptance Criteria:** Independently verify exact-head CI and source lineage, then retain authentic production operator receipts during separately approved release operations.

---

### BLK-03: Production Backup & DR Evidence Pending

- **Severity:** **P0** (Data Resilience Blocker)
- **Owning Workstream:** Workstream B / Operations Lead
- **Affected Requirements:** `OPS-011`, `OPS-012`
- **Description & Risk:**
  - Point-in-time recovery and full disaster recovery restoration must be validated against real production fixtures.
  - Unverified backups risk silent corruption, missing schema constraints, or restore failures during live tournament operations.
- **Prerequisites for Resolution:**
  - Production database operational on OCI VM.
  - Off-host OCI Object Storage bucket configured with customer-managed encryption and 30-day retention.
- **Resolution Procedure:**
  - Operator executes `docs/operations/BACKUP_RESTORE.md` on production host.
  - Generates full database dump using `pg_dump -Fc`.
  - Computes SHA-256 digest and uploads to encrypted off-host bucket.
  - Restores dump into an isolated disposable target container.
  - Verifies migration ledger, constraints, and representative reads.
  - Records bundle `artifacts/production-backup-evidence.json` with all 6 physical receipt files.
- **Acceptance Criteria:**
  - `node scripts/run-gate-f-backup-restore-audit.mjs <candidate_sha> --evidence artifacts/production-backup-evidence.json` outputs `verdict: "PASS"`.

---

### BLK-04: Live SLO Baseline External Evidence Pending

- **Severity:** **P0** (Platform Performance Blocker)
- **Owning Workstream:** Workstream C / QA Lead
- **Affected Requirements:** `OPS-004`, `OPS-008`
- **Description & Risk:**
  - Tournament organisers require low-latency score propagation (p95 <= 500ms) and high public page availability (>= 99.9%).
  - Live performance baselines must be captured from external synthetic monitors against the production candidate.
- **Prerequisites for Resolution:**
  - Production candidate deployed and accessible via public domain `https://matchday.poladex.shop`.
- **Resolution Procedure:**
  - Run synthetic load harness or external monitoring probes against production candidate.
  - Capture latency metrics for scoring write, public read, and availability over observation window.
  - Save valid external probe receipt to `artifacts/gate-f-slo-baseline.json`.
- **Acceptance Criteria:**
  - `score_write_p95_ms` <= 500ms.
  - `public_read_p95_ms` <= 2500ms.
  - `availability_percentage` >= 99.9%.
  - `error_rate_percentage` <= 0.1%.

---

### BLK-05: Alert Routing Drill External Evidence Pending

- **Severity:** **P0** (Incident Response Blocker)
- **Owning Workstream:** Workstream C / Operations
- **Affected Requirements:** `OPS-005`
- **Description & Risk:**
  - If operational alerts fail to reach on-call responders, platform outages (worker crash, database connection exhaustion, scoring degradation) could go unaddressed during matches.
- **Prerequisites for Resolution:**
  - PagerDuty / Webhook and Slack alerting integration keys configured.
- **Resolution Procedure:**
  - Trigger non-destructive alert drills for all 4 routing channels (`service_unavailable`, `scoring_latency_breach`, `worker_dead`, `backup_failed`).
  - Capture delivery acknowledgement receipts.
  - Save provider receipt to `artifacts/gate-f-alert-routing.json`.
- **Acceptance Criteria:**
  - `scripts/run-gate-f-ops-audit.mjs` verifies `all_routes_verified: true` and `delivery_acknowledged: true`.

---

### BLK-06: Edge CDN Cache Purge External Evidence Pending

- **Severity:** **P0** (Public Projection Truthfulness Blocker)
- **Owning Workstream:** Workstream C / Infrastructure
- **Affected Requirements:** `OPS-009`
- **Description & Risk:**
  - Organisers and fans viewing matchday schedules and standings depend on accurate, timely tournament data.
  - Stale CDN cache entries could show outdated brackets or incorrect playoff qualifications.
- **Prerequisites for Resolution:**
  - CDN edge caching active on `matchday.poladex.shop`.
- **Resolution Procedure:**
  - Publish tournament update and trigger automated surrogate-key purge via API.
  - Capture CDN provider purge receipt containing `purge_id`, timestamp, and scope.
  - Save receipt to `artifacts/gate-f-cache-purge.json`.
- **Acceptance Criteria:**
  - `scripts/run-gate-f-cache-purge.mjs` outputs `verdict: "PASS"` with purge latency <= 1000ms.

---

### BLK-07: Feature Flag Administration Operational Verification Pending

- **Severity:** **P0** (Operational Control Requirement)
- **Owning Workstream:** Workstream C / Web Engineering
- **Affected Requirements:** `OPS-018`
- **Source Status:** PR #64 already merged the feature flag administration web page and control plane. The previous operations audit hardcoded UI absence; PR #68 corrects that source finding.
- **Remaining Gap:** Verify the corrected audit against its exact Git SHA and obtain real authorised operator proof of access control, toggle effects, audit trail and safe defaults. No live evidence is claimed.
- **Acceptance Criteria:** `admin_ui_present: true` based on verified source, truthful pending operational verdict until live evidence is received, and separately certified operator functionality.

---

### BLK-08: Cloud Cost Budget Alert External Evidence Pending

- **Severity:** **P1** (Financial Governance Blocker)
- **Owning Workstream:** Workstream C / Operations
- **Affected Requirements:** `OPS-016`
- **Description & Risk:**
  - Runaway background tasks, unbounded log growth, or runaway network egress could cause unexpected infrastructure cost overruns.
- **Prerequisites for Resolution:**
  - OCI Cost Management budget alerts active.
- **Resolution Procedure:**
  - Configure OCI budget alert rules for compute, block storage, object storage, and egress.
  - Capture provider budget configuration receipt.
  - Save receipt to `artifacts/gate-f-cost-controls.json`.
- **Acceptance Criteria:**
  - `scripts/run-gate-f-ops-audit.mjs` reports `costControls.verdict: "PASS"`.

---

### BLK-09: Production DNS/TLS & SEO Live Probes Pending

- **Severity:** **P0** (Public Security & Discovery Blocker)
- **Owning Workstream:** Workstream C / Web Engineering
- **Affected Requirements:** `OPS-014`, `GATE-F-SEO`
- **Description & Risk:**
  - Unverified TLS certificates could trigger browser security warnings for organisers and players.
  - Misconfigured `robots.txt` or broken sitemaps could prevent public tournament discoverability.
- **Prerequisites for Resolution:**
  - Production domain `matchday.poladex.shop` pointing to live Caddy ingress.
- **Resolution Procedure:**
  - Run external probe testing TLS 1.3, HSTS header, and automated certificate issuance.
  - Verify `/robots.txt` and `/sitemap.xml` response from production origin.
  - Save receipts to `artifacts/gate-f-dns-tls.json` and `artifacts/gate-f-seo.json`.
- **Acceptance Criteria:**
  - `scripts/run-gate-f-recertifications.mjs` outputs `dnsTls.verdict: "PASS"` and `seo.verdict: "PASS"`.

---

### BLK-10: Email SPF/DKIM/DMARC & Bounce Webhook Pending

- **Severity:** **P0** (Communications Blocker)
- **Owning Workstream:** Workstream C / Communications Lead
- **Affected Requirements:** `OPS-017`
- **Description & Risk:**
  - Transactional emails (organiser invites, password resets, scoring notifications) failing delivery would stall tournament participation.
  - Unhandled bounces could hurt domain reputation and cause suppression by major email providers.
- **Prerequisites for Resolution:**
  - Resend domain DNS records verified; webhook URL registered in Resend dashboard.
- **Resolution Procedure:**
  - Capture Resend domain verification receipt showing valid SPF, DKIM, DMARC.
  - Send test email generating a hard bounce and verify receipt by webhook receiver.
  - Save provider receipt to `artifacts/gate-f-email.json`.
- **Acceptance Criteria:**
  - `scripts/run-gate-f-recertifications.mjs` outputs `email.verdict: "PASS"`.

---

### BLK-11: Gate F Final Production Certification Pending

- **Severity:** **P0** (Release Governance Blocker)
- **Owning Workstream:** Central Coordination / Principal Engineer
- **Affected Requirements:** Master Gate F Certification
- **Description & Risk:**
  - Release cannot proceed to live tournament operation until `scripts/validate-gate-f.mjs` passes and certifies the candidate SHA under ADR 0005.
- **Prerequisites for Resolution:**
  - All upstream blockers BLK-01 through BLK-10 cleared.
  - All 16 artifacts in `artifacts/` populated and validated.
- **Resolution Procedure:**
  - Human release engineer executes:
    ```bash
    node scripts/validate-gate-f.mjs <deployed_sha>
    ```
- **Acceptance Criteria:**
  - Exit code `0`.
  - Machine verification confirms `gate: "F"`, `assurance_profile: "automated-only-owner-waived-v2"`, `candidate_sha: <deployed_sha>`, and all 5 human waivers `WAIVED_NOT_EXECUTED`.

---

## 4. Critical Path Execution Order for Launch

```text
[Step 1: Code Integration]
  PR #66 OPS-015 source merged; PR #64 OPS-018 admin UI source merged
  Certify and separately authorise PR #67, PR #68 and PR #69 sequential merges
  Reconcile OPS-018 source audit; preserve pending live operator evidence

[Step 2: Host Preparation (Maintenance Window)]
  Execute Caddy Migration Runbook (BLK-01: Caddy Directory Mount)
  Verify Inode Visibility & deploy-prod.sh Preflight

[Step 3: Production Deployment]
  Execute deploy-prod.sh <candidate_sha>

[Step 4: Live Drills & Receipts Collection]
  Capture Production Backup & DR (BLK-03)
  Run Synthetic SLO Probes (BLK-04)
  Execute Alert Routing Drill (BLK-05)
  Execute CDN Purge Drill (BLK-06)
  Capture OCI Cost Budget Alert (BLK-08)
  Verify DNS/TLS & SEO Probes (BLK-09)
  Verify Email Domain & Bounce Webhook (BLK-10)

[Step 5: Release Certification]
  Run scripts/validate-gate-f.mjs (BLK-11)
  Official Gate F Clearance for Singapore Launch
```
