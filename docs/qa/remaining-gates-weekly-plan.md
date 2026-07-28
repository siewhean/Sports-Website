# Remaining gates — sequenced weekly delivery, audit and evidence plan

**Status:** Preparation plan; not a release verdict

**Preparation branch:** `agent/gates-c-f-preparation-20260725`

**Important integration boundary:** the latest Gate B remediation described in the working session exists on the local branch `fix/gate-b-local-remediation-20260724-132224` and is not present on this remote preparation branch. Rebase or cherry-pick these preparation commits only after Gate B has a final clean exact-SHA candidate. Do not merge this branch directly into `main` or use it to overwrite the local Gate B work.

The “weeks” below are ordered work packets, not guaranteed calendar estimates. Gate D and Gate E depend on real competition dates and external partners; they advance only when their entry criteria are met.

## Operating rules for every week

1. Start from a clean branch and record the exact starting SHA.
2. Read the applicable gate preparation contract and source requirement IDs.
3. Keep each logical work package in an intentional commit; do not mix unrelated gate work.
4. Add production code, migrations, unit/integration/browser tests, monitoring and documentation together where the Definition of Done requires them.
5. Run the narrow affected checks before the complete ledger.
6. Fix root causes; never weaken assertions, add broad allowlists, turn failures into skips or blanket-update visual baselines.
7. Freeze a candidate SHA only after editable-tree validation is green.
8. Rerun the complete gate on the exact clean candidate SHA.
9. Publish immutable sanitized evidence.
10. Obtain an independent review that records exact reviewed SHA, `P0: 0` and `P1: 0`.
11. A gate advances only with `Verdict: PASS`; partial execution remains `Verdict: BLOCKED`.

## Branch and commit discipline

Recommended branch sequence after the local Gate B branch is pushed:

```text
fix/gate-b-local-remediation-20260724-132224
  └─ agent/gate-c-event-operations
       └─ agent/phase6-commercial-completeness
            └─ agent/gate-d-local-pilot
                 └─ agent/gate-e-national-pilot
                      └─ agent/gate-f-public-release
```

Preparation commits to transplant after Gate B:

```text
a264fbefe4cd462c383937391a18bc4325777bb2  Gate C contract
aab838db9eb28ec110e6c722b005e74982240e9f  Gate D contract
bd2a9dfb16e6e93146018a64b3d297faa63f83de  Gate E contract
a0086b476a38f1c20f205a9fc6c185c1a9e94525  Gate F contract
```

Use `git cherry-pick` only after reviewing the diff and confirming there is no conflict with newer local evidence documents. If these commits are rebased instead, preserve one gate contract per commit.

---

## Week 1 — close Gate B exact-SHA evidence

### Goal

Finish the currently blocked state-preservation proof and produce a truthful Gate B candidate.

### Work

- Complete the four-test state-preservation ladder:
  - sport-settings conflict recovery ×1;
  - all four tests ×1;
  - each test ×5;
  - complete file ×5 for exactly 20 passes.
- Preserve authorization, revision-fencing and duplicate-request invariants.
- Audit all dirty Gate B changes and remove temporary diagnostics.
- Run the complete editable-tree ledger.
- Commit the final Gate B code/tests/tooling.
- Rerun the complete ledger on the clean exact SHA.
- Generate and validate immutable evidence.
- Perform a fresh independent review.

### Required exit

```text
20 state-preservation executions passed
all Gate B commands passed
both PostgreSQL/Redis isolation cycles passed
Chromium and WebKit accessibility/visual evidence passed
immutable exact-SHA evidence published
P0: 0
P1: 0
Verdict: PASS
```

### Blocker escalation

If the browser suite does not exit naturally, isolate one test and classify the wait as server startup, locator/request, application state, teardown or open handle. Do not begin Gate C integration on an uncertified Gate B SHA.

---

## Week 2 — Gate C access, lease and takeover package

### Requirement focus

`ACC-001–010`

### Work

- Rebase the Gate C branch onto the final Gate B SHA.
- Apply the Gate C preparation contract commit.
- Audit existing pass/session/lease implementation against the final schema.
- Add deterministic QR generation and accessible organiser print/download UI.
- Complete fallback-code entry, rotation, expiry and error states.
- Implement dedicated code-attempt counters, cooldown, metrics and standard rate-limit responses.
- Add heartbeat renewal and visibility/background policy.
- Add read-only pass/session mode.
- Build explicit transfer/takeover flow, old-device read-only state and audit history.
- Add concurrent exchange, transfer race, expiry, revocation and cross-match/tenant tests.

