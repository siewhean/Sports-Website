# Phase 4 — Gate B local acceptance evidence

**Date:** 22 July 2026

**Branch:** `agent/gate-b-organiser-journey`

**Base commit before the uncommitted Gate B closeout:** `cde3c46`

**Runtime:** Node `24.18.0`, pnpm `10.33.0`

## Real aggregate journey

`apps/api/tests/integration/phase-4-runtime.test.ts` carries one fresh competition and one server-owned setup draft through:

1. create and resume;
2. Canoe Polo to Basketball selection, followed by canonical resume/refresh of the invalidated capacity and sport-pack references;
3. Basketball slot/settings propagation;
4. capacity, dynamic competition/division settings, 16 entries across two divisions and format preferences;
5. capacity-filtered recommendations and selection;
6. exact recommended format revision IDs, definition hashes, persisted layouts, validation, materialisation and publication for both divisions;
7. a durable Redis queue and real `SchedulerRuntime` worker with current-best checkpointing and duplicate-active-job rejection;
8. alternative acceptance, lock/unlock, safe move, immutable comparison and permission denial;
9. public projection rollback on failure, explicit publication, completed setup review, public schedule versions 1 and 2, immutable superseded/published revisions and stale-input fencing.

This test also pins the distinct hash domains correctly: the worker option hash identifies the complete solver result, while the accepted schedule revision hash identifies the authoritative persisted match/area/time assignments.

## Executed evidence

Every command below used `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.

| Gate                   | Command                                                                                                                         | Result                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting             | `pnpm format:check`                                                                                                             | PASS                                                                                                                                                                                                                                    |
| Lint and i18n          | `pnpm lint`                                                                                                                     | PASS: 3/3 tasks; i18n 28/28 fixtures, 115 files, 608 registered messages, 0 findings                                                                                                                                                    |
| TypeScript             | `pnpm typecheck`                                                                                                                | PASS: 16/16 workspace packages                                                                                                                                                                                                          |
| Unit aggregate         | `pnpm test:unit`                                                                                                                | PASS: 28/28 Turbo tasks; representative counts include domain 291, scheduler 30, web 125, API 16 and AI 32                                                                                                                              |
| Database integration   | database Vitest `migrations`, `phase-3-schema`, `phase-4-schema` with `RUN_INFRA_TESTS=1`                                       | PASS: 3 files, 28 tests                                                                                                                                                                                                                 |
| Gate B API integration | API Vitest `phase-4-runtime`, `phase-4-gate-b-runtime`, `phase-4-routes`, `phase-4-setup-patch-routes` with `RUN_INFRA_TESTS=1` | PASS: 4 files, 22 tests                                                                                                                                                                                                                 |
| Production build       | `pnpm build`                                                                                                                    | PASS: 16/16 packages; Next production build compiled, typechecked and generated 32 pages                                                                                                                                                |
| Fixture validators     | `pnpm validate:fixtures`, `validate:phase2`, `validate:phase3`, `validate:phase4`                                               | PASS: 5 canonical competitions, 1 extended scenario, 17 format oracles; Phase 2 sizes 8/16; Phase 3 five sports/five sizes/15 graphs/four time-zone boundaries/three invalid graphs; Phase 4 five sizes plus shared-area multi-division |
| API contract           | `pnpm openapi:check`                                                                                                            | PASS: generated OpenAPI current and valid JSON                                                                                                                                                                                          |
| Secrets                | `pnpm secrets:scan`                                                                                                             | PASS: 0 leaks                                                                                                                                                                                                                           |
| Restore                | `pnpm backup:verify`                                                                                                            | PASS: all 24 migrations, restored account row and fingerprint verified                                                                                                                                                                  |
| Browser matrix         | explicit nine Phase 4 specs with `playwright test ... --retries=0`                                                              | PASS: 89 passed, 7 intentional project-applicability skips, 0 failed across desktop Chromium, tablet WebKit, phone WebKit and phone Chromium in 1.1 minutes                                                                             |
| Whitespace             | `git diff --check`                                                                                                              | PASS                                                                                                                                                                                                                                    |

The browser suites enforce accessibility checks and fail on unapproved console warnings/errors, page errors and request failures. The repeated Node `NO_COLOR`/`FORCE_COLOR` process warning is runner output, not a browser-console event or product runtime error.

## Browser evidence boundary

The Phase 4 Playwright routes use the production-built Next application and exercise user interactions, responsive layouts, state/error surfaces, accessibility and visual snapshots. Their application data is demo/mock-backed by design. They do not prove an authenticated browser talking to the same PostgreSQL/Redis aggregate used by the real runtime journey. The real aggregate and browser projection evidence are therefore complementary, not falsely presented as one end-to-end deployment.

## Dependency audit and umbrella check

`pnpm dependencies:audit` currently exits 1 with three high production advisories:

- `fast-uri` via `fastify > fast-json-stringify` (patched in `fast-uri >=4.1.1`);
- `fast-uri` via `@fastify/swagger > json-schema-resolver` (patched in `fast-uri >=3.1.4`);
- `sharp <0.35.0` / inherited libvips CVEs via Next (patched in `sharp >=0.35.0`).

Consequently the umbrella `pnpm check` is not green; its post-audit gates were executed separately above. These advisories and dependency upgrade compatibility require explicit remediation or risk acceptance and are not hidden by the local Gate B evidence.

## External boundary

GitHub-hosted CI could not run because of the repository/account billing state. No hosted CI success, live billing/payment provider, deployed identity provider, CDN purge, hosted telemetry, managed regional backup, real authenticated production browser/device or production-host smoke is claimed. Pull-request readiness after the independent local verdict does not imply those external checks passed.
