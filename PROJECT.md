# Project: Gate C Final Remediation & Integration

## Architecture

- **Monorepo Topology**: Managed by `pnpm@10.33.0` and `turbo.json` with topological build pipeline (`dependsOn: ["^build"]`).
- **Core Domain & Contracts**: `@matchday/contracts` defines API DTOs and typed `ErrorCode`/`ApiErrorCode` constants. `@matchday/domain` encapsulates offline scoring, format rules, and C4 repair domain logic.
- **Data & Migration Layer**: `@matchday/database` encapsulates PostgreSQL migrations (`0001` through `0051`), migration runner with SHA256 checksum verification, and advisory locks.
- **API Runtime (`apps/api`)**: Fastify backend with V2 repository pattern (`RepairRepository`, `PublicationRepository`, `PublicProjectionRepository`, `CompetitionRepository`, `ScoringRepository`, etc.), strictly typed `ApiError(statusCode, code, message)` exceptions, and atomic database transaction blocks.
- **Frontend & Offline Engine (`apps/web`, `@matchday/ui`)**: Next.js App Router frontend and `@matchday/ui` components with IndexedDB offline queue repository, server-authoritative expiration enforcement, and principal fencing.
- **Observability & Benchmarking (`packages/observability`)**: C5 integrated workload runner, latency budget monitors (>=500 samples/op), lock metrics polling, and failure drill hooks.

## Code Layout

- `packages/contracts/src/`: DTOs, schemas, and `error-codes.ts` (`ErrorCode`, `ApiErrorCode`).
- `packages/domain/src/`: Domain logic (`offline-scoring.ts`, `result-repair.ts`, `repair-publication.ts`, etc.).
- `packages/database/migrations/`: Sequential forward-only migrations (`0001_...` to `0051_...`).
- `packages/database/src/`: Migration runner (`migrations.ts`) and client helpers.
- `packages/database/tests/`: Integration tests for migration matrix (`migrations.test.ts`, `gate-c-c2-malformed-upgrade-preflights.test.ts`, etc.).
- `packages/database/scripts/`: Migration lock profiling and benchmark scripts (`benchmark-migration-locks.ts`, `profile-populated-migration.ts`).
- `apps/api/src/repositories/`: V2 Repositories (`repair.repository.ts`, `publication.repository.ts`, `public-projection.repository.ts`, `index.ts`).
- `apps/api/src/`: C4 runtime, Postgres publisher, lifecycle, HMAC keyring, and error handling (`gate-c-c4-*`, `scoring-access-hmac-keyring.ts`, `errors.ts`).
- `apps/api/scripts/`: Operational scripts (`gate-c-c5-evidence.ts`).
- `apps/web/lib/offline-scoring/`: IndexedDB offline storage adapter (`indexeddb.ts`, `repository.ts`).
- `packages/observability/src/`: C5 workload runner, benchmarks, and controlled failure hooks.
- `docs/operations/`: Operational runbooks (`MIGRATION_0030_0031_RUNBOOK.md`, `SCORING_ACCESS_HMAC_ROTATION.md`).
- `docs/qa/` & `artifacts/qa/`: QA evidence ledgers (`gate-c-c3-final-evidence.json`, `gate-c-c5-final-evidence.json`, `gate-c-final-evidence.json`).

## Feature Inventory