### Suggested commits

```text
feat(access): add QR and fallback-code issuance
feat(access): add heartbeat read-only and transfer lifecycle
test(access): prove lease fencing rate limits and audit
```

### Required exit

- one active writer under concurrency;
- old generation rejected after transfer;
- read-only session cannot mutate;
- expired/revoked access fails closed;
- access/transfer audit contains no secrets;
- affected unit/integration/browser/accessibility checks green.

---

## Week 3 — Gate C five-sport score-event and correction package

### Requirement focus

`SCR-001–020`

### Work

- Preserve append-only events, UUID idempotency and sequence locking.
- Define sport-pack-owned event schemas/reducers for all five launch sports.
- Generalise the accessible mobile scoring shell without creating five unrelated implementations.
- Complete reversal, reopening, correction reason, finalisation summary and match audit view.
- Enforce Canoe Polo scorer attribution and the configured unknown-scorer exception.
- Preserve the explicit “no running game clock/no Canoe Polo shot clock” decision.
- Add deterministic result, standings, advancement and bracket fixtures per sport.
- Add downstream-conflict review when dependent matches are prepared, started or final.

### Suggested commits

```text
feat(scoring): define sport-pack score event contracts
feat(scoring): complete five mobile scorecards
feat(results): add correction and downstream review workflow
test(scoring): prove reducers idempotency and publication atomicity
```

### Required exit

- five scorecards use one accessible shell;
- each sport reducer matches independent fixtures;
- reversal/reopen/correction preserve append-only history;
- finalisation and publication remain atomic;
- critical downstream conflicts are visible and never silently cascaded.

---

## Week 4 — Gate C durable offline package

### Requirement focus

`OFF-001–008`

### Work

- Introduce a versioned IndexedDB schema for authorised match cache and append-only pending commands.
- Add service-worker lifecycle and update policy.
- Store last acknowledged sequence, writer generation, expiry and local finalisation state without storing reusable raw access tokens.
- Implement ordered replay, backoff, deduplication and explicit conflict states.
- Stop replay on stale generation, expiry/revocation, sequence divergence or semantic conflict.
- Add refresh, browser restart and clock-controlled four-hour offline recovery tests.
- Implement pending-finalisation state until server acknowledgement.
- Block unsafe transfer with unsynchronised events until deliberate resolution/export.

### Suggested commits

```text
feat(offline): add versioned scoring event queue
feat(offline): add ordered replay and conflict recovery
test(offline): prove refresh restart four-hour and transfer safety
```

### Required exit

- no pending event is silently lost or reordered;
- duplicate replay is harmless;
- finalised-local state is visibly pending until acknowledged;
- refresh/restart recovery passes;
- four-hour policy passes through clock-controlled and browser evidence;
- unsynchronised takeover produces an explicit conflict package.

---

## Week 5 — Gate C repair, public truth and printed fallback package

### Requirement focus

`SCH-024–026`, `RES-011–020`, `RES-022–024`, `EXP-001–002`, `QA-018`

### Work

- Implement deterministic affected/dependent-match closure.
- Create private local repair revisions and preserve unrelated published matches where feasible.
- Expand the repair set only when local constraints cannot be satisfied.
- Keep corrected results immediately public while future schedule changes remain private until explicit publication.
- Complete overview, schedule, tables, brackets, search and next-match public views.
- Add monotonic near-realtime version updates and visible last-updated state.
- Add public privacy/minor/referee controls.
- Generate deterministic, version-stamped schedule PDFs and emergency score sheets.
- Verify monochrome print, clipping, version/timestamp visibility and operational instructions.

### Suggested commits

```text
feat(schedule): add affected-match repair revisions
feat(public): complete current-version event views
feat(exports): add schedule and score-sheet fallback pack
test(gate-c): prove correction repair privacy and print invariants
```

### Required exit

- private repair never leaks;
- corrected result publication and schedule publication remain separate;
- public clients cannot remain on a known stale version;
- privacy defaults match approved policy;
- fallback PDFs pass deterministic checksum and visual review.

---

## Week 6 — Gate C load, device, evidence and independent QC

### Work

