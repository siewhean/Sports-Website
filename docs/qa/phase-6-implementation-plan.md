# Phase 6 — Commercial and Operational Completeness: Closure Plan

**Status:** IN PROGRESS — NOT CERTIFIED

**Branch:** `phase-6/commercial-operations`

**Base:** `integration/gate-c-final`

**Gate rule:** Gates D and E must not begin until Phase 6 has an independent `PASS`.

## 1. Purpose

Finish the exact Phase 6 scope from `docs/EXECUTION_ROADMAP.md` without reopening
certified Gate C behaviour or mixing pilot work into this branch.

Phase 6 scope:

- `FMT-004`
- `AI-007–009`, `AI-016–017`
- `RES-021`, `RES-025–032`
- `BIL-001–014`
- `EXP-003–006`
- `ADM-001–007`

The source descriptions in `sports_competition_platform_implementation_plan.md`
remain authoritative. This document owns execution order and closure evidence.

## 2. Standing implementation rules

1. Keep one logical requirement slice per commit.
2. Reuse existing functionality instead of rebuilding it.
3. Preserve Gate C semantics and evidence. A Gate C regression is a blocker.
4. AI may propose schema-validated changes only. Deterministic code stays authoritative.
5. Billing mutations must be idempotent, audited, and reconciliation-safe.
6. AI or billing degradation must not block manual event operation.
7. Support tools must be least-privilege and fully audited.
8. Public privacy and referee visibility default to the stricter state.
9. Required CI, browser, accessibility, visual, migration, backup, OpenAPI,
   dependency, and secret checks may not be skipped at certification.
10. Gate D/E code and Phase 7 pilot work stay out of this branch until Phase 6 closes.

## 3. Current baseline

The branch includes the merged Gate C CI repairs from PR #40. The inherited
PostgreSQL JSONB assertion and pre-Playwright asset-origin verifier defects are
therefore baseline-fixed.

`FMT-004` already has a candidate deterministic double-elimination domain
implementation with:

- upper and lower brackets for entry counts of at least two;
- `2N-2` always-materialised matches;
- an explicit if-required reset final outside the always-materialised graph;
- structural `FormatGraph` validation;
- boundary and default-size tests for 2, 8, 12, 16, 24, and 48 entries.

It is not closed until the normal recommendation, persistence, scheduling,
results, public, and export paths are proven compatible.

## 4. Requirement status

Status meanings:

- **Candidate:** implementation exists but closure evidence is incomplete.
- **Audit:** inspect current code first because an earlier phase may already satisfy it.
- **Pending:** implementation remains after audit.
- **Closed:** implementation and evidence are complete on the Phase 6 candidate SHA.

### Format

- `FMT-004` — double elimination — **Candidate**

### AI

- `AI-007` — natural-language format modifications — **Audit**
- `AI-008` — natural-language schedule preferences — **Audit**
- `AI-009` — affected-match recovery recommendations — **Audit**
- `AI-016` — prompt and model-version tracking — **Audit**
- `AI-017` — AI cost and latency monitoring — **Audit**

### Public and results

- `RES-021` — possible future matches — **Audit**
- `RES-025` — referee-name visibility control — **Audit**
- `RES-026` — SEO metadata on all public pages — **Audit**
- `RES-027` — 404, 403, 410, 500, 503, and offline error states — **Audit**
- `RES-028` — organiser and official onboarding — **Audit**
- `RES-029` — marketing home, features, pricing, help, and contact — **Audit**
- `RES-030` — Terms, Privacy Policy, and Cookie Policy — **Audit**
- `RES-031` — cookie consent — **Audit**
- `RES-032` — notification bell and read/unread list — **Audit**

### Billing and entitlements

- `BIL-001` — entitlement service — **Audit**
- `BIL-002` — free 16-entry entitlement — **Audit**
- `BIL-003` — free AI allowance — **Audit**
- `BIL-004` — Event Pass — **Audit**
- `BIL-005` — Organiser Pro — **Audit**
- `BIL-006` — AI top-up purchase — **Audit**
- `BIL-007` — billing webhook idempotency — **Audit**
- `BIL-008` — usage ledger — **Audit**
- `BIL-009` — AI usage page — **Audit**
- `BIL-010` — upgrade and top-up flows — **Audit**
- `BIL-011` — AI exhaustion never blocks manual operation — **Audit**
- `BIL-012` — paid branding controls — **Audit**
- `BIL-013` — sponsor placement controls — **Audit**
- `BIL-014` — receipts and billing history — **Audit**

### Exports

- `EXP-003` — tables and brackets — **Audit**
- `EXP-004` — entries and results CSV — **Audit**
- `EXP-005` — audit history — **Audit**
- `EXP-006` — full competition JSON — **Audit**

### Administration and support

