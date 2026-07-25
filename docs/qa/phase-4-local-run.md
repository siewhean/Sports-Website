# Phase 4 — reproducible local Gate B run

> **Historical run record — superseded for the 24 July 2026 remediation.** All
> outcomes below are attached to their stated older SHAs only. They are not
> evidence for `fix/gate-b-local-remediation-20260724-132224` or any later SHA.
> The remediation may be certified only by a newly generated immutable browser
> evidence artifact and a fresh independent review at the exact tested SHA.

## Final exact-SHA closure — 23 July 2026

**Branch:** `codex/gate-b-lockfile-integrity`

**Validated source commit:** `c87287f1acad2c1f2a51e374bbe8f4ab6f58d7ee`

Historical local Gate B result: PASS (superseded)

Hosted GitHub Actions: Not executed because Actions allowance is unavailable.

The final raw logs are retained under the ignored local path
`artifacts/qa/gate-b-final-c87287f/`. The sanitised, hash-bound command ledger,
browser versions, artifact hashes, isolation records and accepted residual
risks are in
[`phase-4-final-evidence.json`](./phase-4-final-evidence.json).

All required commands passed at the exact source SHA. Key totals are: 684 unit
tests; database integration 54/54; generic E2E 274 passed; embedded real journey
3/3; accessibility 68/68; visual comparison 13/13; and two additional isolated
real journeys at 3/3 each. The two isolated runs used different disposable
PostgreSQL databases, different Redis queues and newly started API, worker and
production web processes. Each produced three passing persistence oracles and
deleted 15/15 inspected Redis keys.

The populated Phase 3 upgrade test passed five of five uncached runs on
PostgreSQL 18.4: minimum 1.07 s, median 1.09 s and maximum 1.11 s against its
narrowly scoped 15 s timeout, with no concurrent test load. The complete
infrastructure-enabled integration command subsequently passed. PostgreSQL
finished with zero residual `test_*` schemas and zero granted advisory locks.

The final source fix serialises test-schema teardown under the existing
transaction-scoped migration advisory lock. This closes the reproduced
PostgreSQL lock-table exhaustion caused by concurrent `DROP SCHEMA ... CASCADE`
operations without raising server lock limits, reducing general test
concurrency, or removing assertions.

**Executed:** 22 July 2026, 19:48–21:07 SGT (`+08`)

**Repository:** complete local checkout on `agent/gate-b-organiser-journey`

**Validated source commit:** `b2306e6dfc9d44c8d53bf756c00b1530202188e0`

**Validation state:** clean source tree at the commit above; no Gate C work is included. The evidence-only verdict update follows this source commit and does not alter production or test code.

Historical local Gate B result: PASS (superseded)

Hosted GitHub Actions: Not executed because Actions allowance is unavailable.

## Post-merge lockfile and clean-isolation revalidation — 23 July 2026

**Branch:** `codex/gate-b-lockfile-integrity`

**Validated source commit:** `aa87be059a35a790a6801d74f5074457bb5c84d2`

Historical local Gate B result: PASS (superseded)

Durable raw logs are under the ignored local path `artifacts/qa/gate-b-revalidation/`.

| Requirement                                  | Final result | Evidence                                                                                                                                                      |
| -------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24.18 container and frozen pnpm install | PASS         | `01d-container-frozen-install-corrected-lock-retry.log`: Node 24.18.0, pnpm 10.33.0, empty in-memory store, 571 packages                                      |
| Formatting, lint and TypeScript              | PASS         | `02-host-static-checks.log` and `02b-host-static-checks-uncached.log`: formatting passed; 0 cached lint/typecheck tasks; 3 lint and 16 typecheck tasks passed |
| PostgreSQL migrations                        | PASS         | `03-host-migrations-integration.log`: clean-schema verification passed all 25 forward migrations                                                              |
| PostgreSQL/Redis integration                 | PASS         | `03d-host-integration-uncached-retry.log`: 20/20 tasks, 0 cached; database 53/53 and Redis queue 4/4 passed                                                   |
| Production dependency audit                  | PASS         | `04b-pnpm-audit-corrected-lockfile.log`: no known vulnerabilities                                                                                             |
| Real Gate B journey, isolation 1             | PASS         | `05b-real-gate-b-run-1.log`: production build; phone Chromium, tablet WebKit and desktop Chromium 3/3; persistence and Redis-cleanup oracles passed           |
| Real Gate B journey, isolation 2             | PASS         | `06-real-gate-b-run-2.log`: separate Redis database and disposable PostgreSQL isolation; 3/3; persistence and Redis-cleanup oracles passed                    |
| Chromium/WebKit accessibility                | PASS         | `07-a11y-chromium-webkit.log`: 47/47 passed                                                                                                                   |
| Chromium/WebKit visual comparison            | PASS         | `08b-visual-retry-after-enospc.log`: 13/13 matched approved baselines                                                                                         |

