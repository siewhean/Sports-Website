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

- **SATISFIED** — prior phases produced sufficient evidence; Phase 7 must recertify at the final SHA
- **PARTIAL** — coverage exists but gaps remain
- **MISSING** — no substantive coverage yet; Phase 7 must build it
- **EXTERNAL** — depends on third parties; timeline must be managed

| ID     | Requirement                                                      | Existing evidence                                                                                                                                             | Gap                                                                                                                                                                                 | Implementation work                                                                                                                                    | Verification command                                            | Gate | Status   |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ---- | -------- |
| QA-001 | Format invariant unit tests                                      | `v2-architecture.test.ts`, `gate-c-c4-repository-architecture.test.ts`; `double-elimination-bracket.test.ts`                                                  | No adversarial graph/fuzz; no FMT-family edge-case matrix                                                                                                                           | Add adversarial invalid-graph, fuzz-seed, cycle-detection, impossible-bracket tests                                                                    | `pnpm test:unit`                                                | D    | PARTIAL  |
| QA-002 | Standings unit tests                                             | Phase 3 integration tests cover standing computation                                                                                                          | No cross-check against independent oracle; no withdrawal+advancement edge cases                                                                                                     | Build secondary manual-oracle standings calculator; diff against production output                                                                     | `pnpm test:unit`                                                | D    | PARTIAL  |
| QA-003 | Solver constraint tests                                          | `domain-optimizer.test.ts` (10 tests); `production-capacity-regression.test.ts` (2 tests)                                                                     | No endurance; no 12-entry explicit test; no adversarial (byes, withdrawals, impossible-capacity, dependent-match chains)                                                            | Expand to full size matrix: 8, 12, 16, 24, 48 + adversarial cases                                                                                      | `pnpm --filter @matchday/scheduler test:unit`                   | D    | PARTIAL  |
| QA-004 | API integration tests                                            | 27 integration test files covering Phase 2–6 flows                                                                                                            | No abuse/failure scenarios; no concurrent mutation races at load                                                                                                                    | Add failure-mode integration tests: 4xx boundary, 5xx recovery, idempotency duplicates, race-condition guards                                          | `pnpm test:integration`                                         | D    | PARTIAL  |
| QA-005 | Organiser E2E tests                                              | `phase-3-competition-create.spec.ts`, `phase-4-setup-format.spec.ts`, `phase-4-schedule.spec.ts`, `assisted-setup.spec.ts`, `v1-competition-real-api.spec.ts` | No full lifecycle (create → schedule → publish → correct → republish); no multi-division                                                                                            | Add full lifecycle organiser E2E                                                                                                                       | `pnpm test:e2e`                                                 | D    | PARTIAL  |
| QA-006 | Scoring E2E tests                                                | `gate-c-c2-scoring.spec.ts`, `gate-c-c2-real.spec.ts`, `scorekeeper-phase0.spec.ts`                                                                           | No long event-day session; no multi-round tournament with standings refresh                                                                                                         | Add scoring day E2E: multi-round, standings visible after each round, correction workflow                                                              | `pnpm test:e2e`                                                 | D    | PARTIAL  |
| QA-007 | Offline and reconnection tests                                   | `gate-c-c3-*.test.ts`, `gate-c-c3-offline-ui.test.ts`, `gate-c-c3-real.spec.ts`                                                                               | No extended offline endurance; no device-loss mid-score; no dual-device conflict on reconnect                                                                                       | Add: extended offline replay, reconnect-after-loss, conflict-resolution tests                                                                          | `pnpm test:integration` + `pnpm test:e2e`                       | D    | PARTIAL  |
| QA-008 | Concurrent device tests                                          | `scoring-access-multi-instance.test.ts`, `gate-c-c5-redis-isolation.test.ts`                                                                                  | No pilot-scale (5+ concurrent devices); no standings consistency assertion post-concurrent-score                                                                                    | Add 5-device concurrent scoring scenario; standings consistency assertion                                                                              | `pnpm test:integration`                                         | D    | PARTIAL  |
| QA-009 | Correction and conflict tests                                    | `phase-2-correction-pairing.test.ts`, `gate-c-c2-scoring-runtime.test.ts`                                                                                     | No downstream standing-change verification; no correction during active scoring                                                                                                     | Add correction → standings-recompute; correction while actively scoring                                                                                | `pnpm test:integration`                                         | D    | PARTIAL  |
| QA-010 | Load-test public pages                                           | None                                                                                                                                                          | No load workload; no baseline measurements                                                                                                                                          | Build k6/autocannon workload: competition, schedule, standings, brackets, search, result refresh. Capture p50/p95/p99                                  | `pnpm test:load:public` (to create)                             | D    | MISSING  |
| QA-011 | Load-test scoring writes                                         | `rate-limit-redis.test.ts` (unit-level only)                                                                                                                  | No concurrent write throughput measurements                                                                                                                                         | Build scoring-write load workload: concurrent writes, finalisation, standings recompute                                                                | `pnpm test:load:scoring` (to create)                            | D    | MISSING  |
| QA-012 | Schedule generation for all supported sizes                      | `domain-optimizer.test.ts`, `production-capacity-regression.test.ts`                                                                                          | Missing explicit 12-entry test; no adversarial: byes, withdrawals, locked matches, impossible-capacity, repair, cross-division, cancellation mid-solve, deterministic-repeatability | Full matrix 8/12/16/24/48 + adversarial expansion                                                                                                      | `pnpm --filter @matchday/scheduler test:unit`                   | D    | PARTIAL  |
| QA-013 | Accessibility audit                                              | `phase-2/3/4-accessibility.spec.ts`, `accessibility-gate.test.ts`                                                                                             | No keyboard-only human audit; no screen reader test; no large scoring target check; no reduced-motion check                                                                         | Manual WCAG 2.2 AA audit across all flows; retain human + automated evidence                                                                           | `pnpm test:a11y` + manual audit report                          | D    | PARTIAL  |
| QA-014 | Security review (OWASP Top 10, CSP, rate limits, token security) | `scoring-access-rate-limit.test.ts`, `scoring-access-hmac-keyring.test.ts`, `deployed-surface-hardening.test.ts`, `next-config.test.ts` (CSP)                 | No structured OWASP review; no injection tests; no session-fixation/CSRF; no billing-webhook forgery test                                                                           | Create structured security test plan; execute OWASP Top 10 checklist; document every finding                                                           | `pnpm test:integration` (security suites) + audit               | D    | PARTIAL  |
| QA-015 | Backup restoration test                                          | `pnpm backup:verify` in CI; `BACKUP_RESTORE.md`                                                                                                               | No full end-to-end: populate → backup → destroy → restore → verify-integrity drill                                                                                                  | Execute restore drill; measure RTO/RPO                                                                                                                 | `pnpm backup:verify` + manual restore log                       | D    | PARTIAL  |
| QA-016 | Incident response runbook                                        | None                                                                                                                                                          | Does not exist                                                                                                                                                                      | Create `docs/runbooks/incident-response.md` (S1–S4, detection, triage, containment, escalation, comms, rollback, postmortem). Tabletop-test.           | Tabletop exercise record                                        | D    | MISSING  |
| QA-017 | Event-day support runbook                                        | None                                                                                                                                                          | Does not exist                                                                                                                                                                      | Create `docs/runbooks/event-day-support.md`. Tabletop-test.                                                                                            | Tabletop exercise record                                        | D    | MISSING  |
| QA-019 | Closed local pilot                                               | None                                                                                                                                                          | Pilot not run                                                                                                                                                                       | Plan and execute closed local pilot: real organiser, officials, physical devices; Matchday + manual process in parallel                                | Pilot event log                                                 | D    | MISSING  |
| QA-020 | National competition parallel pilot                              | None                                                                                                                                                          | Pilot not run                                                                                                                                                                       | Run national competition with Matchday in parallel; multiple divisions, significant public traffic, multiple officials                                 | Pilot event log                                                 | E    | MISSING  |
| QA-021 | Compare standings with manual calculations                       | None                                                                                                                                                          | No oracle implementation                                                                                                                                                            | Build independent standings oracle (ties to QA-002); compare during both pilots                                                                        | Oracle diff report                                              | D+E  | MISSING  |
| QA-022 | Record every organiser intervention during pilot                 | None                                                                                                                                                          | No pilot event log schema                                                                                                                                                           | Create event log schema; instrument API + observer process                                                                                             | Pilot event log retained in `docs/qa/pilots/`                   | D+E  | MISSING  |
| QA-023 | Fix all Critical/High pilot defects before sole-source use       | None                                                                                                                                                          | No pilot results yet                                                                                                                                                                | For each Critical/High: regression test → fix → CI → pilot re-verify                                                                                   | `pnpm test:release` on fix SHA                                  | D+E  | MISSING  |
| QA-024 | Validate SLO targets against pilot measurements                  | None                                                                                                                                                          | No load baseline                                                                                                                                                                    | Compare actuals vs targets (API 99.9%, score write p95 <500 ms, public p95 <2.5 s, realtime p95 <2 s, job start p95 <5 s). Adjust if reality diverges. | Load test suite + pilot telemetry                               | E    | MISSING  |
| QA-025 | Browser compatibility testing                                    | `phase-3/4-responsive.spec.ts`; Playwright CI (chromium/webkit/firefox)                                                                                       | No Edge; no Mobile Safari physical; no Chrome Android physical; no "latest two versions" matrix                                                                                     | Create device matrix; run three roles per environment                                                                                                  | `pnpm test:e2e` + device matrix log                             | D    | PARTIAL  |
| QA-026 | Low-end device testing (budget Android)                          | None                                                                                                                                                          | No physical budget Android test                                                                                                                                                     | Procure budget Android; run scorekeeper flow; document result                                                                                          | Physical device test log                                        | D    | MISSING  |
| QA-027 | Legal review (ToS, Privacy, Cookie, data processing)             | `legal-pages.test.ts`; Phase 6 privacy/consent implementation                                                                                                 | No formal legal review; ADR 0003 defers formal approval to Gate F                                                                                                                   | Begin review package: ToS, Privacy Policy, Cookie Policy, DPA. Commission legal review.                                                                | Legal review package + findings log                             | D    | PARTIAL  |
| QA-028 | SEO audit                                                        | `public-pages-seo.test.ts`                                                                                                                                    | No structured crawl; no structured data validation; no OpenGraph check                                                                                                              | Full SEO audit: canonical URLs, metadata, sitemap, robots.txt, structured data, OG, crawlability                                                       | `pnpm test:unit` (SEO) + audit tool report                      | D    | PARTIAL  |
| QA-029 | Penetration testing (QR, rate limits, sessions, injection)       | None (external)                                                                                                                                               | Not scheduled                                                                                                                                                                       | Prepare tester package; commission independent pentest; close all Critical/High findings                                                               | Pentest report + fix CI evidence                                | E    | EXTERNAL |
| QA-030 | Email deliverability (SPF, DKIM, DMARC, template rendering)      | Phase 6 SMTP configuration; notification integration tests                                                                                                    | No DNS record validation in CI; no template rendering check across email clients                                                                                                    | Validate DNS records; run Mail Tester / Litmus; fix any failures                                                                                       | `pnpm test:integration` (notifications) + deliverability report | D    | PARTIAL  |

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
- QA-010, QA-011: load baselines captured; targets met.
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
