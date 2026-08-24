# Phase 6 — Commercial and Operational Completeness: Closure Plan

**Status:** IN PROGRESS — NOT CERTIFIED  
**Branch:** `phase-6/commercial-operations`  
**Base:** `integration/gate-c-final`  
**Baseline at plan creation:** Gate C baseline merge `79b90e025a35cfa451788f0b5b9596f61b7a52df`  
**Rule:** Gates D and E MUST NOT begin until the Phase 6 exit gate below has an independent `PASS`.

## 1. Purpose

Finish the exact Phase 6 scope from `docs/EXECUTION_ROADMAP.md` without reopening certified Gate C behaviour or mixing pilot/release-hardening work into this branch.

Phase 6 scope:

- `FMT-004`
- `AI-007–009`, `AI-016–017`
- `RES-021`, `RES-025–032`
- `BIL-001–014`
- `EXP-003–006`
- `ADM-001–007`

The source requirement descriptions remain authoritative in `sports_competition_platform_implementation_plan.md`. This document owns execution order, completion evidence, and the Phase 6 closure gate.

## 2. Standing implementation rules

1. Keep one logical requirement slice per commit. Do not combine unrelated workstreams.
2. Pull forward existing functionality instead of rebuilding it. A requirement may be marked complete only after its implementation and tests are traced to the current Phase 6 head.
3. Preserve Gate C semantics and evidence. Any Gate C regression is a blocker, not an acceptable Phase 6 trade-off.
4. AI proposes only schema-validated changes; deterministic domain/runtime code remains authoritative.
5. Billing mutations must be idempotent, audited, and reconciliation-safe. Event operation must remain usable when AI quota is exhausted or billing providers are degraded.
6. Support/admin tools are least-privilege. Result mutations may not become silent platform-admin edits.
7. Public privacy and referee visibility default to the stricter state until explicitly configured.
8. Export data is derived from authoritative current competition state and must be deterministic enough for repeatable verification.
9. Required browser, accessibility, visual, integration, migration, backup, OpenAPI, dependency, and secret checks may not be skipped at certification.
10. Gates D/E code, pilot changes, penetration-test remediation, and Phase 7-only load/endurance work stay out of this branch until Phase 6 closes.

## 3. Current baseline

### Gate C inheritance

The branch includes the merged Gate C CI baseline repairs from PR #40. The inherited PostgreSQL JSONB assertion and pre-Playwright asset-origin verifier defects are therefore baseline-fixed.

### Phase 6 candidate already present

`FMT-004` has a candidate implementation for deterministic double elimination:

- upper/lower bracket construction for entry counts >= 2;
- `2N-2` always-materialised matches;
- an explicit if-required reset final outside the always-materialised graph (`2N-1` maximum);
- structural `FormatGraph` validation;
- boundary/default-size tests for 2, 8, 12, 16, 24, and 48 entries.

It remains **candidate / not closed** until the full branch gate is green and its integration path is audited.

### CI baseline at plan creation

The current branch has demonstrated green secrets, formatting, lint, typecheck, unit, Gate C seal/evidence, Vercel verification, migrations, backup/restore, integration, fixtures, OpenAPI, production build, deployment manifest, and asset-origin verification. The browser lane reached Playwright and failed in `pnpm test:e2e`; accessibility and visual checks were consequently skipped. That browser failure must be classified and resolved before Phase 6 certification.

## 4. Requirement matrix

Status values:

- **Candidate** — implementation exists on this branch but closure evidence is incomplete.
- **Audit** — inspect current repository first; earlier phases may already satisfy part or all of the requirement.
- **Pending** — implementation remains after the audit.
- **Closed** — implementation and required evidence are complete on the Phase 6 candidate SHA.

