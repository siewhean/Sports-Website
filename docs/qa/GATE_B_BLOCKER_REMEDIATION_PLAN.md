# Gate B Blocker Remediation and Production-Polish Plan

**Plan date:** 22 July 2026  
**Target branch:** `agent/gate-b-production-readiness-audit`  
**Base:** `agent/gate-b-organiser-journey` at `4b62a48a90d648cd3f2c9deb360c2bd34ca74e10`  
**Primary audit:** `docs/qa/phase-4-production-readiness-audit.md`  
**Product authority:** `sports_competition_platform_implementation_plan.md`  
**Gate target:** Locally verified Organiser Alpha suitable for controlled staging and design-partner testing

## 1. Purpose

This plan closes the incomplete and blocking Gate B work without pretending that Gate B alone makes the full sports platform production-ready.

Gate B owns:

- Assisted Setup
- sport-dynamic settings references
- capacity-first format recommendations
- manual and visual format editing
- immutable format revisions and organiser templates
- asynchronous scheduling
- Fastest, Balanced, and Rest-focused alternatives
- schedule timeline and mobile move flow
- locks and revision comparison
- organiser-only schedule publication

Gate B does not own event-day scoring, offline score replay, result correction, standings, billing, pilot completion, or final production operations. Those remain later gates.

## 2. Release language

The remediation is successful only when the evidence supports this statement:

> Gate B is locally verified and suitable for controlled staging and design-partner testing.

Do not use this statement until Gate C and the wider external gates are complete:

> The sports competition platform is production-ready.

## 3. Global execution rules

1. Do not use GitHub Actions while the account Actions allowance is exhausted.
2. Use Node `24.18.0` and pnpm `10.33.0`.
3. Run PostgreSQL and Redis for every infrastructure-dependent phase.
4. Use disposable databases or isolated schemas.
5. Never weaken a test to obtain a passing result.
6. Every phase ends with an independent QA/QC pass.
7. P0 and P1 findings block advancement.
8. P2 findings must be fixed or accepted with an owner, reason, and target phase.
9. Store exact commands and outcomes in `docs/qa/phase-4-local-run.md`.
10. Use only `PASS`, `FAIL`, or `BLOCKED` as phase verdicts.

## 4. Master implementation sequence

```text
Phase 0 — Baseline and evidence discipline
        ↓
Phase 1 — Correctness remediation stabilisation
        ↓
Phase 2 — Authenticated full-stack Gate B E2E
        ↓
Phase 3 — Dependency and supply-chain hardening
        ↓
Phase 4 — UX, accessibility, and visual portability
        ↓
Phase 5 — Reliability and performance qualification
        ↓
Phase 6 — Production AI boundary
        ↓
Phase 7 — Staging foundation and external evidence
        ↓
Phase 8 — Independent Gate B verdict
```

A phase may be split into smaller pull requests, but the order remains authoritative.

---

# Phase 0 — Baseline and evidence discipline

## Objective

Create a reproducible local acceptance process before adding more remediation code.

## Work items

### GB0-001 — Pin the validation environment

Record:

- OS and architecture
- Node version
- pnpm version
- PostgreSQL version
- Redis version
- Chromium version
- WebKit version
- current branch and commit

### GB0-002 — Create a local Gate B command runner

Add a repository script that executes the local Gate B commands in a deterministic order and writes a sanitised result summary.

The runner must:

- stop after a blocking failure
- preserve command exit codes
- store logs outside tracked source paths by default
- redact known secret environment keys
- distinguish skipped infrastructure tests from passing tests
- identify the exact commit under test

### GB0-003 — Create `phase-4-local-run.md`

The document must include:

- exact command
- exit code
- test count
- skipped count and reason
- artifact or screenshot path
- residual risk

### GB0-004 — Establish the baseline

Run the existing branch before further changes and record every failure without fixing tests in the same step.

## Phase 0 QA/QC

### Automated checks

- `node --version`
- `pnpm --version`
- `git status --short`
- `pnpm install --frozen-lockfile`
- runner self-test with one synthetic passing and one synthetic failing command
- secret-redaction unit tests

### Manual audit

- Verify the runner cannot claim PASS when a required command is skipped.
- Verify logs contain no cookies, access tokens, database passwords, or raw AI prompts.
- Verify the documented commit matches `git rev-parse HEAD`.

### Exit criteria

- P0: 0
- P1: 0
- Baseline document committed
- Verdict: PASS