- `ADM-001` — support dashboard — **Audit**
- `ADM-002` — competition lookup — **Audit**
- `ADM-003` — read-only audit investigation — **Audit**
- `ADM-004` — access-pass revocation — **Audit**
- `ADM-005` — sport-default version administration — **Audit**
- `ADM-006` — AI usage and failure review — **Audit**
- `ADM-007` — audit support changes — **Audit**

## 5. Dependency-aware execution order

### P6-0 — Restore a fully green branch baseline

1. Classify the current `pnpm test:e2e` failure.
2. Fix only confirmed defects; rerun suspected flakes without speculative changes.
3. Require browser E2E, accessibility, and visual lanes to execute successfully.

**Exit:** all standard CI jobs green on one unchanged SHA.

### P6-1 — Close FMT-004 end to end

1. Audit recommendation, persistence, materialisation, scheduling, result,
   public-bracket, and export paths.
2. Integrate double elimination anywhere the normal product path requires it.
3. Prove the reset final cannot be scheduled early.
4. Create the reset only when grand-final-one gives the upper-bracket champion a
   first loss.
5. Add product-level tests in addition to package-level graph tests.

**Exit:** `FMT-004` is Closed with full CI green.

### P6-2 — Commercial foundation

Implement or audit in this order:

1. `BIL-001` entitlement service.
2. `BIL-008` idempotent usage ledger.
3. `BIL-007` webhook and reconciliation boundary.
4. `BIL-002–006` entitlements and credits.
5. `BIL-011` manual-operation invariant.
6. `BIL-009`, `BIL-010`, and `BIL-014` customer flows and history.
7. `BIL-012–013` branding and sponsor controls.

No UI may be the sole enforcement point.

### P6-3 — AI completeness

Close `AI-016` and `AI-017` metadata and monitoring first. Then close `AI-007–009`
through deterministic proposal contracts that reuse existing validation,
accounting, retry, audit, cache, and manual-fallback infrastructure.

### P6-4 — Public and result completeness

Close `RES-021`, then privacy and visibility, SEO and resilient error states,
onboarding, marketing, legal/consent, and notifications.

Implementation does not substitute for the required legal and privacy review.

### P6-5 — Exports

Close `EXP-003–006` on authoritative versioned data. `EXP-006` requires a
versioned JSON contract and export/re-import equivalence test.

### P6-6 — Administration and support

Close `ADM-001–007` with least privilege and complete support-action auditing.
Support tooling must not create a silent second result-authority path.

### P6-7 — Exact-SHA certification

Freeze one candidate SHA and require:

- secrets scan and production dependency audit;
- format, lint, typecheck, and unit/property tests;
- migration check and backup/restore verification;
- real PostgreSQL/Redis integration and fixture validation;
- OpenAPI generation/check;
- production build, deployment manifest, and asset-origin verification;
- browser E2E, accessibility, and visual suites with no required skips;
- entitlement-bypass and billing webhook replay tests;
- billing ledger reconciliation and support-adjustment evidence;
- AI exhaustion, degraded-provider, and manual-fallback E2E;
- full JSON export/re-import equivalence;
- privacy, consent, and SEO tests;
- email infrastructure and deliverability evidence;
- legal, privacy, and accessibility review receipts;
- independent QA/QC review.

## 6. Phase 6 exit gate

Phase 6 is complete only when all of these are true:

- [ ] Every Phase 6 requirement is Closed or explicitly superseded by an approved
      decision record that preserves the roadmap contract.
- [ ] No unresolved P0 or P1 defect remains.
- [ ] Standard CI is fully green with no required browser, accessibility, or visual skip.
- [ ] Gate C seal and evidence checks remain green.
- [ ] Billing bypass, replay, reconciliation, and support-adjustment evidence passes.
- [ ] AI exhaustion, degradation, and manual fallback evidence passes.
- [ ] Full competition JSON export/re-import equivalence passes.
- [ ] Legal, privacy, SEO, email-deliverability, and accessibility reviews pass.
- [ ] Exact source SHA and retained evidence artifacts are recorded.
- [ ] Independent QA/QC verdict is exactly `PASS`.
- [ ] PR #39 is review-ready, has no unresolved required review threads, and is
      merged using the selected evidence-preserving procedure.

## 7. Gate D/E entry lock

Until every Phase 6 exit item is checked:

- do not create Gate D or Gate E implementation branches from an uncertified head;
- do not mix pilot-specific concessions into Phase 6;
- do not claim local or national pilot readiness;
- do not use a Phase 7 test as a substitute for missing Phase 6 evidence.

After Phase 6 receives its independent `PASS`, Gate D starts as its own local-pilot
candidate. Gate E follows only after Gate D closes. Each gate gets a separate
source SHA, evidence set, defect record, and independent verdict.
