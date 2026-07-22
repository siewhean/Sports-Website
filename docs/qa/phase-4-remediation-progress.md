# Phase 4 Gate B remediation progress

**Updated:** 22 July 2026  
**Branch:** `agent/gate-b-production-readiness-audit`  
**Plan:** `docs/qa/GATE_B_BLOCKER_REMEDIATION_PLAN.md`

## Current overall verdict

**Verdict: BLOCKED**

The remediation code has not been executed in a complete local checkout with the pinned toolchain. No PASS claim is permitted yet.

## Phase status

| Phase | Status | Verdict | Notes |
|---|---|---|---|
| Phase 0 — Baseline | Not started | BLOCKED | Local checkout and command evidence unavailable in this environment |
| Phase 1 — Correctness | Source changes implemented | BLOCKED | Requires unit, migration, integration, and backup execution |
| Phase 2 — Real full-stack E2E | Initial targeted slice implemented | BLOCKED | Resume/read-only path added; schedule worker/publication journey remains |
| Phase 3 — Dependencies | Not started | BLOCKED | Production audit remains red |
| Phase 4 — UX/accessibility | Partial | BLOCKED | 320px and WCAG gate changes exist; reload and visual-platform work remains |
| Phase 5 — Reliability/performance | Not started | BLOCKED | No thresholds or load evidence |
| Phase 6 — Production AI | Not started | BLOCKED | Provider-or-disable decision unresolved |
| Phase 7 — External evidence | Not started | BLOCKED | Phase 0/1 external evidence remains open |
| Phase 8 — Independent verdict | Not started | BLOCKED | Depends on prior phases |

## Implementation completed in this slice

### Planning

- Added `docs/qa/GATE_B_BLOCKER_REMEDIATION_PLAN.md`.
- Defined eight ordered phases.
- Defined automated and manual QA/QC checks after every phase.
- Defined strict PASS/FAIL/BLOCKED verdict rules.

### Real-browser infrastructure

- Added `apps/web/playwright.gate-b-real.config.ts`.
- Added `apps/web/tests/phase-4-real-api.spec.ts`.
- Added `apps/api/scripts/run-phase-4-real-e2e.ts`.
- Added root command `pnpm test:e2e:phase4:real`.

### Initial browser regressions

The first real-browser slice targets two audit defects:

1. Valid unselected recommendations survive the real resume mutation and browser reload.
2. Completed setup responses parse and render as a truthful read-only review.

The harness is designed to use:

- a production Next.js build;
- the real same-origin BFF;
- Fastify with an authenticated identity session;
- `ReliableGateBPhase4Runtime`;
- a disposable PostgreSQL database or isolated schema;
- Redis-backed `ScheduleJobQueue` wiring;
- database oracles after Playwright completes.

Demo mode is explicitly disabled.

## Static QA/QC performed

- Confirmed the organizer route accepts UUID competition IDs.
- Confirmed loopback cookie forwarding treats `localhost` and `127.0.0.1` as local equivalents.
- Confirmed completed setup documents are derived as read-only by the current setup-domain mapper.
- Confirmed the setup-draft trigger permits the fixture transition only when revision and `updated_at` advance once.
- Confirmed the state file is written with mode `0600` and removed during cleanup.
- Confirmed PostgreSQL isolation cleanup handles both disposable databases and isolated schemas.
- Confirmed the browser test checks console errors, failed application responses, storage leakage, and HttpOnly cookie visibility.

## QA/QC not yet performed

The following have not run and therefore remain unknown:

- formatting;
- ESLint;
- TypeScript compilation;
- unit tests;
- PostgreSQL migrations;
- infrastructure integration tests;
- production web build;
- Playwright execution;
- browser screenshots;
- Redis connectivity;
- process interruption cleanup;
- dependency audit.

## Remaining Phase 2 work

1. Execute and repair the targeted harness.
2. Add accepted schedule-review resume fixture.
3. Add published-review resume fixture.
4. Start the real scheduler worker and generate an option through Redis.
5. Drive format selection and schedule publication from the browser rather than fixture code.
6. Add viewer, official, cross-tenant, CSRF, origin, and archived negative tests.
7. Add database oracles for format lineage, accepted schedule provenance, publication, audit, outbox, and idempotency.
8. Run desktop and phone journeys twice from clean isolation.

## Commands required for the next QA loop

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm --filter @matchday/api lint
pnpm --filter @matchday/api typecheck
pnpm --filter @matchday/web lint
pnpm --filter @matchday/web typecheck
RUN_INFRA_TESTS=1 pnpm test:integration
pnpm --filter @matchday/web exec playwright install chromium
pnpm test:e2e:phase4:real
git diff --check
```

## Advancement rule

Phase 2 remains `BLOCKED` until the new command executes successfully twice from clean isolation and the remaining schedule/publication journey is implemented.