---

# Phase 1 — Correctness remediation stabilisation

## Objective

Validate and complete the source remediations already introduced by the production-readiness audit.

## Work items

### GB1-001 — Unselected recommendation resume

Validate migration `0025_phase4_unselected_recommendation_resume.sql`.

Required behavior:

- valid recommendation evidence remains present before selection
- `format_revision_id: null` is valid before selection
- selected recommendations must reference exact applied revisions
- stale recommendation-set hashes invalidate downstream steps
- cross-competition and cross-division candidate references fail closed
- a no-change resume does not increment the setup revision

### GB1-002 — Accepted schedule and publication resume

Validate migration `0026_phase4_schedule_resume_hash_domains.sql`.

Required behavior:

- schedule review pins the accepted revision assignment hash
- option result hash and assignment hash are treated as separate domains
- accepted review survives resume
- published review survives resume
- mismatched job, option, revision, format, assignment hash, or publication pointer is invalidated
- a no-change resume does not increment the setup revision

### GB1-003 — Truthful completed and expired setup documents

Required behavior:

- completed setup returns `permission: read`
- completed setup returns `read_only: true`
- completed setup autosave state is `read_only`
- expired setup autosave state remains `expired`
- organizer, viewer, read, resume, save, conflict, and replay responses use the same rule
- strict browser parsing succeeds

### GB1-004 — Canonical recommendation selection

The client may submit only:

- selected recommendation ID
- acknowledged-capacity-shortfall boolean

The server must rebuild:

- names
- structure
- advantage
- match counts
- guaranteed matches
- ranking coverage
- warning codes
- capacity status
- scheduling status
- division format references

Forged client values must never persist.

### GB1-005 — Correct per-entry format metrics

Use the deterministic domain oracle for:

- total match count
- minimum guaranteed matches per entry
- maximum matches for one entry

Validate all default templates for 8, 12, 16, 24, and 48 entries and manually edited valid graphs.

### GB1-006 — Demo mode fail-closed configuration

Required behavior:

- local and test may explicitly use demo mode
- staging and production reject demo mode at build/startup
- staging and production require a valid server-only API base URL
- browsers never receive the internal API base URL

### GB1-007 — Remove duplicate or divergent persistence helpers

- keep one authoritative format-save body builder
- ensure the new revision always points to the exact visible draft
- ensure all imports use the authoritative helper
- add a static or unit regression preventing reintroduction

## Phase 1 QA/QC

### Automated checks

- focused unit tests for every item above
- migrated PostgreSQL tests from an empty schema
- populated upgrade tests from migration 0024 to the latest migration
- concurrent resume tests
- strict response parser tests
- forged payload tests
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:unit`
- `RUN_INFRA_TESTS=1 pnpm test:integration`
- `pnpm db:migrate:check`
- `pnpm backup:verify`

### Adversarial checks

- mutate one field at a time in recommendation evidence
- mutate one field at a time in schedule review evidence
- replay completion with the same idempotency key
- race two resume requests
- resume as viewer
- resume an archived competition
- save a stale format revision
- submit a forged guarantee larger than the domain result

### Independent review checklist

- migrations are forward-only
- prior migration checksums are unchanged
- no data is silently deleted
- idempotency semantics are unchanged for valid replays
- contract parser and API response agree
- every database state transition is covered by an audit or existing immutable history

### Exit criteria

- P0: 0
- P1: 0
- all focused and full local checks green
- Verdict: PASS

---

# Phase 2 — Authenticated full-stack Gate B E2E

## Objective

Prove the real organizer journey through the production web build and all server-side boundaries.

## Architecture

```text
Playwright browser
        ↓
Production Next.js web server
        ↓
Same-origin BFF routes
        ↓
Fastify API with real identity session and CSRF
        ↓
Disposable PostgreSQL database/schema
        ↓
Redis-backed scheduling queue
        ↓
Real scheduler worker
        ↓