The revalidation found a malformed `fast-uri@4.1.1` SRI in the merged lockfile. The recorded digest decoded to 65 bytes, which is impossible for SHA-512. npm metadata and an independently downloaded 34,614-byte tarball agreed on the canonical 64-byte digest. Commit `aa87be0` changes only the invalid `hQw==` suffix to `hQ==`; integrity verification remains enabled. A fresh container/store frozen install then passed.

Earlier failures remain recorded rather than being replaced: two frozen installs rejected the malformed SRI; Docker image reads and one visual attachment failed while the host disk was exhausted; and the first fully uncached integration run timed out one Phase 4 upgrade-safety case at 5 seconds while 52/53 database tests passed. After disk recovery and Docker restart, the isolated test passed 8/8, the complete visual suite passed 13/13, two real Gate B journeys passed, and the complete uncached integration suite passed 20/20 tasks with the formerly timed-out case completing in 4.836 seconds. The narrow timeout margin remains a local reliability risk to monitor; no timeout or test assertion was weakened.

## Environment

| Component        | Exact version used                                                                     |
| ---------------- | -------------------------------------------------------------------------------------- |
| Operating system | macOS 26.6 (25G5043d), arm64                                                           |
| Node             | 24.18.0, selected explicitly with `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` |
| pnpm             | 10.33.0                                                                                |
| PostgreSQL       | 18.4, disposable databases in the repository's local container                         |
| Redis            | 8.2.7, repository local container                                                      |
| Mailpit          | 1.27.4, repository local container                                                     |
| Playwright       | 1.61.1                                                                                 |
| Chromium         | 149.0.7827.55                                                                          |
| WebKit           | 26.5                                                                                   |

The unqualified interactive shell currently resolves Node 25.8.1. It was not used for the acceptance commands. `75-environment-pinned.log`, `75-infrastructure-versions.log`, and `75-browser-versions.log` record the binaries and containers actually used.

## Required command ledger

Durable raw logs are under the ignored local path `artifacts/qa/gate-b/`. The table names the final successful log. Earlier failed attempts and their corrections remain in the same directory and are summarised below.

