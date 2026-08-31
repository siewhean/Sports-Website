# Phase 7 — Test Coverage Audit

**Purpose:** Inventory all existing automated test coverage against QA-001–017, QA-019–030 to identify what Phase 7 must add versus what already exists.

**Reference baseline:** `phase-6/commercial-operations` head at time of audit (2026-08-31)

**Audit date:** 2026-08-31

---

## Coverage matrix by QA area

### QA-001 Format invariants

| Coverage dimension     | Existing files                                                                                               | Assessment  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ----------- |
| Happy path             | `v2-architecture.test.ts`, `gate-c-c4-repository-architecture.test.ts`, `double-elimination-bracket.test.ts` | Strong      |
| Boundary cases         | `double-elimination-bracket.test.ts` (2/8/12/16/24/48 entries)                                               | Strong      |
| Invalid input          | `v2-architecture.test.ts` (null paths)                                                                       | Partial     |
| Authorization          | `gate-c-access-*.test.ts`                                                                                    | Strong      |
| Concurrency            | `gate-c-c5-lifecycle.test.ts`                                                                                | Partial     |
| Idempotency            | Covered in format revision architecture                                                                      | Partial     |
| Failure/retry          | Not covered                                                                                                  | **Missing** |
| Adversarial graph/fuzz | Not covered                                                                                                  | **Missing** |
| Cycle-detection        | Not covered                                                                                                  | **Missing** |

**Phase 7 additions required:** Adversarial invalid-graph mutations, fuzz-seed corpus, cycle-detection assertion, impossible-bracket rejection.

---

### QA-002 Standings

| Coverage dimension               | Existing files                                                            | Assessment  |
| -------------------------------- | ------------------------------------------------------------------------- | ----------- |
| Happy path                       | `phase-3-runtime.test.ts` (integration), `phase-2-vertical-slice.spec.ts` | Strong      |
| Head-to-head tiebreak            | Phase 3 integration                                                       | Partial     |
| Withdrawal + advancement         | `phase-3-states.spec.ts`                                                  | Partial     |
| Oracle cross-check               | None                                                                      | **Missing** |
| Boundary (single-entry division) | Not explicitly covered                                                    | **Missing** |

**Phase 7 additions required:** Independent oracle implementation; diff against production standings at every pilot checkpoint.

---

### QA-003 Solver constraints (QA-012 overlap)

| Coverage dimension          | Existing files                                              | Assessment  |
| --------------------------- | ----------------------------------------------------------- | ----------- |
| 8-entry schedule            | `production-capacity-regression.test.ts`                    | Strong      |
| 16-entry schedule           | `production-capacity-regression.test.ts`                    | Strong      |
| 24-entry schedule           | `domain-optimizer.test.ts`                                  | Strong      |
| 36-entry schedule           | `production-capacity-regression.test.ts` (exactly 36 slots) | Strong      |
| 12-entry schedule           | Not explicit                                                | **Missing** |
| 48-entry schedule           | Not explicit                                                | **Missing** |
| Byes                        | Not covered                                                 | **Missing** |
| Withdrawals mid-solve       | Not covered                                                 | **Missing** |
| Impossible capacity         | Not covered                                                 | **Missing** |
| Locked matches              | Not covered                                                 | **Missing** |
| Dependent matches           | Not covered                                                 | **Missing** |
| Schedule repair             | `phase-4-gate-c-c4-repairs.spec.ts` (UI only)               | Partial     |
| Cross-division shared areas | Not covered                                                 | **Missing** |
| Cancellation mid-solve      | Not covered                                                 | **Missing** |
| Deterministic repeatability | Not covered                                                 | **Missing** |
| Endurance (long runs)       | Not covered                                                 | **Missing** |

**Phase 7 additions required:** Full 8/12/16/24/48 matrix; all adversarial cases above.

---

### QA-004 API integration

