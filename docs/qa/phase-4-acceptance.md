# Phase 4 — Gate B local acceptance evidence

**Date:** 22 July 2026

**Branch:** `agent/gate-b-organiser-journey`

**Reviewed commit before the uncommitted merge-readiness closeout:** `4b62a48a90d648cd3f2c9deb360c2bd34ca74e10`

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

| Gate                 | Command                                                                           | Result                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting           | `pnpm format:check`                                                               | PASS                                                                                                                                                                                                                                    |
| Lint and i18n        | `pnpm lint`                                                                       | PASS: 3/3 tasks; i18n 28/28 fixtures, 116 files, 608 registered messages, 0 findings                                                                                                                                                    |
| TypeScript           | `pnpm typecheck`                                                                  | PASS: 16/16 workspace packages                                                                                                                                                                                                          |
| Unit aggregate       | `pnpm test:unit`                                                                  | PASS: 28/28 Turbo tasks; representative counts include domain 291, scheduler 30, web 152, API 16 and AI 32                                                                                                                              |
| Migrated integration | `RUN_INFRA_TESTS=1 pnpm test:integration`                                         | PASS: 20/20 tasks; API 84, database 53, scheduler 3, plus identity/jobs/worker/feature-flag/notification coverage                                                                                                                       |
| Production build     | `pnpm build`                                                                      | PASS: 16/16 packages; Next production build compiled, typechecked and generated 32 pages                                                                                                                                                |
| Fixture validators   | `pnpm validate:fixtures`, `validate:phase2`, `validate:phase3`, `validate:phase4` | PASS: 5 canonical competitions, 1 extended scenario, 17 format oracles; Phase 2 sizes 8/16; Phase 3 five sports/five sizes/15 graphs/four time-zone boundaries/three invalid graphs; Phase 4 five sizes plus shared-area multi-division |
| API contract         | `pnpm openapi:check`                                                              | PASS: generated OpenAPI current and valid JSON                                                                                                                                                                                          |
| Secrets              | `pnpm secrets:scan`                                                               | PASS: 0 leaks                                                                                                                                                                                                                           |
| Restore              | `pnpm backup:verify`                                                              | PASS: all 25 migrations, restored account row and fingerprint verified                                                                                                                                                                  |
| Browser matrix       | `pnpm test:e2e`                                                                   | PASS: 255 generic browser tests, 7 intentional project-applicability skips, then 3/3 real browser→BFF→API→PostgreSQL/Redis journeys across desktop Chromium, tablet WebKit and phone Chromium                                           |
| Accessibility        | `pnpm test:a11y`                                                                  | PASS: 47/47                                                                                                                                                                                                                             |
| Visual comparison    | `pnpm test:visual`                                                                | PASS: 13/13                                                                                                                                                                                                                             |
| Dependency audit     | `pnpm dependencies:audit`                                                         | PASS: no known production vulnerabilities                                                                                                                                                                                               |
| Umbrella             | `pnpm check`                                                                      | PASS through format, lint, types, tests, validators, OpenAPI, audit, secrets, production build, deployment manifest and origin delivery                                                                                                 |
| Whitespace           | `git diff --check`                                                                | PASS                                                                                                                                                                                                                                    |

The browser suites enforce accessibility checks and fail on unapproved console warnings/errors, page errors and request failures. The repeated Node `NO_COLOR`/`FORCE_COLOR` process warning is runner output, not a browser-console event or product runtime error.

## Browser evidence boundary

The generic Playwright matrix uses the production-built Next application for user interactions, responsive layouts, state/error surfaces, accessibility and visual snapshots. In addition, the final umbrella command runs a separately isolated real matrix through the web BFF and API into disposable PostgreSQL and a unique Redis queue. That matrix proves persisted setup, template, scheduler, move, audit and publication behavior for phone Chromium, tablet WebKit and desktop Chromium. It remains local and does not impersonate a deployed authenticated production-device run.

## Dependency audit and umbrella check

The two `fast-uri` paths now resolve to patched versions after compatible parent updates. The Next image path is constrained to `sharp 0.35.3` with libvips 1.3.2. Response serialization, schemas, Swagger/OpenAPI, production images, Open Graph rendering and the Next production bundle were regression-tested. `pnpm dependencies:audit` reports no known vulnerabilities and the complete `pnpm check` exits 0. The scoped `sharp` override remains a P3 maintenance risk owned by Platform Dependency for the next stable dependency review.

## External boundary

Hosted GitHub Actions: Not executed because the account Actions allowance is unavailable.

No live billing/payment provider, deployed identity provider, CDN purge, hosted telemetry, managed regional backup, real authenticated production browser/device or production-host smoke is claimed. Pull-request readiness after the independent local verdict does not imply those external checks passed. The complete command ledger, correction trail and residual-risk owners are in `docs/qa/phase-4-local-run.md`.
