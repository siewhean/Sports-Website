# Phase 4 Gate B remediation progress

**Updated:** 22 July 2026  
**Branch:** `agent/gate-b-production-readiness-audit`  
**Plan:** `docs/qa/GATE_B_BLOCKER_REMEDIATION_PLAN.md`

## Current overall verdict

**Verdict: BLOCKED**

The source remediation has advanced, but the repository has not been executed in a complete checkout with Node `24.18.0`, pnpm `10.33.0`, PostgreSQL, Redis, Chromium, and WebKit. Gate B cannot receive PASS and Gate C must not begin.

## Phase status

| Phase | Status | Verdict | Notes |
|---|---|---|---|
| Phase 0 — Baseline | In progress | BLOCKED | Strict local runner and evidence self-test implemented; exact pinned environment unavailable here |
| Phase 1 — Correctness | Source remediation expanded | BLOCKED | Migrations 0025–0027 and regressions require full execution |
| Phase 2 — Real full-stack E2E | Worker-backed harness implemented in source | BLOCKED | Real worker, accepted/published fixtures, browser reads, and negative transport tests added; complete browser-driven mutation journey remains |
| Phase 3 — Dependencies | Not started | BLOCKED | Production audit remains red; lockfile must be regenerated with the pinned package manager |
| Phase 4 — UX/accessibility | Partial | BLOCKED | 320px and WCAG gate changes exist; reload behavior and visual-platform policy remain |
| Phase 5 — Reliability/performance | Not started | BLOCKED | No thresholds or load evidence |
| Phase 6 — Production AI | Not started | BLOCKED | Provider-or-disable decision unresolved |
| Phase 7 — External evidence | Not started | BLOCKED | Phase 0/1 identity, CDN, telemetry, restore, privacy, and domain approvals remain open |
| Phase 8 — Independent verdict | Not started | BLOCKED | Depends on prior phases |

## Implementation completed

### Phased QA/QC plan

- Added `docs/qa/GATE_B_BLOCKER_REMEDIATION_PLAN.md`.
- Defined eight ordered remediation phases.
- Defined automated, adversarial, manual, and independent checks after every phase.
- Limited verdicts to `PASS`, `FAIL`, and `BLOCKED`.

### Strict local evidence runner

Added:

- `scripts/gate-b-evidence.mjs`
- `scripts/test-gate-b-evidence.mjs`
- `scripts/run-gate-b-local.mjs`
- `pnpm qa:gate-b:runner-self-test`
- `pnpm qa:gate-b:local`

The runner:

- requires Node `24.18.x` and pnpm `10.33.0`;
- performs a frozen install;
- runs unit, migration, backup, infrastructure, fixture, OpenAPI, dependency, secret, build, browser, accessibility, visual, and whitespace checks;
- runs the real Gate B E2E twice from clean isolation;
- stops after a blocking failure by default;
- marks every unrun check as skipped;
- returns FAIL when any required check fails or is skipped;
- writes mode-0600 logs and a SHA-256-bound summary outside tracked source paths by default;
- redacts known secret environment values, key/value credentials, cookies, and Bearer authorization values.

### Executed runner self-test

The evidence helper self-test was executed in the available Node `22.16.0` environment. The first run exposed a missing `Bearer value` redaction case. That defect was fixed and the repeated self-test passed.

This is evidence for the small evidence-helper module only. It is not evidence for the Gate B application and does not replace the pinned Node `24.18.0` run.

### Correctness remediation

Existing source remediation includes:

- unselected recommendation resume preservation;
- accepted schedule and publication hash-domain corrections;
- truthful completed/expired read-only setup documents;
- server-owned recommendation selection canonicalisation;
- deterministic per-entry format participation metrics;
- staging/production demo-data fail-closed checks at build and request time;
- stricter WCAG A/AA and 320 CSS-pixel tests.

Newly discovered and remediated blocker:

- Assisted Setup recommendation selection created only draft format revisions, while schedule generation accepts only published, materialised revisions.
- Migration `0027_phase4_publish_selected_formats.sql` now materialises and publishes every selected division format atomically inside the setup mutation.
- The trigger binds every selected revision to the immutable recommendation set, candidate, candidate-division record, competition, division, and definition hash.
- Missing, duplicate, malformed, stale, superseded, cross-competition, or incomplete format evidence causes the entire setup save to roll back.
- Added clean-schema, populated-upgrade, and API integration regressions.