| Coverage dimension                                   | Existing files                                                  | Assessment |
| ---------------------------------------------------- | --------------------------------------------------------------- | ---------- |
| Happy path                                           | 27 integration test files; Phase 2–6 routes                     | Strong     |
| 4xx boundary (malformed input)                       | Partial in some route tests                                     | Partial    |
| 5xx recovery                                         | `gate-c-c3-proxy-faults.test.ts`                                | Partial    |
| Idempotency duplicates                               | `phase-6-commercial-operations.test.ts` (billing)               | Partial    |
| Rate-limit enforcement                               | `scoring-access-rate-limit.test.ts`, `rate-limit-redis.test.ts` | Strong     |
| Authorization (cross-org isolation)                  | `gate-c-access-collision.test.ts`                               | Strong     |
| Concurrent mutation races                            | `scoring-access-multi-instance.test.ts`                         | Partial    |
| Quota exhaustion edge paths                          | Phase 6 AI allowance tests                                      | Partial    |
| Abuse scenarios (oversized payloads, malicious JSON) | `deployed-surface-hardening.test.ts`                            | Partial    |

**Phase 7 additions required:** Systematic 4xx boundary for all Phase 4–6 routes; additional abuse scenarios; AI quota exhaustion corner cases.

---

### QA-005 Organiser E2E

| Coverage dimension                                      | Existing files                                                              | Assessment  |
| ------------------------------------------------------- | --------------------------------------------------------------------------- | ----------- |
| Competition creation                                    | `phase-3-competition-create.spec.ts`, `v1-competition-create-draft.spec.ts` | Strong      |
| Format design                                           | `phase-4-setup-format.spec.ts`, `format-designer-interactions.spec.ts`      | Strong      |
| Schedule generation                                     | `phase-4-schedule.spec.ts`                                                  | Strong      |
| Assisted setup                                          | `assisted-setup.spec.ts`                                                    | Strong      |
| Schedule publish                                        | `v1-publish-production.spec.ts`                                             | Strong      |
| Full lifecycle (create→publish→score→correct→republish) | Not in a single test                                                        | **Missing** |
| Multi-division competition                              | Not covered                                                                 | **Missing** |
| Organiser corrections after scoring                     | Scattered across specs                                                      | Partial     |

**Phase 7 additions required:** Single full-lifecycle E2E; multi-division scenario.

---

### QA-006 Scoring E2E

| Coverage dimension                 | Existing files                                        | Assessment  |
| ---------------------------------- | ----------------------------------------------------- | ----------- |
| QR code access                     | `gate-c-access-real.spec.ts`                          | Strong      |
| Score entry                        | `gate-c-c2-scoring.spec.ts`, `gate-c-c2-real.spec.ts` | Strong      |
| Scorekeeper UI                     | `scorekeeper-phase0.spec.ts`                          | Strong      |
| Multi-round tournament session     | Not covered                                           | **Missing** |
| Standings visible after each round | Not covered                                           | **Missing** |
| Long event-day session (hours)     | Not covered                                           | **Missing** |
| Correction mid-event               | `phase-2-correction-pairing.test.ts` (unit)           | Partial     |

**Phase 7 additions required:** Multi-round tournament E2E; long session test.

---

### QA-007 Offline and reconnection

| Coverage dimension                | Existing files                                           | Assessment  |
| --------------------------------- | -------------------------------------------------------- | ----------- |
| Basic offline score queuing       | `gate-c-c3-offline-ui.test.ts`, `gate-c-c3-real.spec.ts` | Strong      |
| Reconnect and replay              | `gate-c-c3-*.test.ts` (fence/proxy-faults)               | Strong      |
| Service worker registration       | `service-worker-registration.test.ts`                    | Strong      |
| Extended offline endurance        | Not covered                                              | **Missing** |
| Device-loss mid-score             | Not covered                                              | **Missing** |
| Dual-device conflict on reconnect | Not covered                                              | **Missing** |

**Phase 7 additions required:** Extended offline endurance test; device-loss recovery; dual-device conflict resolution.

---

### QA-008 Concurrent devices

