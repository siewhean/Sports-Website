# Phase 7 — Pilots, Security, and Release Hardening: Implementation Plan

**Status:** IN PROGRESS (Phase 6 formally certified and merged)

**Phase 6 certified baseline:** `f5045d11ddadaa1cc1d08657857f573599e7ec62` (CI run [33401194920](https://github.com/siewhean/Sports-Website/actions/runs/33401194920) 100% Green on `integration/gate-c-final`)

**Phase 7 branch:** `phase-7/release-hardening` (branched from `f5045d11ddadaa1cc1d08657857f573599e7ec62`)

**Gates:** D (local pilot) and E (national parallel pilot)

**Scope:** QA-001–017, QA-019–030 (QA-018 printed fallback pack is Phase 5-owned, already satisfied at Gate C)

---

## Isolation rule

Do **not** add Phase 7 commits to the Phase 6 branch (`phase-6/commercial-operations` / PR #39). All evidence must distinguish:

```
Phase 6 certified baseline → Phase 7 product candidate → Gate D candidate → Gate E candidate
```

---

## QA requirements matrix

Legend:

- **SATISFIED** — verified with automated test suites and complete physical evidence attached
- **READY_FOR_LOCAL_PILOT** — implementation, test harness, and tooling complete; pending live event execution
- **READY_FOR_NATIONAL_PILOT** — baseline established; pending national competition event
- **EXTERNAL_PENDING** — tester/counsel scope prepared; pending third-party execution
- **PENDING_PILOT_EXECUTION** — event log and observer schema ready; pending physical pilot session

| ID     | Requirement                                                      | Existing evidence                                                                                                                                             | Gap                                                                                                      | Implementation work                                                                                                                                              | Verification command                                      | Gate | Status                   |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---- | ------------------------ |
| QA-001 | Format invariant unit tests                                      | `v2-architecture.test.ts`, `gate-c-c4-repository-architecture.test.ts`; `double-elimination-bracket.test.ts`; `qa-001-format-invariants.test.ts`              | None (closed)                                                                                            | Adversarial invalid-graph, fuzz-seed, cycle-detection, impossible-bracket tests added                                                                            | `pnpm test:unit`                                          | D    | SATISFIED                |
| QA-002 | Standings unit tests                                             | Phase 3 integration tests; `qa-002-standings-oracle.test.ts`                                                                                                  | Pilot execution diff verification                                                                        | Independent manual calculation oracle with head-to-head, discipline, seed, and tiebreak chains built; diff tool ready                                            | `pnpm test:unit`                                          | D    | READY_FOR_LOCAL_PILOT    |
| QA-003 | Solver constraint tests                                          | `domain-optimizer.test.ts`, `production-capacity-regression.test.ts`, `qa-012-schedule-matrix.test.ts`                                                        | None (closed)                                                                                            | Expanded to full size matrix: 8, 12, 16, 24, 48 + 11 adversarial solver cases                                                                                    | `pnpm --filter @matchday/scheduler test:unit`             | D    | SATISFIED                |
| QA-004 | API integration tests                                            | 27 integration test files; `phase-7-owasp-top-10.test.ts`; `phase-7-failure-endurance.test.ts`                                                                | Live pilot execution                                                                                     | Failure-mode integration tests: 4xx boundary, 5xx recovery, idempotency duplicate detection, error code contracts                                                | `pnpm test:integration`                                   | D    | READY_FOR_LOCAL_PILOT    |
| QA-005 | Organiser E2E tests                                              | `phase-3-competition-create.spec.ts`, `phase-4-setup-format.spec.ts`, `phase-4-schedule.spec.ts`, `assisted-setup.spec.ts`, `v1-competition-real-api.spec.ts` | Multi-division lifecycle execution in pilot                                                              | Full lifecycle organiser E2E                                                                                                                                     | `pnpm test:e2e`                                           | D    | READY_FOR_LOCAL_PILOT    |
| QA-006 | Scoring E2E tests                                                | `gate-c-c2-scoring.spec.ts`, `gate-c-c2-real.spec.ts`, `scorekeeper-phase0.spec.ts`                                                                           | Multi-round session in live event                                                                        | Scoring day E2E: multi-round, standings visible after each round, correction workflow                                                                            | `pnpm test:e2e`                                           | D    | READY_FOR_LOCAL_PILOT    |
| QA-007 | Offline and reconnection tests                                   | `gate-c-c3-*.test.ts`, `gate-c-c3-offline-ui.test.ts`, `gate-c-c3-real.spec.ts`, `phase-7-failure-endurance.test.ts`                                          | Field pilot device disconnect session                                                                    | Extended offline 2,000-command batch queue and lease expiration fences verified                                                                                  | `pnpm test:integration`                                   | D    | READY_FOR_LOCAL_PILOT    |
| QA-008 | Concurrent device tests                                          | `scoring-access-multi-instance.test.ts`, `gate-c-c5-redis-isolation.test.ts`, `phase-7-failure-endurance.test.ts`                                             | Multi-device field session                                                                               | Monotonic sequence numbers, fencing tokens, and lease takeover arbitration verified                                                                              | `pnpm test:integration`                                   | D    | READY_FOR_LOCAL_PILOT    |
| QA-009 | Correction and conflict tests                                    | `phase-2-correction-pairing.test.ts`, `gate-c-c2-scoring-runtime.test.ts`, `phase-7-failure-endurance.test.ts`                                                | Live event correction drill                                                                              | Correction audit trail preservation and downstream score revisioning verified                                                                                    | `pnpm test:integration`                                   | D    | READY_FOR_LOCAL_PILOT    |
| QA-010 | Load-test public pages                                           | `scripts/run-load-public.ts`                                                                                                                                  | Component-only diagnostics are not Gate D evidence; a real API/PostgreSQL/Redis receipt remains required | Component workload and explicit integration-mode contract retained; public p95 target is `<2.5s`. Note: component/socket-component PASS != Gate D PASS           | `TARGET_URL=... CANDIDATE_SHA=... pnpm test:load:staging` | D    | BLOCKED_EXTERNAL_RECEIPT |
| QA-011 | Load-test scoring writes                                         | `scripts/run-load-scoring.ts`                                                                                                                                 | Component-only diagnostics are not Gate D evidence; a real API/PostgreSQL/Redis receipt remains required | Component workload and explicit integration-mode contract retained; result-propagation p95 target is `<2s`. Note: component/socket-component PASS != Gate D PASS | `TARGET_URL=... CANDIDATE_SHA=... pnpm test:load:staging` | D    | BLOCKED_EXTERNAL_RECEIPT |
| QA-012 | Schedule generation for all supported sizes                      | `domain-optimizer.test.ts`, `production-capacity-regression.test.ts`, `qa-012-schedule-matrix.test.ts`                                                        | None (closed)                                                                                            | Full matrix 8/12/16/24/48 + 11 adversarial solver conditions verified                                                                                            | `pnpm --filter @matchday/scheduler test:unit`             | D    | SATISFIED                |
| QA-013 | Accessibility audit                                              | `phase-2/3/4-accessibility.spec.ts`, `accessibility-gate.test.ts`, `docs/qa/phase-7-accessibility-audit.md`                                                   | Human audit session receipt (tester, browser, device, assistive tech)                                    | WCAG 2.2 AA audit protocol across keyboard, screen readers, focus trapping, and motion preferences                                                               | `pnpm test:a11y` + human audit session receipt            | D    | READY_FOR_LOCAL_PILOT    |
| QA-014 | Security review (OWASP Top 10, CSP, rate limits, token security) | `apps/api/tests/integration/phase-7-owasp-top-10.test.ts`, `scoring-access-rate-limit.test.ts`, `scoring-access-hmac-keyring.test.ts`, `next-config.test.ts`  | Independent penetration test (QA-029)                                                                    | OWASP Top 10 production-path integration tests (SQLi, XSS, IDOR/tenant isolation, HMAC tampering, security headers)                                              | `pnpm test:integration`                                   | D    | READY_FOR_LOCAL_PILOT    |
| QA-015 | Backup restoration test                                          | `pnpm backup:verify` in CI; `BACKUP_RESTORE.md`; `scripts/verify-backup-restore.sh`                                                                           | None (closed)                                                                                            | Complete pg_dump → drop → pg_restore → row count/checksum verification automated in script                                                                       | `pnpm backup:verify` / `verify-backup-restore.sh`         | D    | SATISFIED                |
| QA-016 | Incident response runbook                                        | `docs/runbooks/incident-response.md`                                                                                                                          | Tabletop rehearsal prior to pilot                                                                        | Created S1–S4 severity matrix, detection, triage, containment, escalation, comms, rollback, and postmortem templates                                             | Tabletop exercise record                                  | D    | READY_FOR_LOCAL_PILOT    |
| QA-017 | Event-day support runbook                                        | `docs/runbooks/event-day-support.md`                                                                                                                          | Tabletop rehearsal prior to pilot                                                                        | Created pre-event checklist, organiser onboarding, device replacement, schedule intervention, and offline procedures                                             | Tabletop exercise record                                  | D    | READY_FOR_LOCAL_PILOT    |
| QA-019 | Closed local pilot                                               | `docs/qa/pilots/local-pilot-01/`                                                                                                                              | Execution scheduled                                                                                      | Execution of closed local pilot with real organiser, officials, and physical devices                                                                             | Pilot event log                                           | D    | PENDING_PILOT_EXECUTION  |
| QA-020 | National competition parallel pilot                              | `docs/qa/pilots/national-pilot-01/`                                                                                                                           | Execution scheduled                                                                                      | Execution of national parallel pilot across multiple divisions                                                                                                   | Pilot event log                                           | E    | READY_FOR_NATIONAL_PILOT |
| QA-021 | Compare standings with manual calculations                       | `packages/domain/src/standings-manual-oracle.ts`, `scripts/diff-standings-oracle.ts`, `qa-002-standings-oracle.test.ts`                                       | Live pilot execution diff                                                                                | Independent manual calculation oracle and CLI diff report utility ready to verify standings output during pilots                                                 | `pnpm tsx scripts/diff-standings-oracle.ts`               | D+E  | READY_FOR_LOCAL_PILOT    |
| QA-022 | Record every organiser intervention during pilot                 | `docs/qa/pilots/README.md`, `docs/qa/pilots/local-pilot-01/event-log.csv`, `docs/qa/pilots/national-pilot-01/event-log.csv`                                   | Pilot observer execution                                                                                 | 14-column CSV pilot event log schema and observer instructions established                                                                                       | Pilot event log retained in `docs/qa/pilots/`             | D+E  | READY_FOR_LOCAL_PILOT    |
| QA-023 | Fix all Critical/High pilot defects before sole-source use       | None                                                                                                                                                          | Pending pilot results                                                                                    | Triage and fix loop for any Critical/High defects discovered during pilot runs                                                                                   | `pnpm test:release` on fix SHA                            | D+E  | PENDING_PILOT_EXECUTION  |
| QA-024 | Validate SLO targets against pilot measurements                  | `packages/observability/src/pilot-telemetry.ts`                                                                                                               | Controlled pilot telemetry receipt remains required                                                      | Fail-closed receipt requires exact SHA, competition, time bounds, separate public/result metrics, API error rate, and sessions                                   | Load test suite + pilot telemetry                         | E    | BLOCKED_EXTERNAL_RECEIPT |
| QA-025 | Browser compatibility testing                                    | `phase-3/4-responsive.spec.ts`; Playwright CI (chromium/webkit/firefox)                                                                                       | Physical mobile matrix log                                                                               | Responsive Playwright test coverage across mobile/tablet/desktop Chromium, WebKit, Firefox                                                                       | `pnpm test:e2e`                                           | D    | READY_FOR_LOCAL_PILOT    |
| QA-026 | Low-end device testing (budget Android)                          | None                                                                                                                                                          | Physical hardware session                                                                                | Budget Android device test during local pilot                                                                                                                    | Physical device test log                                  | D    | READY_FOR_LOCAL_PILOT    |
| QA-027 | Legal review (ToS, Privacy, Cookie, data processing)             | `legal-pages.test.ts`; Phase 6 privacy/consent implementation; `apps/web/app/privacy/page.tsx`, `apps/web/app/terms/page.tsx`                                 | External legal counsel signoff (deferred to Gate F per ADR 0003)                                         | Legal documents drafted and wired with consent banner and localized terms                                                                                        | Legal review package                                      | D    | EXTERNAL_PENDING         |
| QA-028 | SEO audit                                                        | `apps/web/app/layout.tsx` metadata; `apps/web/app/sitemap.ts`; `apps/web/app/robots.ts`                                                                       | Deployed crawl receipt                                                                                   | Canonical metadata, OpenGraph tags, dynamic XML sitemap, and robots.txt verified                                                                                 | `pnpm typecheck` + SEO crawl                              | D    | READY_FOR_LOCAL_PILOT    |
| QA-029 | Penetration testing (QR, rate limits, sessions, injection)       | `docs/qa/phase-7-pentest-scope.md`                                                                                                                            | External test execution                                                                                  | Prepared penetration test specification, role matrix, test accounts, rules of engagement, and findings templates                                                 | Pentest report + fix CI evidence                          | E    | EXTERNAL_PENDING         |
| QA-030 | Email deliverability (SPF, DKIM, DMARC, template rendering)      | Phase 6 SMTP configuration; notification integration tests                                                                                                    | DNS record validation in production                                                                      | SMTP client, transactional email templates, and delivery error handlers implemented and unit-tested                                                              | `pnpm test:integration`                                   | D    | READY_FOR_LOCAL_PILOT    |

---

## Sequencing and critical path

```
Phase 6 merge (PR #39)
  └─► create phase-7/release-hardening from merge SHA
        ├─ Step 1: This document (done)
        ├─ Step 2: Coverage audit → docs/qa/phase-7-test-coverage-audit.md
        ├─ Step 3: Canonical test:release suite
        ├─ Step 4: Harden deterministic engines (QA-001–003, QA-012)
        ├─ Step 5: Performance baseline (QA-010, QA-011)
        ├─ Step 6: Endurance/failure testing
        ├─ Step 7: Security review (QA-014)
        ├─ Step 8: Commission pentest (QA-029) ◄── longest lead time, schedule NOW
        ├─ Step 9: Browser/device matrix (QA-025, QA-026)
        ├─ Step 10: Accessibility audit (QA-013)
        ├─ Step 11: Backup restore drill (QA-015)
        ├─ Step 12: Runbooks (QA-016, QA-017)
        ├─ Step 13: Pilot telemetry setup (QA-022)
        ├─ Step 14: Local pilot — Gate D (QA-019, QA-021, QA-022)
        ├─ Step 15: Fix local pilot defects (QA-023)
        ├─ Step 16: Gate D freeze + independent certification
        ├─ Step 17: National pilot — Gate E (QA-020)
        ├─ Step 18: SLO validation (QA-024)
        ├─ Step 19: SEO/email/legal (QA-027, QA-028, QA-030)
        └─ Step 20+21: Gate E freeze + independent certification
```

**Critical path constraint:** the national competition date cannot be compressed. Schedule the pilot slot immediately.

---

## Gate D exit criteria (frozen candidate SHA)

- `test:release` suite green.
- QA-001–009: all automated test expansions pass.
- QA-010, QA-011: component diagnostics only; controlled real-stack integration receipts remain required.
- QA-012: full size matrix + adversarial scheduler tests pass.
- QA-013: WCAG 2.2 AA, zero P0/P1 a11y findings.
- QA-014: zero unresolved Critical/High security findings.
- QA-015: backup restore drill complete; data integrity verified.
- QA-016, QA-017: runbooks written and tabletop-tested.
- QA-019: local pilot complete; no Critical/High open.
- QA-021: standings match oracle at local pilot.
- QA-022: all organiser interventions recorded.
- QA-023: all Critical/High pilot defects resolved.
- QA-025: browser/device matrix passes for all required environments.
- QA-026: budget Android scorekeeper test passes.
- Independent reviewer verdict: **PASS** (no `PASS WITH FOLLOW-UP`).

## Gate E exit criteria (separate frozen candidate SHA)

All Gate D criteria still satisfied, plus:

- QA-020: national parallel pilot complete; no Critical/High open.
- QA-021, QA-022: oracle match and intervention records from national pilot.
- QA-024: SLO measurement report retained; targets confirmed or adjusted.
- QA-029: penetration test complete; all Critical/High findings resolved.
- QA-027, QA-028, QA-030: legal review package, SEO audit, email deliverability clean.
- Independent reviewer verdict: **PASS**.

---

## External scheduling items (action required)

| Item                                      | Owner                              | Required by       |
| ----------------------------------------- | ---------------------------------- | ----------------- |
| National competition parallel pilot slot  | Competition organiser / federation | Gate E            |
| Independent penetration tester engagement | External security firm             | Gate E            |
| Local pilot event slot + participants     | Design partners / closed group     | Gate D            |
| Physical budget Android device            | Engineering                        | Gate D            |
| Legal/privacy formal authorised approval  | Legal counsel                      | Gate F (ADR 0003) |
