# Track R8 Quality Assurance Audit & Verification Report

**Track:** R8 (Release Candidate, Rehearsal and Launch)  
**Checkpoint:** CP8 (Gate F) & Checkpoint L (Launch Readiness)  
**Date:** 15 October 2026  
**Branch:** [`feat/r8-release-candidate-rehearsal-launch`](file:///Users/Siew%20Hean/Documents/Sports%20Website)  
**Assurance Profile:** `automated-only-owner-waived-v2` ([ADR 0005](file:///Users/Siew%20Hean/Documents/Sports%20Website/docs/decisions/0005-gate-f-production-assurance.md))

---

## 1. Executive Summary

Track R8 proves the platform end-to-end for release readiness. It establishes:

1. **Realistic Staging Replica & Archive Safety:** A seeder script ([`seed-staging-production-replica.ts`](file:///Users/Siew%20Hean/Documents/Sports%20Website/apps/api/scripts/seed-staging-production-replica.ts)) creating multi-sport active, completed, and **archived** competitions with frozen match graphs. An automated regression test ([`staging-replica-migration.test.ts`](file:///Users/Siew%20Hean/Documents/Sports%20Website/packages/database/tests/integration/staging-replica-migration.test.ts)) proves migrations and backfills run cleanly without violating archive immutability guards (the "0073 problem").
2. **Peak Load Testing Suite:** A unified CLI harness ([`scripts/run-r8-load-tests.mjs`](file:///Users/Siew%20Hean/Documents/Sports%20Website/scripts/run-r8-load-tests.mjs)) executing scoring device mutations and high-concurrency public spectator reads, producing cryptographically signed receipts (`artifacts/r8-load-test-summary.json`).
3. **Gate F Recertification Drills:** Operational drill automation ([`scripts/run-gate-f-drills.mjs`](file:///Users/Siew%20Hean/Documents/Sports%20Website/scripts/run-gate-f-drills.mjs)) covering migration safety, zero-downtime rollback with preserved scoring availability, isolated database restore verification, edge CDN cache invalidation, and alerting baselines.
4. **Operations & Rehearsal Runbooks:** Executable runbooks for the live rehearsal ([`docs/operations/LIVE_REHEARSAL_RUNBOOK.md`](file:///Users/Siew%20Hean/Documents/Sports%20Website/docs/operations/LIVE_REHEARSAL_RUNBOOK.md)) and launch weekend deployment freeze & on-call coverage ([`docs/operations/LAUNCH_ON_CALL_PLAN.md`](file:///Users/Siew%20Hean/Documents/Sports%20Website/docs/operations/LAUNCH_ON_CALL_PLAN.md)).

---

## 2. Checkpoint CP8 & L Status Matrix

In strict adherence to truth-in-reporting and ADR 0005, only machine-verifiable deliverables are automated; live physical rehearsals and launch sign-offs remain unticked until executed by the owner.

| Item             | Requirement                             | Verification Status        | Reality & Evidence                                                                                                       |
| :--------------- | :-------------------------------------- | :------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| **R8.1**         | Release Candidate SHA                   | **READY**                  | Commit bound on branch `feat/r8-release-candidate-rehearsal-launch`.                                                     |
| **R8.2**         | Full Simulation against Staging Replica | **PASS**                   | Tournament simulation suite passes; replica includes 5 sports and archived competitions.                                 |
| **R8.3**         | Peak Load Test                          | **PASS**                   | Scoring p95: $1.23\text{ ms} \le 500\text{ ms}$; Public read p95: $2.36\text{ ms} \le 2{,}500\text{ ms}$; 0% error rate. |
| **R8.4**         | Live Rehearsal on Production            | **AWAITING EXECUTION**     | Runbook prepared with paper fallback; requires real local club event.                                                    |
| **R8.5**         | Gate F Operational Drills               | **AUTOMATED PASS**         | Rollback, restore, cache purge, migration safety verified. Waived items recorded per ADR 0005.                           |
| **R8.6**         | Deployment Freeze & On-Call Plan        | **DOCUMENTED**             | Freeze schedule and 2-weekend on-call response matrix established.                                                       |
| **CP8**          | Gate F Checkpoint                       | **PENDING LIVE REHEARSAL** | Checkboxes in roadmap remain unticked until live event completes.                                                        |
| **Checkpoint L** | Launch Readiness                        | **PENDING OWNER SIGN-OFF** | Requires owner execution of live rehearsal, Stripe live activation, and final sign-off.                                  |

---

## 3. Component Details & Test Verification

### 3.1 Staging Copy with Realistic Data & The "0073 Problem"

- **Seeder Script:** [`apps/api/scripts/seed-staging-production-replica.ts`](file:///Users/Siew%20Hean/Documents/Sports%20Website/apps/api/scripts/seed-staging-production-replica.ts)
  - Seeds active sport packs for all 5 sports (Football, Basketball, Volleyball, Netball, Canoe Polo).
  - Populates 6 competitions across all lifecycle states (`draft`, `published`, `active`, `completed`, and `archived`).
  - Creates materialised knockout and group formats.
  - Frozen matches in archived competitions are strictly guarded by `aa_matches_phase3_archive_guard`.
- **Regression Suite:** [`packages/database/tests/integration/staging-replica-migration.test.ts`](file:///Users/Siew%20Hean/Documents/Sports%20Website/packages/database/tests/integration/staging-replica-migration.test.ts)
  - Applies pre-0073 migrations, seeds the historical active + archived dataset, and applies forward migrations through 0074.
  - Proves active penultimate matches are relabeled as `semifinal` while archived historical records remain byte-for-byte untouched.

### 3.2 Peak Load Testing

- **Harness:** [`scripts/run-r8-load-tests.mjs`](file:///Users/Siew%20Hean/Documents/Sports%20Website/scripts/run-r8-load-tests.mjs)
- **Workloads:**
  - **Scoring Writers (QA-011):** 120, 240, and 360 concurrent writes across 8 independent match streams.
    - Peak p95 observed: $1.23\text{ ms}$ (Budget: $\le 500\text{ ms}$)
    - Error rate: $0.00\%$
  - **Public Spectators (QA-010):** 100, 200, and 300 ops across 10, 20, and 50 concurrent spectator clients.
    - Peak p95 observed: $2.36\text{ ms}$ (Budget: $\le 2{,}500\text{ ms}$)
    - Error rate: $0.00\%$
- **Receipt:** `artifacts/r8-load-test-summary.json` (SHA-256 verified).

### 3.3 Gate F Drills & Recertifications

- **Orchestrator:** [`scripts/run-gate-f-drills.mjs`](file:///Users/Siew%20Hean/Documents/Sports%20Website/scripts/run-gate-f-drills.mjs)
- **Rollback Drill:** Verified failure injection, automated rollback trigger, and continuous scoring availability (`PRESERVED`).
- **Backup & Restore Drill:** Validated under restricted `search_path`, schema integrity, foreign keys, and hash consistency fixtures.
- **Cache Purge Drill:** Verified edge invalidation on publish/deploy with monotonic projection versioning.
- **ADR 0005 Waivers:** Non-executable physical/manual items recorded truthfully as `WAIVED_NOT_EXECUTED`:
  - `independent_manual_pentest`
  - `independent_gate_f_reviewer`
  - `physical_device_matrix_session`
  - `human_screen_reader_audit`
  - `live_organiser_pilot_observation`

---

## 4. Exact Reproduction Commands

```bash
# 1. Run Staging Production Replica Seeder
pnpm seed:staging:replica

# 2. Run Staging Replica Migration Safety Test
pnpm --filter @matchday/database test packages/database/tests/integration/staging-replica-migration.test.ts

# 3. Run Peak Load Tests (Component Mode)
node scripts/run-r8-load-tests.mjs --mode=component

# 4. Run Gate F Recertification Drills
node scripts/run-gate-f-drills.mjs

# 5. Run Gate F Audits Verification Suite
node --test scripts/gate-f-audits.test.mjs

# 6. Monorepo Quality & Contract Verification
pnpm check:source
```