| Coverage dimension                          | Existing files                          | Assessment  |
| ------------------------------------------- | --------------------------------------- | ----------- |
| Two-device isolation                        | `scoring-access-multi-instance.test.ts` | Strong      |
| Redis isolation                             | `gate-c-c5-redis-isolation.test.ts`     | Strong      |
| 5+ concurrent devices                       | Not covered                             | **Missing** |
| Standings consistency post-concurrent-score | Not covered                             | **Missing** |

**Phase 7 additions required:** 5-device concurrent scoring; standings consistency assertion.

---

### QA-009 Corrections and conflicts

| Coverage dimension                              | Existing files                                | Assessment  |
| ----------------------------------------------- | --------------------------------------------- | ----------- |
| Score correction                                | `phase-2-correction-pairing.test.ts`          | Strong      |
| Correction during active scoring                | Not covered                                   | **Missing** |
| Downstream standings recompute after correction | Not covered                                   | **Missing** |
| Public result update after correction           | `gate-c-c5-public-result-convergence.test.ts` | Strong      |

**Phase 7 additions required:** Correction-during-active-scoring; standings-recompute integration.

---

### QA-010 Load: public pages

| Coverage dimension          | Existing | Assessment  |
| --------------------------- | -------- | ----------- |
| Any load workload           | None     | **Missing** |
| p50/p95/p99 baseline        | None     | **Missing** |
| Error rate at 1×/2×/5× load | None     | **Missing** |

**Phase 7 additions required:** Full k6/autocannon load suite with defined workload scenarios.

---

### QA-011 Load: scoring writes

| Coverage dimension            | Existing                   | Assessment  |
| ----------------------------- | -------------------------- | ----------- |
| Rate-limit enforcement (unit) | `rate-limit-redis.test.ts` | Partial     |
| Throughput measurement        | None                       | **Missing** |
| Concurrent write p95          | None                       | **Missing** |

**Phase 7 additions required:** Scoring-write load suite capturing throughput and latency.

---

### QA-012 Schedule generation for all sizes

See QA-003 above — same gap analysis applies.

---

### QA-013 Accessibility

| Coverage dimension               | Existing files                                                    | Assessment  |
| -------------------------------- | ----------------------------------------------------------------- | ----------- |
| Automated axe-core checks        | `phase-2/3/4-accessibility.spec.ts`, `accessibility-gate.test.ts` | Strong      |
| Keyboard-only navigation (human) | Not done                                                          | **Missing** |
| Screen reader (human)            | Not done                                                          | **Missing** |
| Focus order                      | Not explicitly checked                                            | Partial     |
| Large scoring targets            | Not checked                                                       | **Missing** |
| Bracket/table a11y               | Not explicitly checked                                            | Partial     |
| Reduced-motion                   | Not checked                                                       | **Missing** |
| Modal focus trapping             | Not checked                                                       | **Missing** |
| WCAG 2.2 AA full audit           | Not done                                                          | **Missing** |

**Phase 7 additions required:** Full human WCAG 2.2 AA audit; specific checks for keyboard, screen reader, reduced-motion.

---

### QA-014 Security review

| Coverage dimension             | Existing files                                                                 | Assessment  |
| ------------------------------ | ------------------------------------------------------------------------------ | ----------- |
| CSP headers                    | `next-config.test.ts`, `deployed-surface-hardening.test.ts`                    | Strong      |
| Rate limiting                  | `scoring-access-rate-limit.test.ts`, `rate-limit-redis.test.ts`                | Strong      |
| HMAC token security            | `scoring-access-hmac-keyring.test.ts`, `scoring-fallback-hmac-keyring.test.ts` | Strong      |
| OWASP Top 10 structured review | None                                                                           | **Missing** |
| SQL injection                  | Not tested                                                                     | **Missing** |
| XSS (stored/reflected)         | Not tested                                                                     | **Missing** |
| Session fixation/CSRF          | Not tested                                                                     | **Missing** |
| Billing webhook forgery        | Not tested                                                                     | **Missing** |
| IDOR attempts                  | Not tested                                                                     | **Missing** |
| Entitlement escalation         | `phase-6-effective-entry-entitlements.test.ts` (partial)                       | Partial     |

