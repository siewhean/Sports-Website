# Phase 4 — reproducible local Gate B run

**Executed:** 22 July 2026, 19:48–20:53 SGT (`+08`)

**Repository:** complete local checkout on `agent/gate-b-organiser-journey`

**Reviewed commit:** `4b62a48a90d648cd3f2c9deb360c2bd34ca74e10`

**Validation state:** the reviewed commit plus the uncommitted merge-readiness corrections listed by `git status`; no Gate C work is included.

Local Gate B validation: PASS

Hosted GitHub Actions: Not executed because the account Actions allowance is unavailable.

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
| `pnpm format:check`                                                               |    0 | `52-format-check-final-rerun.log`; repeated by `74-pnpm-check-rerun.log`                                              |
| `pnpm lint`                                                                       |    0 | `53-lint-final.log`; repeated by `74-pnpm-check-rerun.log`                                                            |
| `pnpm typecheck`                                                                  |    0 | `54-typecheck-final.log`; repeated by `74-pnpm-check-rerun.log`                                                       |
| `pnpm test:unit`                                                                  |    0 | `55-test-unit-final-rerun.log`: 28/28 tasks; domain 291, scheduler 30, web 152, API 16, AI 32                         |
| `pnpm db:migrate:check`                                                           |    0 | `56-db-migrate-check-final.log`: clean schema, 25 forward migrations                                                  |
| `pnpm backup:verify`                                                              |    0 | `57-backup-verify-final.log`: restored account and fingerprint verified                                               |
| `RUN_INFRA_TESTS=1 pnpm test:integration`                                         |    0 | `58-test-integration-final.log`: 20/20 tasks; API 84, database 53, scheduler 3, plus supporting packages              |
| `pnpm validate:fixtures`                                                          |    0 | `59-validate-fixtures-final.log`: five canonical competitions, one extended scenario, 17 format oracles               |
| `pnpm validate:phase2`                                                            |    0 | `60-validate-phase2-final.log`: independent 8- and 16-entry fixtures                                                  |
| `pnpm validate:phase3`                                                            |    0 | `61-validate-phase3-final.log`: five sports, five sizes, 15 graph oracles, four time-zone cases, three invalid graphs |
| `pnpm validate:phase4`                                                            |    0 | `62-validate-phase4-final.log`: five sizes and shared-area multi-division fixture                                     |
| `pnpm openapi:check`                                                              |    0 | `63-openapi-check-final-rerun.log`                                                                                    |
| `pnpm dependencies:audit`                                                         |    0 | `64-dependencies-audit-final-rerun.log`: no known vulnerabilities                                                     |
| `pnpm secrets:scan`                                                               |    0 | `65-secrets-scan-final-rerun.log`: no leaks                                                                           |
| `pnpm build`                                                                      |    0 | `66-build-final.log`: 16/16 packages, Next production build                                                           |
| `pnpm deploy:manifest`                                                            |    0 | `67-deploy-manifest-final.log`: 54 assets                                                                             |
| `pnpm asset-delivery:verify:origin`                                               |    0 | `68-asset-delivery-origin-final-rerun2.log`: all 54 assets                                                            |
| `pnpm --filter @matchday/web exec playwright install --with-deps chromium webkit` |    0 | `69-playwright-install-final.log`                                                                                     |
| `pnpm test:e2e`                                                                   |    0 | `70-test-e2e-final-rerun4.log`: 255 passed, 7 intentional project skips; real matrix 3/3 passed                       |
| `pnpm test:a11y`                                                                  |    0 | `71-test-a11y.log`: 47/47 passed                                                                                      |
| `pnpm test:visual`                                                                |    0 | `72-test-visual.log`: 13/13 matched approved baselines                                                                |
| `git diff --check`                                                                |    0 | `73-git-diff-check.log`; repeated after final formatting                                                              |
| `pnpm check`                                                                      |    0 | `74-pnpm-check-rerun.log`: the complete repository umbrella finished through origin delivery verification             |

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

Sandbox-only failures (`EPERM` on loopback/process operations and registry DNS denial) were rerun unchanged with local execution permission. Their failed and successful logs are retained; they are not product failures.

## Dependency result

`pnpm dependencies:audit`: PASS — no known production vulnerabilities. The two `fast-uri` paths resolve to patched releases. `sharp` is constrained to 0.35.3 with inherited libvips 1.3.2 and passed production image/build regressions. Residual P3: the scoped `sharp` compatibility override should be removed when the direct Next dependency resolves to the same safe line; owner Platform dependency, target the next stable dependency review before Gate C release.

## Residual risks

- P2: sticky decision/action rails can obscure content in some phone/tablet move and schedule views. Current reachability, safe-area, accessibility and overflow tests pass and no data is lost. Owner Frontend UX; fix or explicitly re-accept before the Gate C browser verdict.
- P3: some Phase 3 snapshot filenames imply broader responsive coverage than the forced viewports actually provide. Owner QA automation; rename or split before the Gate C visual verdict.
- P3: the local proof does not replace deployed identity, CDN, telemetry, managed backup or authenticated production-device evidence. Owner Platform/Operations; address at the relevant production release gate.
- The working tree must be committed and independently reviewed before merge. Remote merge remains subject to repository-owner policy; no branch-protection bypass is authorised.

## Verdict boundary

This document proves the reproducible local validation commands above. It does not claim a hosted runner result, a production deployment, or that the branch has been merged.
