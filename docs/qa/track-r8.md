# Track R8 Quality Assurance Audit & Verification Report

**Track:** R8 (Release Candidate, Rehearsal and Launch)  
**Checkpoint:** CP8 (Gate F) & Checkpoint L (Launch Readiness)  
**Date:** 15 October 2026  
**Branch:** [`feat/r8-release-candidate-rehearsal-launch`](file:///Users/Siew%20Hean/Documents/Sports%20Website)  
**Assurance Profile:** `automated-only-owner-waived-v2` ([ADR 0005](file:///Users/Siew%20Hean/Documents/Sports%20Website/docs/decisions/0005-gate-f-production-assurance.md))

---

## 1. Executive Summary

Track R8 prepares the release candidate and operational drills for launch readiness. In strict accordance with ADR 0005 and audit findings, this report distinguishes verified codebase contracts from production operations that await live execution:

1. **Realistic Staging Replica & Archive Safety:** A seeder script ([`seed-staging-production-replica.ts`](file:///Users/Siew%20Hean/Documents/Sports%20Website/apps/api/scripts/seed-staging-production-replica.ts)) equipped with strict production guards (`assertSafeNonProductionDatabase`) to block production hosts, databases, and environments. Competitions are created and transitioned through domain runtime checks ([`Phase3Runtime`](file:///Users/Siew%20Hean/Documents/Sports%20Website/apps/api/src/phase-3-runtime.ts)) across active, completed, and frozen archived states. A regression suite ([`staging-replica-migration.test.ts`](file:///Users/Siew%20Hean/Documents/Sports%20Website/packages/database/tests/integration/staging-replica-migration.test.ts)) confirms migrations through 0074 execute cleanly without violating archive immutability guards (the "0073 problem").
2. **Load Testing Harness & Diagnostics:** A CLI harness ([`scripts/run-r8-load-tests.mjs`](file:///Users/Siew%20Hean/Documents/Sports%20Website/scripts/run-r8-load-tests.mjs)) executing against real candidate Git SHAs. In local development, in-process mock execution is strictly categorized as `developer_component_diagnostic_only` (verdict: `COMPONENT_DIAGNOSTIC_ONLY`) and does not certify production capacity. Target peak numbers remain pending owner decision in [`docs/EXECUTION_ROADMAP.md`](file:///Users/Siew%20Hean/Documents/Sports%20Website/docs/EXECUTION_ROADMAP.md).
3. **Gate F Operational Drills & Dynamic Audits:** The drill orchestrator ([`scripts/run-gate-f-drills.mjs`](file:///Users/Siew%20Hean/Documents/Sports%20Website/scripts/run-gate-f-drills.mjs)) evaluates what actually ran. Static contract audits (migration expand-contract, security headers, dependency scan, legal technical package) pass. Live production drills (rollback execution, backup/restore proof, CDN cache invalidation, alert triggers) remain honestly marked as `PENDING` / `CONFIG_AUDIT_ONLY`. The overall automated verdict is dynamically reported as `CONFIG_AND_CONTRACT_AUDIT_PASS_PRODUCTION_DRILLS_PENDING`.
4. **Content Fingerprints:** Output JSON files record SHA-256 self-checksums (`content_fingerprint_sha256`) to detect file tampering, rather than claiming cryptographic signatures.
5. **Operations & Rehearsal Runbooks:** Actionable, verified runbooks for the live rehearsal ([`docs/operations/LIVE_REHEARSAL_RUNBOOK.md`](file:///Users/Siew%20Hean/Documents/Sports%20Website/docs/operations/LIVE_REHEARSAL_RUNBOOK.md)) and deployment freeze / on-call coverage ([`docs/operations/LAUNCH_ON_CALL_PLAN.md`](file:///Users/Siew%20Hean/Documents/Sports%20Website/docs/operations/LAUNCH_ON_CALL_PLAN.md)).

---

## 2. Checkpoint CP8 & L Status Matrix

| Item             | Requirement                      | Verification Status                                    | Reality & Evidence                                                                                                                                                                                                                 |
| :--------------- | :------------------------------- | :----------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R8.1**         | Release Candidate SHA            | **READY**                                              | Resolved dynamically via Git HEAD (`git rev-parse HEAD`) or explicit `--candidate-sha`; dummy SHA fallbacks strictly rejected.                                                                                                     |
| **R8.2**         | Staging Simulation & Replica     | **TESTED CONTRACT / PENDING HOST**                     | Seeder with production guards and `Phase3Runtime` domain transitions implemented. Migration safety with archived knockout matches verified in integration suite. Standalone remote staging host deployment pending infrastructure. |
| **R8.3**         | Peak Load Test                   | **COMPONENT DIAGNOSTIC PASS / PENDING OWNER DECISION** | In-process component diagnostic passes SLO latency checks locally (`COMPONENT_DIAGNOSTIC_ONLY`). Production load certification and expected peak numbers pending owner decision.                                                   |
| **R8.4**         | Live Rehearsal on Production     | **AWAITING EXECUTION**                                 | Runbook prepared with paper fallback; requires physical event execution by the owner.                                                                                                                                              |
| **R8.5**         | Gate F Operational Drills        | **CONFIG & CONTRACT AUDIT PASS (LIVE DRILLS PENDING)** | Migration expand-contract passes. Rollback, restore, edge cache purge, and alert firing drills marked `PENDING` / `CONFIG_AUDIT_ONLY` until executed on live infrastructure.                                                       |
| **R8.6**         | Deployment Freeze & On-Call Plan | **DOCUMENTED**                                         | Freeze protocol and 2-weekend on-call response matrix established.                                                                                                                                                                 |
| **CP8**          | Gate F Checkpoint                | **PENDING LIVE REHEARSAL & PRODUCTION DRILLS**         | Checkboxes in roadmap remain unticked until live execution completes.                                                                                                                                                              |
| **Checkpoint L** | Launch Readiness                 | **PENDING OWNER SIGN-OFF**                             | Requires owner execution of live rehearsal, Stripe live mode, repository privacy, and launch sign-off.                                                                                                                             |

---

## 3. Component Details & Test Verification

### 3.1 Staging Copy with Realistic Data & The "0073 Problem"

- **Seeder Script:** [`apps/api/scripts/seed-staging-production-replica.ts`](file:///Users/Siew%20Hean/Documents/Sports%20Website/apps/api/scripts/seed-staging-production-replica.ts)
  - **Production Guard:** `assertSafeNonProductionDatabase(databaseUrl)` blocks execution if `APP_ENV` or `NODE_ENV` is `production`, if hostname matches production domains (`poladex.shop`, `neon.tech`, `aws`, `rds`, `supabase`, `onrender.com`), or if database name contains `prod`. Non-loopback targets require explicit `--allow-staging-seed` confirmation.
  - **Domain Runtime Transitions:** Competitions and divisions are created and transitioned through [`Phase3Runtime`](file:///Users/Siew%20Hean/Documents/Sports%20Website/apps/api/src/phase-3-runtime.ts) (`createCompetition`, `createDivision`, `transitionCompetition`, and `mutateCompetition` with `action: 'archive'`), ensuring domain invariant checks and mutation receipts are exercised.
  - **Archived States:** Populates multi-sport competitions across all lifecycles, specifically including archived competitions with frozen match graphs protected by the database archive guard (`aa_matches_phase3_archive_guard`).
- **Regression Suite:** [`packages/database/tests/integration/staging-replica-migration.test.ts`](file:///Users/Siew%20Hean/Documents/Sports%20Website/packages/database/tests/integration/staging-replica-migration.test.ts)
  - Replays migrations up to pre-0073, seeds active and archived competitions, then applies 0073 and 0074 forward.
  - Verifies that active competition penultimate matches are relabeled to `semifinal` while archived knockout matches remain byte-for-byte untouched and protected by trigger guards.

### 3.2 Peak Load Testing

- **Harness:** [`scripts/run-r8-load-tests.mjs`](file:///Users/Siew%20Hean/Documents/Sports%20Website/scripts/run-r8-load-tests.mjs)
- **Candidate SHA Verification:** Enforces a valid 40-character Git SHA (no dummy fallback allowed).
- **Execution Modes & Reporting:**
  - `component`: In-process developer diagnostic using synthetic workloads. Generates `artifacts/r8-load-test-summary.json` with `evidence_class: "developer_component_diagnostic_only"` and `verdict: "COMPONENT_DIAGNOSTIC_ONLY"`. Clearly indicates that local in-process timings do not certify production or staging performance.
  - `staging`: Executes real network HTTP requests against an external `TARGET_URL` and validates response latency against deployed Git SHA.
- **Content Fingerprint:** Records SHA-256 self-checksum (`content_fingerprint_sha256`) of the artifact JSON.

### 3.3 Gate F Drills & Recertifications

- **Orchestrator:** [`scripts/run-gate-f-drills.mjs`](file:///Users/Siew%20Hean/Documents/Sports%20Website/scripts/run-gate-f-drills.mjs)
- **Derived Verdicts:**
  - **Migration Safety:** `PASS` (Static contract audit of expand-contract rules across 74 migration files).
  - **Zero-Downtime Rollback:** `PENDING` (`drill_executed: false`, `simulation_result: "NOT_EXECUTED_PENDING_PRODUCTION_DRILL"`; fake hardcoded steps and durations removed).
  - **Database Restore:** `PENDING` (No live production backup capture provided; rejects local/synthetic sources).
  - **Edge Cache Purge:** `PENDING` (`protocol_verification: "SOURCE_PASS"`, live purge not executed).
  - **Alert Routing & Monitoring:** `PENDING` (`protocol_verification: "SOURCE_PASS"`, live alerts not fired).
  - **Security & Legal Recertifications:** `PASS_AUTOMATED_SCOPE` (Dependency audit and secret scan clean; manual pentest waived per ADR 0005; legal technical implementation complete with formal legal approval deferred per ADR 0005).
  - **Overall Verdict:** `CONFIG_AND_CONTRACT_AUDIT_PASS_PRODUCTION_DRILLS_PENDING`.

---

## 4. Exact Reproduction Commands

```bash
# 1. Run Staging Production Replica Safety Guard Tests
pnpm --filter @matchday/api exec vitest run tests/unit/seed-staging-safety.test.ts

# 2. Run Staging Replica Migration Safety Regression Test
pnpm --filter @matchday/database test packages/database/tests/integration/staging-replica-migration.test.ts

# 3. Run Peak Load Tests (Component Diagnostic Mode)
node scripts/run-r8-load-tests.mjs --mode=component

# 4. Run Gate F Recertification Drills Orchestrator
node scripts/run-gate-f-drills.mjs

# 5. Run Gate F Audits Verification Suite (17 tests)
node --test scripts/gate-f-audits.test.mjs

# 6. Monorepo Quality & Contract Verification
pnpm check:source
```