**Phase 7 additions required:** Structured OWASP Top 10 review; injection tests; session security tests; billing webhook forgery tests.

---

### QA-015 Backup restoration

| Coverage dimension                                        | Existing                  | Assessment  |
| --------------------------------------------------------- | ------------------------- | ----------- |
| `backup:verify` in CI                                     | `integration` job runs it | Strong      |
| `BACKUP_RESTORE.md` operational doc                       | Exists in repo            | Strong      |
| Full populate → backup → destroy → restore → verify drill | Not done                  | **Missing** |
| RTO/RPO measurement                                       | Not done                  | **Missing** |

**Phase 7 additions required:** Full restore drill with data integrity verification; measure duration.

---

### QA-016 Incident response runbook

| Existing | Assessment  |
| -------- | ----------- |
| None     | **Missing** |

---

### QA-017 Event-day support runbook

| Existing | Assessment  |
| -------- | ----------- |
| None     | **Missing** |

---

### QA-019–QA-023 Pilots

All pilot work is Missing — no pilot has been run.

---

### QA-024 SLO validation

Missing — no load baseline exists yet.

---

### QA-025 Browser compatibility

| Coverage dimension              | Existing           | Assessment  |
| ------------------------------- | ------------------ | ----------- |
| Chromium (Playwright)           | CI browser-e2e job | Strong      |
| WebKit/Safari (Playwright)      | CI browser-e2e job | Strong      |
| Firefox (Playwright)            | CI browser-e2e job | Strong      |
| Edge                            | Not in CI          | **Missing** |
| Mobile Safari physical device   | Not tested         | **Missing** |
| Chrome Android physical device  | Not tested         | **Missing** |
| "Latest two versions" matrix    | Not formalized     | Partial     |
| Three-role scenario per browser | Not formalized     | Partial     |

---

### QA-026 Budget Android

Missing — no physical device test done.

---

### QA-027 Legal review

| Existing                                  | Assessment          |
| ----------------------------------------- | ------------------- |
| `legal-pages.test.ts` (page existence)    | Partial             |
| Phase 6 privacy/consent UI                | Partial             |
| Formal legal review / authorised approval | Not done (ADR 0003) | Partial |

---

### QA-028 SEO audit

| Existing                                 | Assessment             |
| ---------------------------------------- | ---------------------- |
| `public-pages-seo.test.ts`               | Partial                |
| Canonical URLs, metadata automated check | Partial                |
| Structured data validation               | Not done               | **Missing** |
| OpenGraph check                          | Not done               | **Missing** |
| Crawlability (robots.txt, sitemap)       | Not explicitly checked | **Missing** |

---

### QA-029 Penetration testing

Missing — external engagement not scheduled.

---

### QA-030 Email deliverability

| Existing                                | Assessment |
| --------------------------------------- | ---------- |
| Phase 6 SMTP provider config            | Partial    |
| Notification integration tests          | Partial    |
| SPF/DKIM/DMARC DNS validation           | Not in CI  | **Missing** |
| Template rendering across email clients | Not done   | **Missing** |

---

## Summary by gate

### Ready to start immediately (preparation-only, no Phase 6 branch needed)

- Coverage audit (this document)
- Implementation plan (done)
- Runbook drafts (QA-016, QA-017)
- Load test workload design (QA-010, QA-011)
- Security test plan (QA-014)
- Penetration test tester package (QA-029)
- Pilot event log schema (QA-022)

### Requires Phase 7 branch (after Phase 6 merge)

- All code and test additions
- `test:release` canonical suite
- Scheduler adversarial matrix (QA-003, QA-012)
- Standings oracle (QA-002, QA-021)
- API integration expansions (QA-004)
- E2E lifecycle tests (QA-005, QA-006, QA-007, QA-008, QA-009)
- Load test suites (QA-010, QA-011)
- Backup restore drill (QA-015)

### Requires pilot scheduling (long lead time)

- QA-019: local pilot
- QA-020: national competition
- QA-029: penetration test
- QA-026: budget Android device procurement