- Add score-write and public-read load harnesses using realistic event/publication flows.
- Agree and record pilot p95/error targets and concurrency.
- Execute Chromium, Firefox, WebKit, phone Chromium and phone WebKit matrices.
- Execute real iOS and budget Android scoring, offline, transfer and finalisation flows.
- Run the entire Gate C ledger on a clean frozen SHA.
- Publish immutable evidence and an exact-SHA manifest.
- Perform an independent security/accessibility/runtime review.

### Required exit

```text
concurrent-device, expiry/revocation, refresh/restart,
four-hour offline, unsynchronised transfer, correction,
downstream conflict and printed fallback all passed
score-write/public p95 targets met
real iOS and low-end Android passed
P0: 0
P1: 0
Verdict: PASS
```

If any source changes after the review, create a new SHA and rerun the complete gate.

---

## Week 7 — Phase 6 commercial and administrative foundation

### Requirement focus

`FMT-004`, `AI-007–009`, `AI-016–017`, `RES-021`, `RES-025–032`, `BIL-001–014`, `EXP-003–006`, `ADM-001–007`

### Work

- Finalise configurable Event Pass, Organiser Pro and AI top-up values with the business/legal owner.
- Implement entitlement contracts and immutable/reconcilable ledger.
- Add webhook idempotency, replay, out-of-order and reconciliation flows.
- Add refund/dispute/manual-adjustment behavior and receipts.
- Complete AI version/cost/latency tracking and manual fallback.
- Add remaining exports, support lookup/audit and privacy/deletion controls.
- Complete required legal/marketing/search/email infrastructure foundations.
- Implement double elimination only against the accepted Phase 6 scope; do not let it block Gate C or pilot work unnecessarily.

### Required exit

- entitlement bypass and webhook replay tests pass;
- provider/ledger/entitlement reconciliation passes;
- AI exhaustion never blocks manual operation;
- support mutations are scoped, reasoned and audited;
- export/re-import and privacy/deletion tests pass;
- independent Phase 6 readiness review has no P0/P1.

---

## Week 8 — Gate D rehearsal and local-pilot readiness

### Work

- Apply the Gate D preparation contract to a branch based on the Gate C/Phase 6 source.
- Select and sign the local pilot manifest.
- Confirm organiser, official, manual-calculation and support owners.
- Rehearse the full event using canonical pilot fixtures.
- Train officials and validate the printed fallback pack.
- Exercise device replacement, offline, correction, repair, restore and rollback drills.
- Confirm monitoring/support evidence collection and redaction.

### Required exit

- all Gate D entry criteria checked;
- no unresolved rehearsal P0/P1;
- existing process remains available as parallel fallback;
- pilot go/no-go signed by organiser, support and independent QA.

---

## Week 9 — Gate D closed local parallel pilot

### Work

- Operate the platform and existing process concurrently.
- Capture every score/publication version, intervention and discrepancy.
- Produce independent manual standings/brackets.
- Execute safe fault drills and device replacement.
- Measure score-write/public freshness and support contacts.
- Capture organiser/official/support attestations.
- Take an isolated backup and execute the planned restore verification.

### Required exit

- no data-loss/security/privacy stop rule triggered;
- officials score without developer intervention;
- platform and manual standings/brackets/results reconcile;
- every discrepancy has evidence and owner;
- pilot evidence package is complete and immutable.

The pilot itself does not pass Gate D if defects require source changes.

---

## Week 10 — Gate D defect closure and exact-SHA review

### Work

- Triage every pilot finding by severity and root cause.
- Fix all P0/P1 and relevant systemic lower findings.
- Add regression coverage for every product defect.
- Freeze a corrected candidate SHA and rerun the complete Gate C/D ledger.
- Reconcile the corrected source with the historical pilot evidence.
- Obtain a fresh independent review.

### Required exit

```text
P0: 0
P1: 0
all pilot discrepancies resolved
manual/platform calculations reconciled
restore/device replacement passed
Verdict: PASS
```

---

## Week 11 — Gate E national-pilot preparation, load and security

### Work

- Apply the Gate E preparation contract onto the Gate D-certified SHA.
- Sign the national parallel-pilot agreement and manifest.
- Confirm support rota, communications, legal/privacy and fallback process.
- Qualify expected peak plus safety headroom.
- Complete independent penetration testing and close all critical/high findings.
- Rehearse deployment rollback, cache purge, alerting, failover/restore and incident communications.
- Verify the full browser/real-device floor.

### Required exit

- national event go/no-go criteria complete;
- expected-load qualification passes;
- security critical/high findings are zero;
- support/on-call and fallback owners are active;
- exact release candidate is frozen and independently reviewed.