### Worker-backed real E2E harness

The authoritative harness is now:

- `apps/api/scripts/run-phase-4-real-e2e-v2.ts`
- `apps/web/playwright.gate-b-real.config.ts`
- `apps/web/tests/phase-4-real-gate-b.spec.ts`

The superseded v1 harness and duplicate browser spec were removed.

The v2 harness is designed to:

- start PostgreSQL and Redis;
- create a disposable database or isolated schema;
- apply every migration;
- start the actual `SchedulerRuntime` with `PostgresScheduleJobStore` and `DomainScheduleOptimizer`;
- verify scheduler readiness;
- create real organizer and cross-tenant sessions;
- create unselected, accepted, and published/completed setup states;
- enqueue schedule generation through Redis;
- consume it with the real worker;
- accept the current-best option;
- publish the schedule;
- complete setup;
- build and start the production Next.js application in API mode;
- run desktop and phone Chromium projects;
- assert recommendation, accepted schedule, completed setup, publication, and duplicate-audit database oracles;
- clean up processes, Redis clients, PostgreSQL isolation, and temporary credentials on success, failure, or interruption.

The real browser spec currently verifies:

1. unselected recommendations survive resume and reload without a revision increment;
2. accepted schedule evidence survives resume and retains the exact schedule revision;
3. published completed setup reloads as read-only;
4. the public projection exposes the published schedule version;
5. organizer session credentials remain HttpOnly and absent from browser storage and URLs;
6. cross-tenant reads, missing CSRF, and malicious origins fail closed;
7. positive flows emit no unexpected application 4xx/5xx responses or console errors.

## Static QA/QC performed

- Confirmed UUID organizer routes and loopback cookie forwarding.
- Confirmed the reliable runtime constructor and public-projection argument match production startup.
- Confirmed the Redis queue payload and worker runtime contracts.
- Confirmed schedule options inherit the objective from the job, not a non-existent option field.
- Confirmed the selected-format transition previously left formats unschedulable.
- Confirmed migration `0027` executes inside the setup transaction and rolls back atomically on any selected-division failure.
- Confirmed the state file is mode `0600` and removed during cleanup.
- Confirmed database/schema cleanup and child-process cleanup paths exist.
- Confirmed the public browser test asserts the supported schedule-version contract while PostgreSQL checks the exact internal revision ID.

## QA/QC not yet performed

The following remain unexecuted and unknown:

- frozen pnpm install;
- formatting;
- ESLint;
- TypeScript compilation;
- full unit tests;
- PostgreSQL migration execution;
- populated upgrade execution;
- infrastructure integration tests;
- backup and restore;
- production web build;
- scheduler-worker execution;
- Playwright desktop and phone execution;
- browser screenshots and traces;
- WebKit smoke testing;
- dependency audit;
- OpenAPI and asset verification;
- process interruption cleanup under real child processes.

## Remaining Phase 1 work

1. Execute migrations `0025`, `0026`, and `0027` from clean and populated schemas.
2. Execute forged recommendation and selected-format evidence tests.
3. Run concurrent resume and idempotent replay tests.
4. Verify no previous migration checksum changed.
5. Run backup/restore through the new trigger and selected format projections.
6. Issue an independent Phase 1 remediation verdict.

## Remaining Phase 2 work

1. Execute and repair the v2 harness.
2. Drive recommendation selection, schedule generation, acceptance, lock, move, comparison, publication, and completion from the browser rather than using fixture runtime calls for those mutations.
3. Add viewer, official, and archived-competition browser/API tests.
4. Add mobile semantic move-flow coverage.
5. Add lock and child-revision database oracles.
6. Add format lineage, audit, outbox, and idempotent replay oracles for every critical mutation.
7. Add WebKit smoke coverage after Chromium passes.
8. Execute desktop and phone journeys twice from clean isolation.

## Required command

From a complete checkout with the pinned toolchain:

```bash
pnpm qa:gate-b:runner-self-test
pnpm qa:gate-b:local
```

The strict runner expands this into every required command and refuses PASS when anything fails or is skipped.

## Advancement rule

Gate B remains `BLOCKED` until Phases 0–8 satisfy their exit criteria. Gate C must not begin before the independent Gate B verdict is exactly:

```text
Verdict: PASS
```