Public projection readback
```

Demo data is forbidden for this test.

## Work items

### GB2-001 — Build a Gate B real-E2E harness

The harness must:

- start local PostgreSQL and Redis
- create an isolated database or schema
- apply all migrations
- create a real organizer session and CSRF token
- start Fastify with `ReliableGateBPhase4Runtime`
- start a Redis scheduler worker
- build and start the production Next.js application
- write a mode-0600 state file containing only test credentials
- run Playwright with one worker
- assert database oracles
- clean up child processes and isolated data on success, failure, and interruption

### GB2-002 — Browser organizer journey

The browser test must:

1. open Assisted Setup with an authenticated organizer cookie
2. resume the draft
3. change the sport and verify dynamic settings/capacity references
4. save capacity, settings, entries, and preferences
5. select a server-owned capacity-filtered recommendation
6. reload before selection and after selection
7. validate the canonical format in the format editor
8. create or continue the schedule job
9. wait for the real Redis worker
10. accept an option
11. reload schedule review
12. lock one match
13. move another match through the mobile flow
14. compare revisions
15. publish as organizer
16. complete Assisted Setup
17. reload completed setup and verify read-only rendering
18. verify the public projection uses only the published schedule

### GB2-003 — Negative authorization journey

Test:

- viewer can read but cannot mutate
- official cannot publish schedule
- organizer from another organization cannot read the competition
- missing CSRF fails
- cross-origin mutation fails
- archived competition cannot mutate

### GB2-004 — Browser transport and privacy assertions

Verify:

- no raw session token in DOM, local storage, session storage, or URLs
- all organizer responses are `no-store, private`
- no unexpected 4xx/5xx requests
- no browser console or page errors
- no demo-data marker appears
- no unpublished revision appears on the public page

### GB2-005 — Database oracles

After the browser completes, assert:

- setup revision lineage is monotonic
- recommendation evidence remains immutable
- format revisions form one parent chain per division
- schedule acceptance references the exact job and option
- schedule moves create a child revision
- published revision matches `competition_publications`
- public projection version increments once
- audit and outbox records exist once per accepted mutation
- idempotent replays do not duplicate history

## Phase 2 QA/QC

### Automated checks

- real browser test on desktop Chromium
- real browser test on phone Chromium for Assisted Setup and move flow
- focused WebKit smoke test after the core path passes
- console guard
- failed network guard
- PostgreSQL oracle script
- process cleanup test
- interruption cleanup test

### Independent review checklist

- test does not call runtime methods to perform actions that the browser is meant to prove
- seeding is limited to prerequisites that the product cannot create through the tested UI
- the scheduler uses Redis and a real worker
- Next.js runs as a production build
- no `MATCHDAY_PHASE2_DATA_MODE=demo`
- no mocked BFF response on the critical path

### Exit criteria

- complete real journey passes twice from clean isolation
- P0: 0
- P1: 0
- Verdict: PASS

---

# Phase 3 — Dependency and supply-chain hardening

## Objective

Return the production dependency audit to green without compatibility regressions.

## Work items

### GB3-001 — Dependency graph inventory

Record:

- `pnpm why fast-uri`
- `pnpm why sharp`
- `pnpm outdated --recursive`
- `pnpm audit --prod`

### GB3-002 — Fastify serialization path

Prefer upgrading the direct Fastify or `fast-json-stringify` parent rather than using a blind override.

Regression scope:

- response serialization
- TypeBox schemas
- malformed response rejection
- content type and status codes
- API startup and shutdown

### GB3-003 — Swagger resolution path

Prefer upgrading `@fastify/swagger` or the direct resolver parent.

Regression scope:

- OpenAPI generation
- schema references
- route security schemes
- generated document stability
- Swagger UI outside production

### GB3-004 — Next.js image path

Upgrade the compatible parent dependency so the patched `sharp`/libvips chain is used.

Regression scope:

- production Next.js build
- image optimization
- AVIF/WebP negotiation
- Open Graph images
- asset manifest
- public page rendering

### GB3-005 — Supply-chain controls

- frozen lockfile install
- production-only audit
- secret scan
- license inventory if available
- no unapproved install scripts
- document any accepted advisory with owner and expiry

## Phase 3 QA/QC

### Automated checks

- `pnpm install --frozen-lockfile`
- `pnpm dependencies:audit`
- API unit and integration tests
- OpenAPI generation and check
- production build
- asset manifest and origin verifier
- image route smoke test
- visual regression suite

### Independent review checklist

- no audit suppression
- no unbounded package override
- lockfile matches package manifests
- transitive upgrade does not introduce a second vulnerable version
- production bundle remains within accepted limits

### Exit criteria

- zero unaccepted production advisories
- P0: 0
- P1: 0
- Verdict: PASS

---

# Phase 4 — UX, accessibility, and visual portability

## Objective

Polish Gate B so organizers can use it reliably on phone, tablet, and desktop, including keyboard and assistive technology.

## Work items

### GB4-001 — Replace disruptive full-page reloads

For successful schedule operations:

- consume returned server documents where possible
- otherwise use controlled `router.refresh()`
- restore focus to the initiating control or updated heading
- preserve selected objective, comparison context, and scroll position
- announce success through `aria-live`

Keep a hard reload only for unrecoverable stale-state recovery.

### GB4-002 — Complete WCAG A/AA automated gate

- fail on every Axe result tagged for WCAG A or AA
- retain severity reporting as secondary information
- test ready, loading, empty, error, offline, permission, read-only, conflict, expired, and quota states

### GB4-003 — Keyboard and non-drag alternatives

- every drag action has a structured alternative
- format stages can be reordered/edited without pointer input
- schedule moves use the semantic move flow
- focus order remains logical
- escape and cancel behavior is predictable

### GB4-004 — 320 CSS-pixel reflow

Verify at 320 CSS pixels:

- no page-level horizontal overflow
- recommendation cards remain readable
- manual format builder remains usable
- schedule list remains usable
- sticky actions do not cover content

### GB4-005 — Visual baseline portability

Choose and document one policy:

- Linux Chromium/WebKit baselines in a pinned container, or
- pinned macOS visual approval plus Linux functional tests

Do not mix unlabelled platform snapshots.

### GB4-006 — Error and empty-state polish

Every Gate B screen must have distinct:

- loading
- empty
- permission
- offline
- validation
- conflict
- expired
- malformed-response
- queue-unavailable
- no-solution

states.

## Phase 4 QA/QC

### Automated checks

- responsive suite across phone, tablet, desktop
- 320-pixel reflow suite
- WCAG A/AA Axe suite
- keyboard-only E2E
- reduced-motion checks
- console and network guards
- visual diff on the documented platform

### Manual audit

- VoiceOver or equivalent smoke test
- outdoor-readable contrast review
- touch targets at least the accepted product minimum
- focus visible on every interactive control
- no color-only warnings
- no clipped timeline, inspector, or action bar

### Exit criteria

- no serious usability blocker
- no WCAG A/AA automated violation in supported flows
- P0: 0
- P1: 0
- Verdict: PASS

---

# Phase 5 — Reliability and performance qualification

## Objective

Measure Gate B under production-like load and define safe operating limits.

## Work items

### GB5-001 — Scheduler fixtures

Test:

- 8, 12, 16, 24, and 48 entries
- one and multiple divisions
- one to four shared playing areas
- tight and comfortable capacity
- required and preferred constraints
- locks and local moves

### GB5-002 — Scheduler operational thresholds

Record:

- time to first valid schedule
- time to first improvement
- total candidates explored
- cancellation latency
- worker recovery after interruption
- no-solution detection latency

### GB5-003 — API and database profile

Measure:

- p50/p95/p99 read and write latency
- concurrent organizers
- schedule workspace payload size
- revision comparison time
- connection-pool behavior
- lock contention

### GB5-004 — Browser performance

Measure:

- Assisted Setup interaction latency
- format editor input latency
- schedule timeline interaction latency
- hydration and first meaningful content
- memory growth during long organizer sessions

### GB5-005 — Failure injection

Test:

- Redis unavailable before enqueue
- Redis unavailable after enqueue
- worker crash during optimization
- database reconnect
- browser offline during autosave
- duplicate command retry
- stale revision on publication

## Phase 5 QA/QC

### Required evidence

- reproducible load profiles
- defined thresholds with PASS/FAIL results
- no silent data corruption
- no orphan active job after worker recovery
- no duplicate accepted revision on retry
- bounded log and telemetry cardinality

### Exit criteria

- thresholds documented
- all P0/P1 reliability failures closed
- Verdict: PASS

---

# Phase 6 — Production AI boundary

## Objective

Make the AI promise truthful without allowing AI to own competition truth.

## Decision gate

Choose one:

### Option A — Production provider adapter

Implement:

- provider-neutral adapter
- explicit production configuration
- structured response schema validation
- timeout and bounded retry
- privacy-safe logs
- request fingerprint cache
- quota and race accounting
- provider/model version metadata
- cost and latency metrics
- manual fallback

### Option B — Production AI disabled

- keep manual setup fully functional
- hide or label AI as unavailable
- remove production marketing claims
- preserve the provider abstraction for later activation

## Phase 6 QA/QC

- prompt-injection and malformed-output tests
- timeout and provider-outage tests
- quota-race tests
- no raw organizer brief in audit, logs, analytics, or provider metadata
- deterministic validation of every accepted field
- cached and failed requests are not charged
- manual flow remains complete when AI is unavailable

### Exit criteria

- production behavior matches the chosen option
- P0: 0
- P1: 0
- Verdict: PASS

---

# Phase 7 — Staging foundation and external evidence

## Objective

Close the external Phase 0/1 blockers required before production claims.

## Work items

### GB7-001 — Identity provider evidence

- configured staging tenant
- PKCE/state/nonce exchange
- recovery flow
- password-change revocation event
- provider session ID revocation
- cookie and redirect verification

### GB7-002 — CDN and asset evidence

- trusted TLS certificate
- Brotli and gzip
- cache MISS then HIT for immutable assets
- private organizer responses bypass shared cache
- image negotiation
- purge-on-publish receipt
- security headers preserved

### GB7-003 — Telemetry and alerting

- hosted OTLP traces and metrics
- error alert routing
- schedule job failure dashboard
- queue depth and dead-letter alerts
- request correlation by request ID and trace ID

### GB7-004 — Backup and restore

- managed retention policy
- encrypted backups
- restore into isolated regional environment
- measured RPO and RTO
- restoration of migrations 0025/0026 data

### GB7-005 — Product and sport-domain approval

- one local organizer usability review
- one national organizer review
- sport-default review for all five sports
- privacy/public-data approval
- documented unresolved policy decisions

## Phase 7 QA/QC

- evidence includes dates, environment, provider, exact build, and receipts
- no screenshot-only claim where machine-readable evidence exists
- restore evidence includes data verification, not only successful command exit
- staging configuration is isolated from production
- no local/test secret or demo setting present

### Exit criteria

- Phase 1 external verdict rerun
- no open P0/P1 foundation blocker
- Verdict: PASS

---

# Phase 8 — Independent Gate B verdict

## Objective

Issue the final evidence-backed Gate B decision.

## Independent review inputs

- complete diff from `4b62a48`
- all migration files and populated-upgrade evidence
- local command logs
- authenticated full-stack browser evidence
- dependency audit
- accessibility report
- visual report
- performance report
- AI production-boundary decision
- staging external evidence
- residual-risk register

## Verdict rules

### PASS

Allowed only when:

- P0: 0
- P1: 0
- required phase evidence is reproducible
- dependency audit has zero unaccepted production advisories
- authenticated full-stack organizer journey passes
- external Phase 1 blockers required for the staging claim are closed

### FAIL

Required when any P0/P1 finding remains, evidence cannot be reproduced, or a required test is skipped without an approved scope change.

## Final deliverables

- `docs/qa/phase-4-final-verdict.md`
- updated traceability matrix
- updated acceptance record
- updated residual-risk register
- merge recommendation for PR #4
- explicit statement of which Gate C tasks remain

---

# Implementation tracking table

| Phase | Status | Verdict | Blocking items |
|---|---|---|---|
| 0 — Baseline | Not started | BLOCKED | complete checkout and local toolchain |
| 1 — Correctness | In progress | BLOCKED | execute remediation tests |
| 2 — Real E2E | In progress | BLOCKED | build harness and browser journey |
| 3 — Dependencies | Not started | BLOCKED | vulnerable dependency paths |
| 4 — UX/accessibility | Partially started | BLOCKED | reload behavior and visual policy |
| 5 — Reliability/performance | Not started | BLOCKED | thresholds and load evidence |
| 6 — Production AI | Not started | BLOCKED | provider or disable decision |
| 7 — External evidence | Not started | BLOCKED | identity/CDN/telemetry/restore/domain approvals |
| 8 — Independent verdict | Not started | BLOCKED | phases 0–7 |

# Immediate implementation slice

Work begins with Phase 2 infrastructure because the full-stack E2E gap is the strongest evidence problem and will validate several Phase 1 remediations simultaneously.

Initial commits should add:

1. a Gate B real-E2E Playwright configuration;
2. a Gate B real-E2E state contract;
3. a disposable PostgreSQL/Redis/API/scheduler/web orchestration script;
4. a focused authenticated browser journey;
5. database oracles for recommendation, format, schedule, publication, audit, and idempotency lineage;
6. root and package scripts to run the new gate locally.
