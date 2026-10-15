# Sports Competition Platform — Execution Roadmap

**Status:** Active — path to production readiness (re-baselined)

**Date:** 15 October 2026 (progress update; re-baselined 12 October 2026 from the 16 July 2026 planning baseline)

**Source specification:** `docs/archive/sports_competition_platform_implementation_plan.md` (version 2.0, 16 July 2026)

**Release target:** Production-ready public paid release (Gate F, then Launch Readiness checkpoint L)

**Live environment:** `https://matchday.poladex.shop` (OCI VM, US West — Phoenix; web on Vercel `sfo1`)

## 1. How to read this document

- **Sections 2–4** keep the original release contract, architecture baseline and design direction. They remain the requirements authority alongside the source specification.
- **Section 5** records where the project actually is on 15 October 2026: what is certified, what is deployed, and what the October mock-tournament simulation proved.
- **Section 6** is the forward plan: release tracks R1–R8, each with deliverables and measurable checkpoints, ending at production readiness.
- **Sections 7–10** cover ownership, QA/QC protocol, external decisions, and the risk register.

A phase or track is complete only when every checkpoint listed for it has evidence. "Mostly done" is not a status.

## 2. Release-contract resolutions

These resolutions use the more inclusive interpretation where the source conflicts, so implementation does not silently narrow the stated MVP.