---

## Week 12 — Gate E national parallel pilot

### Work

- Run the platform in parallel with the national organiser’s established process.
- Exercise every critical schedule and score path naturally or through an adjacent controlled rehearsal.
- Monitor public load/cache freshness, scoring writes, queues, database/Redis and support demand.
- Capture every discrepancy/intervention and independent manual result/standings/bracket record.
- Keep the established process authoritative if a stop rule triggers.

### Required exit

- national evidence package complete;
- every major discrepancy classified and investigated;
- public pages meet agreed load/freshness objectives;
- support runbook is demonstrably active;
- no unresolved incident is concealed by a retrospective data edit.

---

## Week 13 — Gate E closure and release-candidate consolidation

### Work

- Fix and regression-test every Gate E P0/P1.
- Rerun full automation, load, security, accessibility and device matrix on the corrected SHA.
- Reconcile national platform/manual outputs.
- Obtain independent Gate E review.
- Consolidate Phase 6 commercial/legal/SEO/email work required for Gate F.

### Required exit

```text
P0: 0
P1: 0
all major discrepancies resolved
expected-load and support evidence passed
Verdict: PASS
```

---

## Week 14 — Gate F production infrastructure and release pipeline

### Work

- Apply the Gate F preparation contract to the Gate E-certified SHA.
- Provision isolated staging/production and declarative provider configuration.
- Implement exact-artifact build/promotion, expand-contract migration and zero-downtime rollout.
- Add automatic rollback, deployment freeze and feature-flag kill switches.
- Configure managed database/replica, Redis, queue, storage, CDN, SSL/DNS and secrets.
- Activate hosted logs/traces/error tracking, SLO dashboards, synthetics, alerts, status and on-call routes.
- Configure backups/PITR/cross-region copies and restore automation.

### Required exit

- staging deployment uses an immutable exact-SHA artifact;
- previous-version migration compatibility passes;
- rollback and readiness guards work;
- monitoring/alerts/synthetics/status are observable and owned;
- no production demo/test fallback is enabled.

---

## Week 15 — Gate F commercial, security, legal and production simulation

### Work

- Complete production billing/provider reconciliation and receipts.
- Verify SPF/DKIM/DMARC, bounce/complaint handling and email templates.
- Publish legally reviewed Terms, Privacy and Cookie pages; test consent/retention/deletion.
- Complete SEO/social/JSON-LD/sitemap/robots audit.
- Close penetration-test and accessibility findings.
- Run the complete production simulation: rollout, automatic rollback, restore, failover, Redis recovery, CDN stale-score purge, billing/email outage, key revocation, alerts/status and freeze policy.

### Required exit

- all production simulation drills exit naturally and meet objectives;
- security critical/high findings zero;
- legal/accessibility/SEO/email reviews current;
- CDN confirmed-current public truth passes;
- billing reconciliation has no unexplained mismatch.

---

## Week 16 — Gate F exact-artifact review and go/no-go

### Work

- Freeze source SHA and artifact digest.
- Rerun the complete application, provider, deployment, migration, recovery, security, accessibility, SEO, email and operations ledger.
- Publish immutable evidence.
- Conduct independent review against the exact promoted artifact.
- Hold a formal go/no-go with release authority, engineering, security, operations, support and legal.

### Required exit

```text
Gates B–E exact-SHA PASS records present
same tested artifact promoted
zero-downtime/rollback/restore/failover/CDN/alerts passed
billing/security/accessibility/legal/email/SEO passed
P0: 0
P1: 0
Verdict: PASS
```

No public paid release is authorised when any required evidence is missing, stale or tied to another SHA/artifact.

---

## Weekly status format

At the end of each work packet, report:

```text
Week/work packet:
Starting SHA:
Ending SHA:
Commits:
Requirement IDs addressed:
Production files changed:
Migrations changed:
Tests added/changed:
Commands and exit codes:
Browser/device matrix:
Visual/accessibility review:
Evidence location and checksums:
Independent review status:
P0:
P1:
P2/P3 with owner and deadline:
Exact blocker:
Verdict: PASS | BLOCKED
Next work packet:
```

## Final planning QC verdict

**Verdict: PREPARED**

The dependency order, work packages, commit discipline, fail-closed evidence rules and weekly exit criteria are documented. The plan itself does not certify any product gate. Gate B remains the immediate dependency; Gates C–F remain blocked until their production and empirical evidence contracts are satisfied.