| ID | Requirement | Initial status | Closure evidence |
| --- | --- | --- | --- |
| FMT-004 | Implement double elimination | Candidate | Domain invariants, default/boundary fixtures, materialisation/scheduling integration, browser/contract regression |
| AI-007 | Natural-language format modifications | Audit | Structured proposal schema, deterministic validation/application, manual fallback, unit/API/browser tests |
| AI-008 | Natural-language schedule preferences | Audit | Preference schema, solver-bound deterministic validation, quota/fallback tests, browser flow |
| AI-009 | Affected-match recovery recommendations | Audit | Dependency-bounded proposal contract, no automatic publish, conflict/recovery tests |
| AI-016 | Prompt and model-version tracking | Audit | Provider-neutral metadata persistence/audit, privacy regression, integration tests |
| AI-017 | AI cost and latency monitoring | Audit | Structured metrics, provider/model attribution, failure/cached semantics, tests |
| RES-021 | Possible future matches | Audit | Public projection semantics, uncertainty labelling, advancement-change regression, browser/a11y tests |
| RES-025 | Referee-name visibility control | Audit | Private-by-default control, public projection filter, permission/API/browser tests |
| RES-026 | SEO metadata on all public pages | Audit | Title/description/OG/JSON-LD, canonical public URLs, metadata tests |
| RES-027 | 404/403/410/500/503/offline error pages | Audit | Correct status/state mapping, recovery actions, offline/browser/a11y/visual tests |
| RES-028 | Organiser and official onboarding walkthrough | Audit | First-run persistence, skip/replay, keyboard/screen-reader/browser tests |
| RES-029 | Marketing website | Audit | Home/features/pricing/help/contact, responsive/a11y/SEO/visual tests |
| RES-030 | Legal pages | Audit | Terms, Privacy Policy, Cookie Policy, version/effective-date contract, review receipt |
| RES-031 | Cookie consent banner | Audit | Consent persistence/categories, non-essential gating, withdrawal/update tests |
| RES-032 | Notification bell/list | Audit | Read/unread state, tenant isolation, resilient delivery/read API, browser/a11y tests |
| BIL-001 | Entitlement service | Audit | Central entitlement decisions, tenant scope, fail-safe provider boundary, integration tests |
| BIL-002 | Free 16-entry entitlement | Audit | Cross-division limit and non-destructive upgrade tests |
| BIL-003 | Free AI-action allowance | Audit | Atomic allowance accounting, concurrency/retry tests |
| BIL-004 | Event Pass | Audit | Competition-scoped entitlement, end + 7-day grace, webhook/reconciliation tests |
| BIL-005 | Organiser Pro | Audit | Organiser/account entitlement and configuration-driven price tests |
| BIL-006 | AI-action top-up purchase | Audit | Purchase-to-ledger credit, idempotent fulfilment, retry/replay tests |
| BIL-007 | Billing webhooks and idempotency | Audit | Signature/authentication boundary, replay-safe processing, duplicate/out-of-order tests |
| BIL-008 | Usage ledger | Audit | Append-only/idempotent ledger, reconciliation invariants, audit/export tests |
| BIL-009 | AI-usage page | Audit | Usage/balance/history presentation, tenant isolation, a11y/browser tests |
| BIL-010 | Upgrade and top-up flows | Audit | Non-destructive upgrade, cancel/failure/retry paths, browser tests |
| BIL-011 | AI exhaustion never blocks manual operation | Audit | Exhaustion/degraded-provider E2E covering manual format/schedule/event operation |
| BIL-012 | Paid branding controls | Audit | Entitlement enforcement, safe asset/text validation, public rendering tests |
| BIL-013 | Sponsor-placement controls | Audit | Entitlement enforcement, placement/sanitisation/privacy tests |
| BIL-014 | Receipts and billing history | Audit | Immutable provider references, customer history, access isolation tests |
| EXP-003 | Export tables and brackets | Audit | Deterministic export content, current publication/version binding, tests |
| EXP-004 | Export entries/results CSV | Audit | Stable schema/escaping/encoding, privacy filter, round-trip parser tests |
| EXP-005 | Export audit history | Audit | Authorised scoped export, append-only ordering, sensitive-field filtering tests |
| EXP-006 | Export full competition JSON | Audit | Versioned schema, deterministic export, export/re-import equivalence tests |
| ADM-001 | Support dashboard | Audit | Least-privilege internal surface, no silent result editing, browser/a11y tests |
| ADM-002 | Competition lookup | Audit | Authorised lookup, bounded search, tenant/privacy tests |
| ADM-003 | Read-only audit investigation | Audit | Immutable/read-only access, pagination/filtering, sensitive-data controls |
| ADM-004 | Access-pass revocation | Audit | Immediate revocation/fencing, active/offline-session regressions, audited action |
| ADM-005 | Sport-default version administration | Audit | Versioned defaults, no retroactive mutation, rollback/history tests |
| ADM-006 | AI usage and failure review | Audit | Metadata-first review without unnecessary prompt text, tenant/privacy tests |
| ADM-007 | Audit support changes | Audit | Actor/reason/before-after/target/request correlation for every support mutation |

## 5. Dependency-aware execution order

### P6-0 — Restore a fully green branch baseline

1. Classify the current `pnpm test:e2e` failure.
2. Fix only confirmed baseline/product defects; rerun flakes without speculative code changes.
3. Require browser E2E, accessibility, and visual lanes to execute successfully before expanding the branch substantially.

**Exit:** all standard CI jobs green on one unchanged SHA.

### P6-1 — Close FMT-004 end to end

1. Audit all format recommendation, persistence, materialisation, scheduling, result-progression, public-bracket, and export paths for assumptions that only existing stage families occur.
2. Integrate double elimination through those paths where the product contract requires it.
3. Prove conditional reset creation cannot be scheduled early and is created only when grand-final-one gives the upper-bracket champion a first loss.
4. Add real product-level tests, not only package-level graph tests.

