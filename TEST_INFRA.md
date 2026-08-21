# Test Architecture & Infrastructure (`TEST_INFRA.md`)

## 1. Overview & Architecture

The Matchday Sports Competition Platform E2E Testing Framework establishes an authoritative, requirement-driven, opaque-box test harness designed to validate all functional, architectural, operational, and lifecycle guarantees across the entire platform.

The testing architecture is structured around a systematic **4-Tier Methodology**:

1. **Tier 1: Feature Coverage (Category-Partition)**: Rigorous isolation tests verifying primary nominal behavior and functional contracts for each of the 16 features in `PROJECT.md` (>=5 test cases per feature; >=80 total tests).
2. **Tier 2: Boundary Value & Corner Case Analysis**: Systematically probes numerical limits, temporal deadlines, empty inputs, overflow thresholds, negative values, and security edge conditions for each feature (>=5 test cases per feature; >=80 total tests).
3. **Tier 3: Pairwise Combinatorial Interaction**: Tests cross-feature boundaries, composite state machines, and interface contracts between interconnected subsystems (Auth x Offline Scoring, Migrations x C4 Repositories x Rollback, Locks x C5 Benchmarks, HMAC Rotation x Access Passes, etc.).
4. **Tier 4: Real-World Application Workloads**: Multi-domain end-to-end tournament lifecycle scenarios emulating real production operations (5-sport tournament lifecycle, disconnected offline scoring & sync, disputed match repair & atomic publication, temporal multi-division database upgrade, and high-concurrency failure injection during HMAC rotation).

```
+-----------------------------------------------------------------------------------+
|                              TEST SUITE TOPOLOGY                                  |
+-----------------------------------------------------------------------------------+
| Tier 1: Feature Coverage (Category-Partition)               | >= 80 Test Cases    |
|   - 16 Features from PROJECT.md in isolation (>=5 tests/feat)|                     |
+-----------------------------------------------------------------------------------+
| Tier 2: Boundary & Corner Cases (BVA)                       | >= 80 Test Cases    |
|   - Threshold limits, empty sets, overflows, deadlines      |                     |
+-----------------------------------------------------------------------------------+
| Tier 3: Cross-Feature Combinations (Pairwise)               | >= 24 Test Cases    |
|   - Inter-module contracts, joint state transitions         |                     |
+-----------------------------------------------------------------------------------+
| Tier 4: Real-World Application Scenarios (Workloads)         | >= 5 Complex Workflows|
|   - Multi-domain tournament lifecycles & failure drills     |                     |
+-----------------------------------------------------------------------------------+
```

---

## 2. 16-Feature Inventory (`PROJECT.md`)