| Command                                                                           | Exit | Executable evidence                                                                                                   |
| --------------------------------------------------------------------------------- | ---: | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                  |    0 | `50-install-final-network-rerun.log`                                                                                  |
| `pnpm ci:assert-clean-outputs`                                                    |    0 | `51-clean-outputs-final.log`                                                                                          |
| `pnpm format:check`                                                               |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`                                                                    |
| `pnpm lint`                                                                       |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`                                                                    |
| `pnpm typecheck`                                                                  |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`                                                                    |
| `pnpm test:unit`                                                                  |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`: 28/28 tasks; domain 291, scheduler 30, web 155, API 16, AI 32     |
| `pnpm db:migrate:check`                                                           |    0 | `91-b2306e6-infrastructure-gates.log`: clean schema, 25 forward migrations                                            |
| `pnpm backup:verify`                                                              |    0 | `91-b2306e6-infrastructure-gates.log`: restored account and fingerprint verified                                      |
| `RUN_INFRA_TESTS=1 pnpm test:integration`                                         |    0 | `91-b2306e6-infrastructure-gates.log`: 20/20 tasks; API 84, database 53, scheduler 3, plus supporting packages        |
| `pnpm validate:fixtures`                                                          |    0 | `59-validate-fixtures-final.log`: five canonical competitions, one extended scenario, 17 format oracles               |
| `pnpm validate:phase2`                                                            |    0 | `60-validate-phase2-final.log`: independent 8- and 16-entry fixtures                                                  |
| `pnpm validate:phase3`                                                            |    0 | `61-validate-phase3-final.log`: five sports, five sizes, 15 graph oracles, four time-zone cases, three invalid graphs |
| `pnpm validate:phase4`                                                            |    0 | `62-validate-phase4-final.log`: five sizes and shared-area multi-division fixture                                     |
| `pnpm openapi:check`                                                              |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`                                                                    |
| `pnpm dependencies:audit`                                                         |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`: no known vulnerabilities                                          |
| `pnpm secrets:scan`                                                               |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`: no leaks                                                          |
| `pnpm build`                                                                      |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`: 16/16 packages, Next production build                             |
| `pnpm deploy:manifest`                                                            |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`: 54 assets                                                         |
| `pnpm asset-delivery:verify:origin`                                               |    0 | exact-SHA umbrella log `90-b2306e6-pnpm-check.log`: all 54 assets                                                     |
| `pnpm --filter @matchday/web exec playwright install --with-deps chromium webkit` |    0 | `69-playwright-install-final.log`                                                                                     |
| `pnpm test:e2e`                                                                   |    0 | `92-b2306e6-test-e2e.log`: 255 passed, 7 intentional project skips; real matrix 3/3 passed                            |
| `pnpm test:a11y`                                                                  |    0 | `93-b2306e6-a11y-visual-diff.log`: 47/47 passed                                                                       |
| `pnpm test:visual`                                                                |    0 | `93-b2306e6-a11y-visual-diff.log`: 13/13 matched approved baselines                                                   |
| `git diff --check`                                                                |    0 | `93-b2306e6-a11y-visual-diff.log`                                                                                     |
| `pnpm check`                                                                      |    0 | `90-b2306e6-pnpm-check.log`: complete umbrella through origin delivery verification                                   |

No acceptance test was deleted, relaxed, skipped outside its existing project applicability, or allowlisted to create a green result.

## Browser, persistence, console and network evidence

The final `pnpm test:e2e` first passed the production-built responsive browser suite, then created one disposable PostgreSQL database/schema and one unique Redis queue for the real matrix. Within them, phone Chromium, tablet WebKit, and desktop Chromium each used an isolated competition aggregate, issued requests through the web BFF and API, persisted the setup/template/schedule/move/publication lineage, recorded six audit events, and verified the published projection. The shutdown oracle scanned and deleted 12 queue keys.

Browser guards reported no unapproved console warnings, console errors, page errors, or failed requests. The recurring Node `NO_COLOR`/`FORCE_COLOR` warning is runner stderr, not browser-console output.

The approved Phase 4 snapshot paths are under:

- `apps/web/tests/phase-4-schedule-visual.spec.ts-snapshots/`
- `apps/web/tests/phase-4-setup-format-visual.spec.ts-snapshots/`

The affected setup/format baselines were inspected at original resolution before update. A subsequent normal comparison passed 13/13. No visual diff remained.

## Failures found and closed during this run

- The production dependency audit initially reported `fast-uri` and `sharp`/libvips advisories. Direct parents were inspected, compatible updates were applied, serialization, schemas, Swagger/OpenAPI, Next image generation/rendering and production builds were retested, and the final production audit reported no known vulnerabilities.
- PostgreSQL tests exposed schedule-revision concurrency gaps. Forward migration `0025_phase4_schedule_concurrency_hardening.sql`, constraints and integration coverage close them.
- The real browser runner could accept an unrelated stale server on port 3103. Readiness now requires the launched child process and matching Next build ID; the isolated 3/3 run and final umbrella run passed with cleanup.
- The generic Playwright configuration collected the real-infrastructure spec. It now excludes that spec; the umbrella command runs it explicitly after the generic matrix.
- Assisted Setup demo resume and the authoritative multi-division recommendation contract disagreed. The guarded local/demo resume document and strict parser now use the canonical contract; production does not silently fall back to fixtures.
- A capacity value failed colour contrast. Its token was corrected and the complete accessibility suite passed.
- Schedule controls could be clicked before hydration. Commands remain disabled until hydration; the focused regression and real browser matrix passed.
- A recommendation focus assertion raced the explicit resume command lock. The test now waits for the real button to become enabled, then still requires browser focus and zero overflow; five repeated desktop passes preceded the full suite.
- The secret scan found a fixed CSRF test literal and stale ignored Playwright traces containing session-like values. The test generates a random token and the stale traces were removed from the repository tree; the scanner was not weakened.
- Origin delivery verification required HSTS from an HTTP-only local origin after proxy hardening. The verifier now requires HSTS on HTTPS and rejects it on HTTP; the proxy regression, production build, and 54-asset origin check passed.
- The first `pnpm check` rerun found one unformatted hydration edit. That exact file was formatted; the complete command then exited 0.
- The first committed-source browser rerun exposed WebKit reporting a completed move-validation request as cancelled during navigation cleanup. The component now aborts only genuinely unsettled validation. Five repeated phone WebKit flows and the complete exact-SHA browser matrix passed with clean runtime guards.

Sandbox-only failures (`EPERM` on loopback/process operations and registry DNS denial) were rerun unchanged with local execution permission. Their failed and successful logs are retained; they are not product failures.

## Dependency result

`pnpm dependencies:audit`: PASS — no known production vulnerabilities. The two `fast-uri` paths resolve to patched releases. `sharp` is constrained to 0.35.3 with inherited libvips 1.3.2 and passed production image/build regressions. Residual P3: the scoped `sharp` compatibility override should be removed when the direct Next dependency resolves to the same safe line; owner Platform dependency, target the next stable dependency review before Gate C release.

## Residual risks

- P2: sticky decision/action rails can obscure content in some phone/tablet move and schedule views. Current reachability, safe-area, accessibility and overflow tests pass and no data is lost. Owner Frontend UX; fix or explicitly re-accept before the Gate C browser verdict.
- P3: some Phase 3 snapshot filenames imply broader responsive coverage than the forced viewports actually provide. Owner QA automation; rename or split before the Gate C visual verdict.
- Evidence boundary: the local proof does not replace deployed identity, CDN,
  telemetry, managed backup or authenticated production-device evidence. Owner
  Platform/Operations; address at the relevant production release gate. This is
  not a Gate B defect or a third P3 finding.
- The validated source and evidence are committed and independently reviewed. PR #3 was squash-merged as `aa841806192fdaa5418b22fac44ab6e9eb268a38` without bypassing branch protection.

## Verdict boundary

This document proves the reproducible local validation commands above and records the completed PR #3 merge. It does not claim a hosted runner result or a production deployment.