**Exit:** FMT-004 marked Closed with full CI green.

### P6-2 — Commercial foundation before commercial UI

Implement/audit in dependency order:

1. `BIL-001` entitlement service.
2. `BIL-008` idempotent usage ledger.
3. `BIL-007` webhook/idempotency boundary and reconciliation support.
4. `BIL-002`, `BIL-003`, `BIL-004`, `BIL-005`, `BIL-006` entitlements/credits.
5. `BIL-011` fail-open-for-manual-operation product invariant.
6. `BIL-009`, `BIL-010`, `BIL-014` customer UI/history.
7. `BIL-012`, `BIL-013` branding/sponsor controls.

No UI may become the sole enforcement point.

### P6-3 — AI completeness

Implement/audit `AI-016` and `AI-017` platform metadata/monitoring before adding richer paid AI mutations, then close `AI-007`, `AI-008`, and `AI-009` through deterministic proposal contracts. Reuse existing AI action accounting, validation, retry, audit, and evaluation infrastructure.

**Critical invariant:** provider failure, quota exhaustion, invalid proposals, and cached/failed requests never make deterministic/manual operation unavailable.

### P6-4 — Public/result completeness

Close `RES-021`, then privacy/visibility (`RES-025`), SEO and resilient public states (`RES-026`, `RES-027`), onboarding (`RES-028`), marketing/legal/consent (`RES-029–031`), and notifications (`RES-032`).

Privacy/legal work must be reviewed before certification; implementation text alone is not a legal-review receipt.

### P6-5 — Exports

Close `EXP-003–006` on authoritative versioned data. `EXP-006` must include a versioned JSON contract and an export/re-import equivalence test, because the Phase 6 exit criteria explicitly require export/re-import validation.

### P6-6 — Administration and support

Close `ADM-001–007` with least privilege and complete support-action auditing. Support surfaces may expose investigation and explicitly authorised corrective controls, but must not create a silent second result-authority path.

### P6-7 — Cross-feature acceptance and exact-SHA certification

Run the complete Phase 6 product matrix against a frozen candidate SHA.

Minimum mandatory evidence:

- secrets scan;
- production dependency audit;
- format and lint;
- typecheck;
- unit/property tests;
- database migration check;
- backup/restore verification;
- real PostgreSQL/Redis integration tests;
- fixture validation;
- generated OpenAPI diff/check;
- production build and deployment manifest;
- asset-origin verification;
- browser E2E with no required skips;
- accessibility and visual suites with no required skips;
- entitlement-bypass tests;
- billing webhook replay/idempotency tests;
- ledger reconciliation tests;
- refund/support-adjustment tests where the billing adapter exposes them;
- AI quota exhaustion/degraded-provider/manual-fallback E2E;
- full JSON export/re-import equivalence;
- privacy/consent tests;
- SEO metadata tests;
- email infrastructure/deliverability evidence required by the Phase 6 roadmap;
- legal/privacy review receipt;
- independent QA/QC review.

## 6. Phase 6 exit gate

Phase 6 is complete only when all conditions below are true on the same frozen candidate lineage:

- [ ] Every requirement in the Phase 6 matrix is `Closed` or is explicitly superseded by an approved decision record that preserves the roadmap contract.
- [ ] No unresolved P0 or P1 defect.
- [ ] Standard CI is fully green; no required browser, accessibility, or visual suite is skipped.
- [ ] Gate C seal/evidence checks remain green and no certified event-operation invariant is weakened.
- [ ] Billing entitlement bypass, webhook replay, reconciliation, and support-adjustment evidence passes.
- [ ] AI exhaustion/degradation/manual fallback evidence passes.
- [ ] Full competition JSON export/re-import equivalence passes.
- [ ] Legal, privacy, SEO, email-deliverability, and accessibility reviews pass.
- [ ] Exact source SHA and retained evidence artifacts are recorded.
- [ ] Independent QA/QC verdict is exactly `PASS`.
- [ ] PR #39 is no longer draft, has no unresolved required review threads, and is merged using the evidence-preserving merge procedure selected for this line.

## 7. Gate D/E entry lock

Until every Phase 6 exit item above is checked:

- do not create Gate D or Gate E implementation branches from an uncertified Phase 6 head;
- do not mix pilot-specific concessions into Phase 6;
- do not claim local/national pilot readiness;
- do not count a Phase 7 test or pilot result as a substitute for missing Phase 6 product evidence.

After Phase 6 receives its independent `PASS`, Gate D starts as its own local-pilot candidate and Gate E follows only after Gate D closes. Each gate requires a separate source SHA, evidence set, defect closure record, and independent verdict.