| Feature # | Feature Name                                   | Milestone | Primary Modules & Files                                                                                                                                  | Interface Contract & Scope                                                                                                                 |
| --------- | ---------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **F01**   | Workspace Build Graph & Clean Build Guard      | M1        | `turbo.json`, `package.json`, `scripts/assert-clean-workspace-outputs.mjs`                                                                               | Topological `^build` ordering, workspace dependencies build before `@matchday/web`, zero pre-existing dist in clean checkout.              |
| **F02**   | Mainline Integration Line Preservation         | M1        | `apps/api/src/repositories/`, `packages/identity/src/assurance.ts`, `packages/contracts/src/error-codes.ts`                                              | V2 Repository layer, centralized ErrorCode enum, scheduler unseeded graph mapping, identity assurance session MFA step-up.                 |
| **F03**   | Forward-Only Database Migrations (0036–0051)   | M1        | `packages/database/src/migrations.ts`, `packages/database/migrations/0036..0051`                                                                         | Strict forward progression starting at 0036, regex `/^\d{4}_[a-z0-9_]+\.sql$/`, SHA256 checksum pinning, advisory lock 1450121337.         |
| **F04**   | 6-Scenario Temporal Migration Matrix           | M2        | `packages/database/tests/integration/migrations.test.ts`, `packages/database/tests/integration/gate-c-c2-malformed-upgrade-preflights.test.ts`           | 6-scenario DB states: Empty DB, Historical pre-C2, Current-main (0032–0035), Malformed pre-0030, Malformed pre-0031, Repaired DB.          |
| **F05**   | 0030/0031 Production Lock Benchmarks & Runbook | M2        | `packages/database/scripts/benchmark-migration-locks.ts`, `docs/operations/MIGRATION_0030_0031_RUNBOOK.md`                                               | Lock mode analysis (AccessExclusive, Share, RowExclusive), 4 traffic profiles (baseline, public reads, organiser reads, writer mutations). |
| **F06**   | C4 V2 Repository Layer Alignment               | M3        | `apps/api/src/repositories/repair.repository.ts`, `publication.repository.ts`, `public-projection.repository.ts`                                         | Decomposed repository pattern replacing raw SQL in C4 runtime; typed parameters and transactions.                                          |
| **F07**   | Centralized ErrorCode Strict Contract          | M3        | `packages/contracts/src/error-codes.ts`, `apps/api/src/errors.ts`                                                                                        | Centralized `ErrorCode` object & `ApiErrorCode` type; `ApiError(status, code, message)` with zero raw string error codes.                  |
| **F08**   | Atomic C4 Transaction Rollback                 | M3        | `apps/api/src/gate-c-c4-runtime.ts`, `apps/api/src/gate-c-c4-postgres-publisher.ts`                                                                      | Atomic transaction rollback across revisions, actions, schedules, projections, audit, and outbox on partial publication failure.           |
| **F09**   | Server-Authoritative Offline Scoring Authority | M4        | `packages/domain/src/offline-scoring.ts`, `packages/contracts/src/gate-c-offline.ts`                                                                     | Expiration timestamps (`recording_expires_at` <= 4h, `replay_expires_at` <= +15m grace, `pass_expires_at`), 2000 queue capacity.           |
| **F10**   | IndexedDB Retention & Isolation Lifecycle      | M4        | `apps/web/lib/offline-scoring/indexeddb.ts`, `apps/web/lib/offline-scoring/types.ts`                                                                     | 72h retention for synced packages, preserving unacknowledged conflicts indefinitely, principal isolation on sign-out.                      |
| **F11**   | Multi-Platform C3 Test Harness & Receipts      | M5        | `apps/web/playwright.gate-c-c3.config.ts`, `scripts/run-gate-c-c3-ledger.mjs`                                                                            | 5-browser Playwright matrix (WebKit, Chromium, Firefox) and iOS Safari / Android Chrome physical receipt validation.                       |
| **F12**   | C5 Sustained Performance Benchmarking          | M5        | `packages/observability/src/c5-integrated-workload.ts`, `workload-profile.ts`, `workload-runner.ts`                                                      | >=500 samples/op minimum, 5 latency budgets (p95 <= 500ms ack/read, p95 <= 2s convergence/lease/repair), 0 unexpected errors.              |
| **F13**   | Controlled Failure Drills & Key Rotations      | M5        | `packages/observability/src/c5-integrated-workload.ts`, `packages/config/src/scoring-fallback-keyring.ts`, `apps/api/src/scoring-access-hmac-keyring.ts` | 12 failure hooks, backup/restore rehearsal, dual HMAC key rotations (rate-limit Redis TTL cooldown & fallback-code keyring).               |
| **F14**   | QA Evidence Ledgers & Candidate Freezing       | M5        | `artifacts/qa/`, `scripts/run-gate-c-*-ledger.mjs`, `scripts/validate-*-evidence.mjs`                                                                    | Multi-stage evidence ledgers bound to exact candidate Git commit SHA, strict ledger schema validation, zero P0/P1 defects.                 |
| **F15**   | E2E Testing Suite (Tiers 1–4)                  | M6        | `tests/e2e/`, `tests/e2e/vitest.config.ts`                                                                                                               | Systematic 4-tier methodology covering all 16 features, requirement-driven opaque-box design, self-contained execution.                    |
| **F16**   | Adversarial Coverage Hardening (Tier 5)        | M6        | `tests/e2e/tier1-features/feature-16-adversarial-hardening.test.ts`, `tests/e2e/tier2-boundaries/boundary-16-adversarial-hardening.test.ts`              | White-box stress testing, injection vectors, malicious inputs, concurrency race conditions, adversarial data boundaries.                   |

---

## 3. Test Runner & Execution Environment

- **Runtime**: Node.js `v24.18.0` (via NVM).
- **Package Manager**: `pnpm@10.33.0`.
- **Test Runner**: Vitest `4.1.10` / TypeScript `5.9.3` / tsx `4.23.1`.
- **Required Path**: `PATH="/Users/Siew Hean/.nvm/versions/node/v24.18.0/bin:$PATH"`.

### Primary Commands

```bash
# Set environment PATH
export PATH="/Users/Siew Hean/.nvm/versions/node/v24.18.0/bin:$PATH"

# Run complete 4-tier E2E test suite
pnpm exec vitest run --config tests/e2e/vitest.config.ts

# Run specific tiers
pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/tier1-features
pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/tier2-boundaries
pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/tier3-combinations
pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/tier4-scenarios

# Run individual feature tests
pnpm exec vitest run --config tests/e2e/vitest.config.ts tests/e2e/tier1-features/feature-09-offline-authority.test.ts
```

---

## 4. Coverage Thresholds & Quality Gates

1. **Tier 1 (Feature Coverage)**: 100% of the 16 features in `PROJECT.md` have at least 5 dedicated, high-fidelity isolation test cases (>=80 tests).
2. **Tier 2 (Boundary & Corner Cases)**: 100% of the 16 features have at least 5 boundary, limit, overflow, or negative test cases (>=80 tests).
3. **Tier 3 (Cross-Feature Combinations)**: Major inter-module pairwise interaction matrix tested (>=24 tests).
4. **Tier 4 (Real-World Application Scenarios)**: 5 comprehensive, multi-domain end-to-end tournament scenarios verified.
5. **Quality Gate**:
   - **Pass Rate**: Exactly 100% across all 4 tiers (0 failing tests).
   - **Flakiness**: Zero tolerance for nondeterministic timing or execution order dependencies.
   - **Integrity**: Zero facade tests, dummy mocks, or hardcoded cheating. All tests execute real domain algorithms, contracts, validators, and serializers.