| Conflict                                                             | Execution resolution                                                                                                                        | Source evidence                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Draft retention says both "one month" and "30 calendar days"         | Use one calendar month from the latest edit, matching the current product requirement and month-end behavior.                               | Source lines 64–67, 1209–1216, 3153          |
| Double elimination is an MVP stage but P1 and deferred               | Deliver in Phase 6, after the core formats and before the pilot gates.                                                                      | Source lines 923–934, 2583–2587, 3149        |
| Possible future matches are MVP but P1 and ungated                   | Deliver before Gate F; "My next match" remains the earlier Gate C path.                                                                     | Source lines 319–331, 1383–1397, 2747–2754   |
| Affected-match repair is a confirmed core journey but P1 and ungated | Treat local affected-match repair as a Gate C requirement. Wider optimisation may follow.                                                   | Source lines 63–67, 737–745, 2672–2674       |
| Offline scoring is required but its policy is unconfirmed            | Adopt the recommended default for implementation: up to four hours, only for an already-opened match; validate with partners before Gate C. | Source lines 1303–1330, 2484, 3140–3142      |
| Audit and full JSON exports are MVP but P1                           | Audit foundations ship in Phase 1; full competition JSON ships before Gate F.                                                               | Source lines 1404–1416, 2491–2520, 2789–2794 |
| Gate A requires standings tests before Phase 8                       | Pull the sport-neutral standings kernel and invariant tests into the domain-engine phase.                                                   | Source lines 2731–2743, 2978–2988            |
| Gate C requires printable fallback before Phase 10/11                | Pull schedule and score-sheet printing into the event-operation phase.                                                                      | Source lines 2787–2794, 2824, 3002–3014      |
| Organiser Pro is MVP but P1                                          | Keep the entitlement in the Gate F release contract; its price remains configuration.                                                       | Source lines 333–340, 2770–2775              |
| Official assignment is implied but formal tracking is deferred       | MVP uses match-scoped access links. SCH-006 official availability constraints were delivered early (PR #50, ADR 0006).                      | Source lines 660, 1111–1123, 3146            |

Any later scope reduction requires an explicit decision record rather than a backlog priority change. Scope reductions already recorded: ADR 0003 (legal approval deferred to Gate F), ADR 0004 (Gates D/E automated-only), ADR 0005 (Gate F automated-only, legal approval deferred to first commercial release), and the V1 recovery audit (`docs/V1_RECOVERY_AUDIT.md`), which hid offline replay, repair workspace, AI setup and advanced schedule tools from the V1 surface.

## 3. Architecture baseline

The architecture is a modular monolith plus isolated workers.

### Repository shape (as built)

```text
apps/
  web/                 Next.js 16 organiser, official PWA, public, and marketing surfaces (Vercel)
  api/                 Fastify 5 modular TypeScript API (HTTP, SSE) — runs the scheduler inline
  scheduler/           Constraint-solver worker (domain-optimizer, solver threads, yield deadline)
  worker/              BullMQ jobs (email, notifications, background tasks)
packages/
  domain/              Pure deterministic rules: formats, scoring, standings, schedule constraints
  database/            PostgreSQL migrations (0001–0071 on `main`; 0072 in PR #100, 0073 in PR #103), repositories, factories
  ui/                  Accessible primitives, tokens, i18n catalogue
  contracts/           Versioned API schemas and shared types
  config/              Typed environment and feature-flag definitions
  ai/                  AI provider port, schema validation, accounting, audit
  notifications/       Email (SMTP via Resend) and in-app notifications
  observability/       Logging, metrics, tracing (OTLP), Sentry, request IDs
infra/
  oci/                 Production compose, blue/green deploy, Caddy, backups, restore drill
docs/
  decisions/           Architecture and product decision records (ADR 0001–0006 on `main`; 0007–0009 proposed in open PRs)
  qa/                  Phase evidence and independent QA/QC verdicts
```

### Technology as deployed

| Concern   | Choice                                                                                  |
| --------- | --------------------------------------------------------------------------------------- |
| Workspace | pnpm + Turborepo                                                                        |
| Web       | Next.js 16 / React 19 on Vercel (`sfo1`)                                                |
| API       | Fastify 5, Node 24, Docker on OCI ARM VM, blue/green slots behind Caddy 2.11            |
| Data      | PostgreSQL 18.4, Redis 8.10                                                             |
| Solver    | In-house deterministic greedy constructor in TypeScript (worker threads), see Track R3  |
| Email     | Resend SMTP, sender `no-reply@matchday.poladex.shop`, restricted send-only key          |
| Errors    | Sentry (`matchday-web`, `matchday-api`)                                                 |
| Payments  | Stripe (separate MATCHDAY account, test mode)                                           |
| Identity  | OIDC (Auth0)                                                                            |
| Backups   | Nightly age-encrypted dumps to OCI Object Storage `matchday-backups`; quarterly drill   |
| CI        | GitHub Actions; arm64 image builds to GHCR; protected `main` with seven required checks |

The original baseline proposed a Python CP solver. The shipped solver is a TypeScript greedy constructor. Track R3 decides whether to add local search, CP-SAT, or both, and records the decision as an ADR.

### Non-negotiable engineering rules

- Deterministic domain packages own capacity, format validity, match generation, scores, standings, advancement, and schedule publication rules.
- AI only proposes schema-validated inputs; it never decides official outcomes.
- Every mutation is authorised, idempotent where retryable, audited, correlated with a request ID, and covered by a structured error contract. **Server errors (5xx) for invalid user input are defects.**
- Authorisation is tenant-, competition-, and match-scoped on every object access; role checks alone are insufficient.
- Score events and audit events are append-only. Corrections create new events.
- Scoring uses server-issued lease generations or fencing tokens, client event UUIDs, aggregate versions, and unique sequence constraints.
- Finalisation atomically appends the event, advances the aggregate version, updates the result projection, recalculates standings and advancement, records conflicts, audits the mutation, and writes the outbox event.
- Public result publication and schedule publication are separate transactions.
- Public projections carry a monotonic publication version.
- Schema migrations use expand-contract and are checksummed; applied migrations are never edited.
- QR passes are high-entropy opaque secrets stored only as hashes.
- Soft scheduling preferences may lower a schedule's score but must never cause "no solution" (established by PR #99).
- Readiness checks only dependencies required for the traffic served, so an AI outage cannot remove scoring capacity.

## 4. Product-design direction

### Visual thesis

Event-day control room meets modern sports editorial: calm graphite and warm neutral surfaces, one signal accent, high-contrast score typography, and no decorative clutter during live operation. The October 2026 redesign restructured the product and kept the brand.

### Surface-specific rules

| Surface            | Direction                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Marketing          | Full-bleed sports photography, unmistakable product name, concise promise, and a direct create-competition action                          |
| Organiser          | Card-light operational workspace with stable navigation, clear status, strong tables and timelines, and a contextual inspector             |
| Official scoring   | Phone-first, outdoor-readable contrast, minimum 48 px targets, visible writer and sync state, reversible actions, and no ornamental motion |
| Public competition | Score and next-match first, semantic tables and brackets, visible freshness, resilient server render, and shareable deep links             |

### Design-system contract

- No more than two sans-serif families and one restrained accent colour.
- Semantic tokens for surface, text, action, success, warning, danger, focus, score state, conflict, and offline state.
- No state relies on colour alone.
- Loading, empty, error, offline, conflict, read-only, and permission-denied states exist for every flow.
- Every drag-and-drop action has a non-drag alternative.
- WCAG 2.2 AA is a release requirement.
- Product and scoring surfaces respect reduced motion; frequent actions respond in under 200 ms.

## 5. Current status (15 October 2026)

### 5.1 Original phases and gates

| Phase / gate                        | Recorded status                                                                                                    | Evidence                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Phase 0 — validation                | Partial: prototype and validation-pack scopes `PASS`; full Phase 0 gate not passed (design partners not committed) | `docs/qa/phase-0-*-verdict.md`            |
| Phase 1 — foundation                | `FAIL` on formal exit evidence; engineering implementation green                                                   | `docs/qa/phase-1-verdict.md`              |
| Phase 2 — Canoe Polo vertical slice | `PASS`                                                                                                             | `docs/qa/phase-2-verdict.md`              |
| Phase 3 — domain engine, Gate A     | `PASS` (local)                                                                                                     | `docs/qa/phase-3-verdict.md`              |
| Phase 4 — organiser alpha, Gate B   | Verdict recorded with follow-ups                                                                                   | `docs/qa/phase-4-verdict.md`              |
| Phase 5 — event operation, Gate C   | `BLOCKED — NO CURRENT CERTIFICATION`; offline replay and repair hidden from the V1 surface                         | `docs/qa/gate-c-current-status.md`        |
| Phase 6 — commercial completeness   | Implemented; evidence recorded                                                                                     | `docs/qa/phase-6-final-evidence.md`       |
| Phase 7 — Gates D and E             | Automated-only profile (ADR 0004); human and physical-device items `WAIVED_NOT_EXECUTED`                           | ADR 0004, `docs/qa/gate-e-*`              |
| Phase 8 — production ops, Gate F    | Ops controls implemented (OPS-002, OPS-015, OPS-018 merged); no Gate F certification for the current candidate     | ADR 0005, `docs/qa/gate-f-*template.json` |

### 5.2 Production platform work completed since September

| Area            | Done                                                                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness fixes | Week-1 (PR #71) and week-2 (PR #72) hardening from the full audit, including the redesign                                                                                                                                                                         |
| Hosting         | Render removed; OCI US West VM with blue/green deploys; Vercel production branch `main`, region `sfo1`; arm64 image builds (PR #82, #83)                                                                                                                          |
| Infrastructure  | Boot volume grown to 100 GB; legacy C5 services removed; Caddy 2.11 pinned with drift guard (PR #93)                                                                                                                                                              |
| Backups         | Nightly encrypted backup to OCI Object Storage; restore drill passes; quarterly drill scheduled (PR #88)                                                                                                                                                          |
| Email           | Resend domain verified; reply-to support (PR #92); delivery confirmed to inbox                                                                                                                                                                                    |
| Error tracking  | Sentry web and API projects live                                                                                                                                                                                                                                  |
| Payments        | Stripe test-mode account with webhook events configured                                                                                                                                                                                                           |
| Dependencies    | Dependabot batch merged (PR #88); major Node updates ignored by policy                                                                                                                                                                                            |
| Production      | `cbcefa91` live: `https://matchday.poladex.shop/api/v1/meta/build` reported `git_sha` `cbcefa91a3c07be27b3e1eb6b0180e6b901f9f75` (built 15 Oct 2026 05:48 UTC), which includes #103, #111 (`cf751896`), #112 (`6a0220eb`), #116 and #118; migrations through 0074 |

### 5.3 Mock-tournament simulation (11 October 2026)

A full simulation ran about 12 competitions across all five sports against the real API (4,395 calls): round robins, a 104-match two-day canoe polo event, officials' availability, infeasible venues, organiser edits and locks, concurrent live scoring, disruptions, withdrawals, and every AI feature.

**Proven working:** hard schedule validity (no team or court double-booking, official availability respected); concurrent scoring; public version token changes on every point; takeover and correction; five-sport scoring rules.

**Defects found and their state:**

| Defect                                                                                                     | Severity | State                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Schedule options endpoint always returned 500                                                              | Critical | Fixed — PR #97 (merged)                                                                                                                  |
| Group winners never advanced into the knockout bracket                                                     | Critical | Fixed — PR #97 (merged)                                                                                                                  |
| Walkover/withdrawal read back as 0-0; withdrawal returned 500                                              | High     | Fixed — PR #98 (merged)                                                                                                                  |
| Every manual move rejected after regenerating around locks                                                 | High     | Fixed — PR #98 (merged)                                                                                                                  |
| Manual recalculation did not fill knockout winner/loser slots                                              | High     | Fixed — PR #98 (merged)                                                                                                                  |
| Missing scoring fields and free-plan cap returned 500                                                      | Medium   | Fixed — PR #98 (merged)                                                                                                                  |
| Soft preferences caused false "no solution"                                                                | High     | Fixed — PR #99 (merged)                                                                                                                  |
| Default 4-matches-per-day limit broke recommended formats                                                  | High     | Fixed — PR #99 (merged)                                                                                                                  |
| No-solution diagnostics covered officials only                                                             | Medium   | Fixed — PR #99 (merged)                                                                                                                  |
| Scheduling slow (12–33 s per job; 4× slower after #99)                                                     | High     | Fixed — PRs #99, #100 (merged); S2 8.6 s in `docs/qa/r3-scheduler-benchmark.md`                                                          |
| Schedules: many back-to-backs, uneven courts, long days                                                    | Medium   | Fixed — PRs #100, #102 (merged)                                                                                                          |
| Re-planning moved 14 of 28 matches when 4 needed to move                                                   | Medium   | Fixed on the benchmark fixture — PR #100 (merged); scenario 7 via the API still moves some undisplaced Court 1 matches in time (see CP2) |
| Format suggestions not checked against the venue                                                           | Medium   | Fixed — PR #100 (merged)                                                                                                                 |
| No warning when capacity changes after publishing                                                          | Medium   | Fixed — PR #103 (merged)                                                                                                                 |
| Stale repair cases stay in the pending list                                                                | Medium   | Fixed — PR #103 (merged)                                                                                                                 |
| AI quota shows "exhausted" while usage view shows units left                                               | Medium   | Fixed — PR #111 (merged; R4.4, migration 0074)                                                                                           |
| Stub double-elimination change fails schema validation                                                     | Low      | Fixed — PR #111 (merged; stub removed, R4.1)                                                                                             |
| Semifinals stored with stage "quarterfinal" (migration 0034)                                               | Low      | Fixed — PR #103 (migration 0073); archived-competition backfill fix PR #118 (merged)                                                     |
| Fresh DB needs undocumented `SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT`                      | Low      | Fixed — PR #101 (merged)                                                                                                                 |
| Walkover scoreboard shows empty games, not the forfeit score                                               | Product  | Decided ADR 0008; implemented — PR #103 (merged)                                                                                         |
| Standings show one division table instead of one per group                                                 | Product  | Decided ADR 0008; implemented — PR #103 (merged)                                                                                         |
| V1 bracket resolver always reported `championEntryId: null` (found by R1)                                  | Medium   | Fixed — PR #109 (merged 14 Oct)                                                                                                          |
| Scoring append returned 500 on transient DB errors (original 500 not reproduced)                           | Medium   | Fixed — PR #110 (merged; 503 `SERVICE_BUSY`)                                                                                             |
| Capacity PUT accepted another competition's playing-area ids (cross-tenant IDOR write, introduced in #103) | Critical | Fixed — PR #116 (merged 15 Oct, before any deploy of #103)                                                                               |

**AI finding:** every AI feature is a deterministic stub (`PHASE4_AI_PROVIDER=disabled|stub`). The plumbing (schema validation, retries, cache, charging, quotas, audit, proposal-only application) is real; the outputs are canned. Two stub features charge credits for no-op or unusable output. R4 audit (14 Oct): the production provider is disabled, so no credits are charged today; the real exposure is the Stripe AI top-up selling credits that cannot be used. Track R4 resolves this.

## 6. Path to production readiness

### 6.1 Definition of "production ready"

The platform is production ready when all of the following hold for one exact Git SHA:

1. Every track R1–R7 checkpoint below has evidence.
2. A full simulated tournament (groups → knockouts → final, all five sports, disruptions, withdrawals) runs as one command with zero 5xx responses and zero manual database writes.
3. Scheduling meets the performance and quality targets in Track R3.
4. No open Critical or High defects; every Medium defect is fixed or has a recorded decision.
5. Uptime, backup and error alerting reach the owner within 5 minutes.
6. Legal pages carry real entity details, Stripe is in live mode, and production identity enforces MFA for organisers' high-risk actions and platform administrators.
7. Gate F is recertified for the candidate SHA under ADR 0005, with waived human items recorded truthfully.

### 6.2 Track overview

| Track | Goal                                           | Depends on   | Target window       | Checkpoint         | Status (15 Oct, late)                                                              |
| ----- | ---------------------------------------------- | ------------ | ------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| R1    | Correctness baseline and repeatable simulation | —            | 12–19 Oct 2026      | CP1                | Done — CP1 4 of 4 (box 4 via #117)                                                 |
| R2    | Competition-day robustness                     | R1           | 19 Oct – 2 Nov 2026 | CP2                | Merged — #103 (+ IDOR fix #116); CP2 2 of 5 (boxes 1, 2, 5 partial)                |
| R3    | Scheduler speed and quality                    | R1           | 12 Oct – 9 Nov 2026 | CP3                | Merged — #99, #100, #102; CP3 3 of 4 (box 4 partial)                               |
| R4    | AI: real provider or honest removal            | R3           | 2–23 Nov 2026       | CP4                | Merged — #111; CP4 complete (3 of 3, AI box N/A)                                   |
| R5    | Monitoring, alerting and operations            | —            | 12–26 Oct 2026      | CP5                | Merged — #112; CP5 1 of 5; alert tests and owner actions pending                   |
| R6    | Organiser UX, design system and code health    | R1, R2       | 2 Nov – 7 Dec 2026  | CP6                | PR #113: R6.4 done; R6.1/R6.2/R6.5 partial; R6.6 lab-only; R6.3 deferred; CP6 open |
| R7    | Commercial, legal and identity readiness       | owner inputs | by 7 Dec 2026       | CP7                | In review — PR #115 (docs and runbooks); CP7 0 of 4, owner inputs pending          |
| R8    | Release candidate, rehearsal and launch        | R1–R7        | 7–21 Dec 2026       | CP8 (Gate F) and L | Not started                                                                        |

Target windows are planning estimates. A checkpoint moves only when its evidence exists, not when the date arrives.

**Next actions (15 Oct 2026)**

1. Production runs `cbcefa91` (deployed 15 Oct 2026; see §5.2). Deploy again after #115 only if runtime code changes (it is docs plus legal copy).
2. Close the CP2 gaps: assert in scenario 7 that undisplaced matches keep their times (or make the API re-plan use the minimal-change mode that the benchmark proves); assert the public version token changes after a delay; add Mailpit delivery for the schedule-published email and a production test-competition run (R2.7).
3. CP3 box 4: add official-overlap and court/team overlap checks to every simulation scenario.
4. Finish #113 (R6) and merge #115 (R7 runbooks; the break-glass drill, live purchase, MFA and repository privacy remain owner actions).
5. Owner actions (CP5): deliberate API-stop alert test, skipped-backup heartbeat alert, Sentry test event and alert, offline backup key confirmation. Note `docs/operations/REPOSITORY_PRIVACY.md` (PR #115): the current CI (~56 billed min per PR run) does not fit the Free/Pro private-repo quota without mitigation.

---

### Track R1 — Correctness baseline and repeatable simulation

**Goal:** turn the one-off mock tournament into a permanent regression gate so these defects cannot return.

**Deliverables**

- R1.1 PRs #97, #98, and #99 merged (done).
- R1.2 A seed-and-simulate CLI (`pnpm simulate:tournament`, `pnpm simulate:tournament:fast`) that creates organisations, competitions, entries and officials through the API and plays scenarios 1–9 from the October report end to end with zero 5xx budget enforcement.
- R1.3 The required `tournament-simulation` job in `.github/workflows/ci.yml` runs the simulation against a fresh database: `fast` profile on every push to `main`, tag and PR touching `apps/api`, `apps/scheduler`, `packages/domain`, `packages/database`, `packages/contracts` or the workflow (path-filtered PRs skip the steps and still report success), `full` profile nightly (`schedule`, which runs only this job) and on `workflow_dispatch` with `simulation_profile=full`. The job also runs the boot-config check (`cp .env.example .env`, fresh migrate, `pnpm test:env-templates`).
- R1.3a Harness scope: requests go through `app.inject` with an identity stub (fixed organiser session, CSRF verifier always true) and raised rate-limit ceilings, so authentication, CSRF and rate limiting are **not** exercised by the simulation; they stay covered by the integration and browser suites.
- R1.4 A 5xx budget check: the simulation fails if any request returns 5xx (zero tolerance budget).
- R1.5 Document `SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING` and `SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT` in `.env.example` and verified clean environment template test suite.
- R1.6 Integration-test environment: suites that need `DATABASE_URL` (`account-data-rights`, `casual-routes`) fail loudly when unconfigured, preventing test runs from touching production/default databases.

**Checkpoint CP1 — Correctness baseline**

- [x] PRs #97, #98, #99 merged; `main` green on all required checks. Evidence: https://github.com/siewhean/Sports-Website/pull/97, https://github.com/siewhean/Sports-Website/pull/98, https://github.com/siewhean/Sports-Website/pull/99 (merged 12 Oct 2026); latest `main` CI run https://github.com/siewhean/Sports-Website/actions/runs/38268394882 succeeded (all jobs green; visual-baselines skipped by design).
- [x] `pnpm simulate:tournament` completes all nine scenarios locally and in CI with zero 5xx responses. Evidence: local 14 Oct 2026 fast 2,991 req / 66 s and full 7,216 req / 87 s, 0 5xx; CI PR run https://github.com/siewhean/Sports-Website/actions/runs/38557380027 (fast), dispatch https://github.com/siewhean/Sports-Website/actions/runs/38556014556 (full).
- [x] Groups → knockout → final advancement verified for championship-focus, full-placement and compact-knockout templates in all five sports (scenario 1, full profile: every match final in `/current`, bracket resolved). Evidence: dispatch run https://github.com/siewhean/Sports-Website/actions/runs/38556014556. The `championEntryId: null` bracket defect found here was fixed by PR #109 (merged 14 Oct 2026; `main` CI https://github.com/siewhean/Sports-Website/actions/runs/38572843275).
- [x] A fresh clone boots against a fresh database using only `.env.example` values. Evidence: https://github.com/siewhean/Sports-Website/pull/117 (merged 15 Oct 2026, `ce5d08a7`); CI step "Fresh boot check (API + web from .env.example only)" boots the real API and web on a freshly migrated DB (health/ready 200, public API 200, web `/` 200): https://github.com/siewhean/Sports-Website/actions/runs/38681028139/job/116247608893.

---

### Track R2 — Competition-day robustness

**Goal:** an organiser can handle the things that go wrong on the day without developer help.

**Deliverables**

- R2.1 Capacity-change warning: closing a court or shrinking a venue window after publishing shows the affected matches and offers re-planning; the public page stops showing the closed court once the new revision publishes.
- R2.2 Delay and overrun tool: shift a court's or the whole day's remaining matches by N minutes, as a schedule revision with minimal change.
- R2.3 Repair queue hygiene: repair cases close or mark stale when their trigger is resolved or superseded.
- R2.4 Fix semifinal stage labelling (new migration; never edit 0034).
- R2.5 Product decisions, each recorded as an ADR or in `docs/product`:
  - walkover display (show forfeit score vs. "W/O" label);
  - per-group standings tables vs. one division table;
  - whether recommended formats may be shown when not schedulable.
- R2.6 Offline scoring decision: either re-enable and certify offline replay for Gate C, or record an ADR keeping V1 online-first with the printed fallback as the documented contingency.
- R2.7 Notifications test: schedule-published, match-reminder and result emails verified in Mailpit locally and in production with a test competition.

**Checkpoint CP2 — Competition-day robustness**

- [ ] Simulation scenario 7 (court closure mid-day) re-plans with only the affected matches moved and the public page updated. Partial: `apps/api/scripts/simulate-tournament.ts` scenario 7 asserts that no match remains on the closed court, that exactly the displaced matches change court, and that the public projection reflects it (https://github.com/siewhean/Sports-Website/pull/103). It does not assert that undisplaced matches keep their times: the script itself records that the solver moves 4–7 undisplaced Court 1 matches in time, logging `time-shifted-on-court-1` without asserting it. The R3 benchmark fixture proves minimal change (#100), but the API path in scenario 7 does not yet.
- [ ] Delay tool shifts remaining matches and the public version token changes. Partial: the shift is proven (scenario 7 asserts +60 min in public `/current`; `apps/api/tests/integration/schedule-delay.test.ts` "applies a valid delay to only the matches from the chosen time onward", https://github.com/siewhean/Sports-Website/pull/103). No test asserts that the public version token or ETag changes after a delay.
- [x] Simulation scenario 8 (withdrawal) shows correct standings, forfeits and bracket. Evidence: `simulate-tournament.ts` scenario 8 asserts the walkover snapshot is final, the entry is withdrawn, exact winner/loser standings rows, the winner in `advancement_slots` and placed in the downstream knockout match (https://github.com/siewhean/Sports-Website/pull/103; `main` CI https://github.com/siewhean/Sports-Website/actions/runs/38672550012).
- [x] R2.5 and R2.6 decisions recorded and implemented. Evidence: `docs/decisions/0008-competition-day-robustness-product-decisions.md` (R2.5) and `docs/decisions/0009-v1-online-first-scoring-and-printable-contingency.md` (R2.6), PR https://github.com/siewhean/Sports-Website/pull/103; W/O badge and per-group tables tested in `apps/web/tests/phase-2-walkover-groups.spec.ts` and `public-competition-render.test.tsx`. Gaps: ADR 0008's "N slots required vs M available" badge is shown only as "Does not fit the schedule", and ADR 0009 names `/export/scoresheet` while the real route is the per-match `/exports/matches/:matchId/score-sheet`.
- [ ] Notification emails arrive for each trigger. Partial: `qa-tournament-regressions.test.ts` delivers the result email (with W/O text) and the match reminder (opt-out honoured) to Mailpit; the schedule-published trigger is asserted only as an outbox row (`phase-2-runtime.test.ts`), and no production test-competition delivery is evidenced.

---

### Track R3 — Scheduler speed and quality

**Goal:** fast, valid, good schedules and honest explanations when no schedule fits.

**Deliverables**

- R3.1 Feasibility first (PR #99): soft preferences never block a schedule; derived daily-match default; capacity, daily-limit, rest and dependency diagnostics with team, court and day names; clear publish error for insufficient capacity.
- R3.2 Speed (PR #99): one persistent worker per job instead of new threads per iteration; profiled hot paths; precomputed slot and conflict indexes.
- R3.3 Quality (PR #100): deterministic local-search improvement after construction; objective terms for day length, late finishes, court balance, back-to-backs and rest fairness; locked matches never move.
- R3.4 Minimal-change re-planning (PR #100) for repairs and regenerations.
- R3.5 Schedule-aware format suggestions (PR #100): each suggestion checked against courts, venue windows and days within a hard time budget; feasible first; round robin offered when it fits; `not_checked` on timeout. The request path is bounded and rate-limited.
- R3.6 Benchmark suite: the October scenarios stored as fixtures, with metrics tracked per PR (time, score, back-to-backs, minimum and average rest, rest spread, day length, court spread, matches moved).
- R3.7 Solver ADR: record whether CP-SAT (or another exact solver) is needed after local search, based on benchmark results.

**Targets (measured on CI runners using the benchmark fixtures)**

| Metric                                                       | October baseline              | Target                         |
| ------------------------------------------------------------ | ----------------------------- | ------------------------------ |
| False "no solution" on feasible problems                     | Frequent                      | 0 across all fixtures          |
| 8-team round robin, 2 courts, 1 day — job time               | ~26 s                         | ≤ 5 s                          |
| 104-match canoe polo, 4 courts, 2 days — job time            | ~29 s (55 s after #99 ladder) | ≤ 15 s                         |
| Back-to-backs, 8-team round robin with 30-min rest preferred | 21                            | 0 when capacity allows         |
| Re-planning after one court closes (28 matches)              | 14 moved                      | Only affected matches moved    |
| Format suggestion check                                      | Not checked                   | ≤ 2 s per request, bounded     |
| Infeasible problems                                          | Vague or no diagnostic        | Named cause and the fix needed |

**Checkpoint CP3 — Scheduler**

- [x] PRs #99 and #100 merged with CI green. Evidence: https://github.com/siewhean/Sports-Website/pull/99 (merged 12 Oct, `main` CI https://github.com/siewhean/Sports-Website/actions/runs/38268394882); https://github.com/siewhean/Sports-Website/pull/100 (merged 14 Oct; PR CI https://github.com/siewhean/Sports-Website/actions/runs/38638515631 green; its `main` run was cancelled when superseded by #102's merge run https://github.com/siewhean/Sports-Website/actions/runs/38644445776, which passed).
- [x] Every target above met on the benchmark suite, with results attached to the PR or `docs/qa`. Evidence: `docs/qa/r3-scheduler-benchmark.md` (https://github.com/siewhean/Sports-Website/pull/102): 0 of 32 feasible fixtures false `no_solution`; S1 0.56 s, S2 8.61 s; S1 back-to-backs 0; S7 re-plan moves 3 for 3 displaced (asserted in `benchmark.test.ts`); worst format check 330 ms; all 6 infeasible fixtures name cause and fix. Caveat: timings are from a local run on 12 Oct; CI asserts CPU time on reduced iterations.
- [x] Solver ADR recorded. Evidence: `docs/decisions/0007-scheduler-solver-strategy.md` (https://github.com/siewhean/Sports-Website/pull/102).
- [ ] Hard validity unchanged: zero team, court or official overlaps across all fixtures and simulation runs. Partial: the benchmark runs `validateSchedule` on every feasible fixture; in the simulation only scenario 2 checks court and team overlaps, and no simulation run checks official overlaps.

---

### Track R4 — AI: real provider or honest removal

**Goal:** no feature presents canned output as AI, and no credit is charged for nothing.

**Deliverables**

- [x] R4.1 Immediate: hide or disable the stub AI features that charge credits (format modify, schedule preferences, repair recommendations). The deterministic v1 format recommendations stay; label them as rules-based suggestions.
- [x] R4.2 Provider decision ADR recorded (`docs/decisions/0010-launch-without-ai-template-explanations.md`) and its decisions implemented: launch with no AI provider, AI top-up checkout rejected (`409 AI_TOP_UP_UNAVAILABLE`, historical webhooks still replay), unused `GET …/ai/usage` removed. Building the template explanations themselves is still to do.
- R4.3 If a provider is chosen post-launch:
  - a provider class behind `AiProviderPort` and a new `PHASE4_AI_PROVIDER` value;
  - prompt templates for format changes, schedule preferences and repair, mapped onto the real format-graph, constraint and move schemas;
  - every AI proposal validated by the domain validator and solver before it is shown;
  - no charge for no-op, invalid or rejected results;
  - evaluation sets, prompt-injection tests, timeouts, cost budget and per-organisation quotas;
  - first focus: explaining no-solution diagnostics and repair trade-offs in plain language.
- [x] R4.4 Quota display mismatch fixed: one org-wide calculation (`phase6_org_ai_quota`, migration 0074) drives the pre-check, the finalize charge and the billing `ai_quota`; per-actor allowances are audit-only. The double-elimination schema failure is gone with the removed `modifyFormat` stub (R4.1).

**Checkpoint CP4 — AI**

- [x] No production feature charges credits for stub output. Evidence: `phase-4-runtime.test.ts` "R4.1: stub AI features (format modify, schedule preferences) fallback to manual at 0 cost" and "R4.1: repair recommendations return manual_fallback with 0 charge" (https://github.com/siewhean/Sports-Website/pull/111; stub provider throws outside local/test in `phase-4-ai-provider.ts`).
- [x] Provider ADR recorded (`docs/decisions/0010-launch-without-ai-template-explanations.md`, https://github.com/siewhean/Sports-Website/pull/111, merged 15 Oct).
- N/A — If AI ships: evaluation pass rate, injection tests and cost budget recorded; outputs remain proposal-only. (No AI at launch, ADR 0010.)
- [x] Quota display matches actual remaining units. Evidence: `phase-4-runtime.test.ts` "R4.4: one org-wide quota across two actors drives pre-check, charge and display; stub brief charged once"; `simulate-tournament.ts` scenario 9 compares the brief `usage` field with billing `ai_quota`.

---

### Track R5 — Monitoring, alerting and operations

**Goal:** the owner learns about outages, failed backups and errors before users do.

**Deliverables**

- R5.1 Better Stack uptime monitors for web app, API readiness (`/health/ready`), and public competition page, with phone/email alerts (`docs/runbooks/uptime-monitoring.md`).
- R5.2 Backup heartbeat: `BACKUP_HEARTBEAT_URL` wired into `matchday-backup.sh` so a missed nightly backup alerts within 24 hours (`docs/runbooks/uptime-monitoring.md`).
- R5.3 Sentry alert rules for new issues and error-rate spikes on web and API (`docs/operations/SENTRY.md`).
- R5.4 Status page linked from the site footer via `NEXT_PUBLIC_STATUS_PAGE_URL` (`apps/web/components/foundation/SiteChrome.tsx`).
- R5.5 Housekeeping:
  - remove `RENDER_API_ORIGIN` from Vercel and codebase (`docs/operations/VERCEL_PREVIEW.md`);
  - delete the unused Upstash database (`docs/operations/UPSTASH_CLEANUP.md`);
  - close draft PR #70 and triage stale open PRs (#7–#19, #55, #57, #58, #67–#70, #94–#96): merge, supersede or close each with a note;
  - decide on the untracked `production-certification.spec.ts` and `issue-pass-oci.cjs` (`docs/operations/LAUNCH_CHECKLIST.md`).
- R5.6 Quarterly restore drill with results logged in `docs/operations/RESTORE_DRILL_LOG.md` using `infra/oci/backup/restore-drill.sh` (scheduled; first drill 10 January 2027).
- R5.7 Store `~/matchday-backup.agekey` offline in two places (guidance in `docs/operations/OFFLINE_KEYS.md`; owner confirmation pending).

**Checkpoint CP5 — Operations**

- [ ] A deliberate API stop triggers an alert within 5 minutes. Not yet performed: the uptime runbook (https://github.com/siewhean/Sports-Website/pull/112) records "Last alert test: not yet conducted", and its monitor settings (3-minute checks, alert after 2 failures) would need tightening to meet 5 minutes.
- [ ] A skipped backup triggers a heartbeat alert. Note: Better Stack heartbeat "matchday nightly backup" (24 h, 2 h grace) wired via `BACKUP_HEARTBEAT_URL` and verified by a real backup run on 14 Oct 2026 outside the repo; no linkable evidence, and a skipped-backup alert is not yet shown.
- [ ] A test error reaches Sentry and alerts. Procedure and alert rules documented in `docs/operations/SENTRY.md` (https://github.com/siewhean/Sports-Website/pull/112); no test event recorded yet.
- [x] Open-PR list contains only active work. Evidence: `docs/qa/track-r5.md` (https://github.com/siewhean/Sports-Website/pull/112); 19 stale PRs closed; on 15 Oct 2026 https://github.com/siewhean/Sports-Website/pulls lists only #113, #114, #115 and Dependabot PRs.
- [ ] Backup key stored offline (owner confirms). Guidance in `docs/operations/OFFLINE_KEYS.md` (https://github.com/siewhean/Sports-Website/pull/112); owner confirmation pending.

---

### Track R6 — Organiser UX, design system and code health

**Goal:** an organiser who has never seen Matchday can run an event alone (audit weeks 3–4).

**Deliverables**

- R6.1 Organiser journey review: create → teams → format → schedule → publish → run day → finish, with friction removed and every error message naming the field and the fix. (Partial, PR #113: create-competition and entries errors name the field and fix; full journey friction review not done)
- R6.2 Design system: consolidate tokens and components; remove one-off styles; complete loading, empty, error, offline and permission states. (Partial, PR #113: state/role and component tokens in `packages/ui/src/tokens.ts`; touch-target, radius and focus-ring CSS vars adopted where values matched; component consolidation and one-off style removal not done)
- R6.3 Rename internal "phase" and "gate" identifiers in code and routes to product names, with no API contract break for live clients. (Not done / deferred: route aliases removed per audit feedback until frontend call sites migrate; user-facing copy cleaned)
- R6.4 Delete dead prototype code and the hidden V1-removed surfaces that will not return (per R2.6).
- R6.5 Accessibility: automated axe checks on every page at phone, tablet and desktop; keyboard-only run of the organiser journey. (PR #113: axe on 9 key routes × 4 Playwright projects plus a keyboard-only create-competition run; organiser routes use demo fixtures, not a signed-in session; not every page)
- R6.6 Performance: public competition page and scoring page meet Core Web Vitals "good" on mobile. (Lab only, PR #113: CI asserts LCP ≤ 2.5 s and CLS ≤ 0.1 under Pixel 7 + Fast 4G emulation; measured LCP ~0.4 s, CLS 0.0012 after the font-fallback fix; no field data)

**Checkpoint CP6 — UX**

- [ ] A first-time organiser walkthrough (owner, recorded) completes a 16-team event setup in under 15 minutes with no help.
- [ ] Zero WCAG A/AA axe violations on all routes. (Partial: zero violations on the 9 key routes in `tests/responsive-pages-accessibility.spec.ts` and the other `tests/*accessibility.spec.ts` suites, organiser routes on demo fixtures; not yet all routes)
- [ ] No `phase`/`gate` names in user-visible text or URLs. (Not done: internal phase/gate API routes remain in use; user-visible copy cleaned).
- [ ] Dead code removed; bundle size and test count recorded before and after. Evidence: `docs/qa/track-r6.md`.

---

### Track R7 — Commercial, legal and identity readiness

**Goal:** the platform can lawfully take money from real organisers.

**Deliverables**

- R7.1 Legal: replace placeholders in terms, privacy and cookie pages with the legal entity, address, support contact and jurisdiction.
- R7.2 Domain decision: stay on `poladex.shop` or move to a product domain. Hostnames are config-driven, so the move is a configuration change plus DNS, email domain verification and OIDC callback updates.
- R7.3 Stripe live mode: live keys, live webhook endpoint and secret, live price IDs for Event Pass and Organiser Pro, and a refunded live test purchase.
- R7.4 Production identity: Auth0 production tenant with MFA for platform administrators and high-risk organiser actions; break-glass procedure documented.
- R7.5 Repository privacy: make the repository private and trim CI to fit the private-repo minutes budget (keep required checks; move heavy suites to nightly).
- R7.6 Formal legal/privacy approval recorded before the first commercial sale (ADR 0005).

**Checkpoint CP7 — Commercial**

- [ ] Legal pages contain no placeholders.
- [ ] One live purchase and refund completed and reconciled in the billing ledger.
- [ ] MFA enforced for administrators; break-glass tested once.
- [ ] Repository private; required checks still run on every PR.

---

### Track R8 — Release candidate, rehearsal and launch

**Goal:** prove the exact launch build works end to end, then launch.

**Deliverables**

- R8.1 Cut a release candidate SHA after CP1–CP7.
- R8.2 Full simulation (R1.2 full profile) against a staging copy of production on the candidate SHA.
- R8.3 Load test at expected peak (scoring devices, spectators) with p95 score-write and public-update latency recorded.
- R8.4 Live rehearsal: run one real small event (local club or friendly) on production, with the printed fallback ready.
- R8.5 Gate F recertification under ADR 0005 for the candidate SHA: deploy, rollback, restore, cache purge, alert routing and freeze drills.
- R8.6 Launch: deployment freeze rules active, on-call plan for the first two event weekends, and a post-launch review after the first three events.

**Checkpoint CP8 — Gate F**

- [ ] Simulation, load test and rehearsal pass on the candidate SHA.
- [ ] Gate F evidence bundle complete; waived items recorded as `WAIVED_NOT_EXECUTED`.
- [ ] Rollback and restore drills pass within the stated RPO/RTO.

**Checkpoint L — Launch readiness**

- [ ] CP1–CP8 all complete for the same SHA.
- [ ] Production-ready definition in §6.1 satisfied.
- [ ] Owner signs off the launch decision in `docs/qa`.

## 7. Source task ownership and gate mapping

Each source backlog task has one completion owner.

| Execution phase | Completion-owned source tasks                                                                 | Release checkpoint                       |
| --------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Phase 0         | VAL-001–010                                                                                   | Phase 0 validation gate                  |
| Phase 1         | FND-001–028                                                                                   | Foundation gate                          |
| Phase 2         | No automatic task closure; 14-step Canoe Polo integration milestone                           | Internal vertical-slice gate             |
| Phase 3         | CMP-001–018; SPT-001–015; CAP-001–009; FMT-001–003, 005–016, 024–026; RES-001–010             | Gate A                                   |
| Phase 4         | FMT-017–023; AST-001–010; AI-001–006, 010–015; SCH-001–005, 007–023, 027–028                  | Gate B                                   |
| Phase 5         | SCH-024–026; ACC-001–010; SCR-001–020; OFF-001–008; RES-011–020, 022–024; EXP-001–002; QA-018 | Gate C                                   |
| Phase 6         | FMT-004; AI-007–009, 016–017; RES-021, 025–032; BIL-001–014; EXP-003–006; ADM-001–007         | Commercial completeness before Gates D/E |
| Phase 7         | QA-001–017, 019–030                                                                           | Gates D and E                            |
| Phase 8         | OPS-001–018                                                                                   | Gate F                                   |
| Delivered early | SCH-006 official availability constraints (PR #50, ADR 0006)                                  | Covered by R3 benchmarks                 |

Mapping of the new tracks to source tasks:

| Track | Re-opens or extends                                             |
| ----- | --------------------------------------------------------------- |
| R1    | RES-001–010 (advancement), QA-001–017 (automated suite)         |
| R2    | SCH-024–026, RES-011–024, OFF-001–008 (decision), EXP-001–002   |
| R3    | SCH-001–023, SCH-027–028, FMT-024–026 (recommendations)         |
| R4    | AI-001–017                                                      |
| R5    | OPS-005–012                                                     |
| R6    | FND UI primitives, QA accessibility tasks                       |
| R7    | BIL-001–014, ADM-001–007, legal items deferred by ADR 0003/0005 |
| R8    | OPS-001–018, Gate F                                             |

Later-release product scope remains after launch: registration and participant payments, federation hierarchy and rule packs, national rankings, multi-sport collections, native apps, advanced statistics, team-manager disputes, venue marketplace, livestreaming, social feed, messaging, white-label portals, and sponsorship marketplace.

## 8. QA/QC protocol for every track

1. The implementing agent records requirement IDs, changed files, commands, screenshots, and residual risks in `docs/qa/track-<id>.md`.
2. Every bug fix ships with a regression test that fails without the fix; the PR states that it was seen failing.
3. A separate reviewer audits the diff, tests, runtime and visible UI, including terminal output and browser consoles.
4. UI changes require screenshots at phone, tablet and desktop sizes.
5. A checkpoint cannot pass on a narrow test if its criterion is broader. Missing or indirect evidence is a failure.
6. Human-only evidence that cannot be executed is recorded as `WAIVED_NOT_EXECUTED`, never `PASS` (ADR 0004/0005).
7. Pull requests merge only with all required checks green: `secrets`, `quality-fast`, `integration`, `browser-e2e (shard 1/2)`, `browser-e2e (shard 2/2)`, `gate-d-real-e2e`, `tournament-simulation`. Branches must be up to date with `main`.

Minimum automated gate:

```text
format
lint
typecheck
unit tests
integration tests (RUN_INFRA_TESTS=1, C-locale database)
solver tests and benchmark fixtures
tournament simulation (fast profile)
build
database migration check
end-to-end tests
accessibility checks
visual regression
dependency and secret scans
```

## 9. External evidence and owner decisions

Engineering can continue without these, but the dependent checkpoint cannot pass until each exists.

| Item                                                             | Needed for | State                                                                                                                                              |
| ---------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Stack account (heartbeat URL or API token)                | CP5        | Done 14 Oct: monitors, heartbeat, status page https://matchday-poladex.betteruptime.com                                                            |
| Legal entity, address, support contact, jurisdiction             | CP7        | Not yet available                                                                                                                                  |
| Product domain decision                                          | CP7        | Staying on `poladex.shop` for now (see `docs/operations/DOMAIN_DECISION.md`)                                                                       |
| Event Pass and Organiser Pro prices and currency                 | CP7        | Configuration; to confirm                                                                                                                          |
| Stripe live-mode activation                                      | CP7        | Pending (runbook documented in `docs/operations/STRIPE_LIVE_RUNBOOK.md`)                                                                           |
| Auth0 production tenant with MFA                                 | CP7        | Pending (break-glass runbook in `docs/operations/BREAK_GLASS.md`; drill not performed)                                                             |
| Repository privacy and CI minutes budget                         | CP7        | Pending owner decision; measured ~56 billed min per PR run exceeds the Free/Pro quota at current cadence (`docs/operations/REPOSITORY_PRIVACY.md`) |
| AI provider decision (or launch without AI)                      | CP4        | Decided — launch without AI (ADR 0010, PR #111 merged)                                                                                             |
| Walkover display, per-group standings, offline scoring decisions | CP2        | Decided — ADRs 0008/0009 (PR #103 merged)                                                                                                          |
| A real local event for the rehearsal                             | CP8        | Pending                                                                                                                                            |
| Expected peak load (competitions, scoring devices, spectators)   | CP8        | Pending                                                                                                                                            |
| Formal legal/privacy approval                                    | First sale | Deferred per ADR 0005, no approval obtained (see `docs/operations/LEGAL_APPROVAL.md`)                                                              |

## 10. Risk register

| Risk                                               | Impact | Mitigation                                                                                     |
| -------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| Single VM hosts API, database and Redis            | High   | Nightly encrypted backups, tested restore, uptime alerts (R5); revisit managed DB after launch |
| Scheduler regressions are invisible to unit tests  | High   | Benchmark fixtures and simulation in CI (R1, R3)                                               |
| Stub AI misleads paying users                      | High   | No production charge today (provider disabled); AI top-ups being disabled (R4)                 |
| Outages or errors missed (was: no alerting)        | Medium | Mitigated: Better Stack live 14 Oct; Sentry alert rules pending (R5)                           |
| Human testing waived (devices, pentest, reviewers) | Medium | Recorded as waived; live rehearsal event (R8.4) as partial mitigation                          |
| Public repository                                  | Medium | Make private with trimmed CI (R7.5); never commit secrets (secrets scan required)              |
| CI minutes budget after going private              | Medium | Nightly heavy suites, fast PR profile                                                          |
| Single operator for event days                     | Medium | Runbooks, printed fallback, deployment freeze during active competitions                       |