| #   | Feature                                        | Description                                                                                                | Milestone | Source     |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------- | ---------- |
| 1   | Workspace Build Graph & Clean Build Guard      | Declarative Turbo build graph (`^build`) and clean checkout workspace output assertions                    | M1        | R1         |
| 2   | Mainline Integration Line Preservation         | Preserve V2 repository layer, typed error contracts, scheduler fixes, identity assurance                   | M1        | R2         |
| 3   | Forward-Only Database Migrations (0036–0051)   | Renumber Gate C migrations starting at 0036 to resolve collision with main 0032–0035                       | M1        | R3         |
| 4   | 6-Scenario Temporal Migration Matrix           | Empty DB, Historical pre-C2, Current-main (0032–0035), Malformed pre-0030, Malformed pre-0031, Repaired    | M2        | R3         |
| 5   | 0030/0031 Production Lock Benchmarks & Runbook | Measure 4 traffic profiles, log table lock modes & metrics, author MIGRATION_0030_0031_RUNBOOK.md          | M2        | R5         |
| 6   | C4 V2 Repository Layer Alignment               | Route C4 runtime queries through RepairRepository, PublicationRepository, PublicProjectionRepository       | M3        | R4         |
| 7   | Centralized ErrorCode Strict Contract          | Replace raw string ApiErrors with typed ErrorCode enum constants across apps/api                           | M3        | R4         |
| 8   | Atomic C4 Transaction Rollback                 | Ensure publication failures atomically roll back revisions, actions, schedules, projections, audit, outbox | M3        | R4         |
| 9   | Server-Authoritative Offline Scoring Authority | Strict enforcement of recording_expires_at, replay_expires_at, pass_expires_at & 2000 queue capacity       | M4        | R6         |
| 10  | IndexedDB Retention & Isolation Lifecycle      | 72h retention for synced packages, preserve unacknowledged conflicts, principal isolation on sign-out      | M4        | R6         |
| 11  | Multi-Platform C3 Test Harness & Receipts      | 5-browser Playwright matrix and iOS Safari / Android Chrome physical receipts validation                   | M5        | R7         |
| 12  | C5 Sustained Performance Benchmarking          | >=500 samples/op benchmark runner, latency budget validation, restore gate-c-c5-evidence.ts                | M5        | R7         |
| 13  | Controlled Failure Drills & Key Rotations      | Interruption drills, backup/restore rehearsal, dual HMAC key rotations (rate-limit & fallback)             | M5        | R7         |
| 14  | QA Evidence Ledgers & Candidate Freezing       | Generate gate-c-c3-final-evidence.json, gate-c-c5-final-evidence.json, gate-c-final-evidence.json          | M5        | R7         |
| 15  | E2E Testing Suite (Tiers 1–4)                  | Requirement-driven test suite with >=11*N test cases covering all inventoried features                     | M6        | Acceptance |
| 16  | Adversarial Coverage Hardening (Tier 5)        | White-box stress testing, edge-case generation, and bug fixing via Challenger loop                         | M6        | Final      |

## Milestones

| #   | Name                                                    | Scope                                                                                                  | Dependencies | Status  |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------ | ------- |
| M1  | Build & Database Migration Forward-Porting              | Renumber migrations to 0036–0051, update test references, verify Turbo build & clean outputs           | None         | DONE    |
| M2  | Temporal Migration Matrix & Lock Benchmarks             | 6-scenario temporal DB test matrix, lock benchmarking harness (4 profiles), operational runbook        | M1           | PLANNED |
| M3  | C4 V2 Architecture Alignment & ErrorCode                | Fix repositories, migrate C4 runtime/publisher to repos, replace raw ApiErrors, verify atomic rollback | M1           | PLANNED |
| M4  | Server-Authoritative Offline Scoring & Retention        | Expiration timestamps, 2000 queue model, 72h IndexedDB retention, principal isolation                  | M1           | PLANNED |
| M5  | Multi-Platform C3, Failure Drills & C5 Certification    | C5 script restoration, C5 benchmarks (>=500 samples), failure drills, HMAC rotations, QA ledgers       | M2, M3, M4   | PLANNED |
| M6  | Final Milestone: E2E Test Suite & Adversarial Hardening | Phase 1: 100% E2E test pass (Tiers 1–4). Phase 2: Tier 5 Adversarial Coverage Hardening                | M1–M5        | PLANNED |

## Interface Contracts

### `apps/api` ↔ `packages/database`

- Migrations executed strictly in sequential order `0001` through `0051`.
- All database queries from routes and business services must use repository classes in `apps/api/src/repositories/`.
- Transactional operations must accept an optional transaction context `sql: SqlTransaction | Sql`.

### `@matchday/contracts` ↔ `apps/api`

- All errors thrown across API routes must use `ApiError(statusCode: number, code: ApiErrorCode, message: string)` where `code` is a member of `ErrorCode`.
- All request/response payloads must conform to Zod schemas in `@matchday/contracts`.

### `@matchday/domain` ↔ `apps/web` (Offline Scoring)

- Offline commands must validate against server-issued expiration timestamps (`recording_expires_at`, `replay_expires_at`, `pass_expires_at`).
- IndexedDB storage adapter must enforce queue limit of 2,000 commands, warn at 1,800, and retain synced packages for 72 hours while preserving unacknowledged conflicts.
