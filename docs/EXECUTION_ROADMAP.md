# Sports Competition Platform — Execution Roadmap

**Status:** Planning baseline

**Date:** 16 July 2026

**Source specification:** `sports_competition_platform_implementation_plan.md`

**Source version:** 2.0 (16 July 2026)

**Release target:** Production-ready public paid release at Gate F

## 1. Review verdict

The source document is a strong product specification, but its backlog cannot be executed strictly in numbered order. Several MVP requirements are marked P1, Gate A requires standings before the standings phase, Gate C requires printable fallback before the export phase, and quality work is concentrated in Phase 11 even though the Definition of Done requires it on every task.

This roadmap preserves the full stated MVP and reorganises delivery around working, testable increments. The source specification remains the requirements authority; this roadmap is the execution and evidence authority.

## 2. Release-contract resolutions

These resolutions use the more inclusive interpretation where the source conflicts, so implementation does not silently narrow the stated MVP.

| Conflict                                                             | Execution resolution                                                                                                                        | Source evidence                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Draft retention says both “one month” and “30 calendar days”         | Use exactly 30 calendar days from the latest edit.                                                                                          | Source lines 64–67, 1209–1216, 3153          |
| Double elimination is an MVP stage but P1 and deferred               | Deliver in Phase 6, after the core formats and before the pilot gates.                                                                      | Source lines 923–934, 2583–2587, 3149        |
| Possible future matches are MVP but P1 and ungated                   | Deliver before Gate F; “My next match” remains the earlier Gate C path.                                                                     | Source lines 319–331, 1383–1397, 2747–2754   |
| Affected-match repair is a confirmed core journey but P1 and ungated | Treat local affected-match repair as a Gate C requirement. Wider optimisation may follow.                                                   | Source lines 63–67, 737–745, 2672–2674       |
| Offline scoring is required but its policy is unconfirmed            | Adopt the recommended default for implementation: up to four hours, only for an already-opened match; validate with partners before Gate C. | Source lines 1303–1330, 2484, 3140–3142      |
| Audit and full JSON exports are MVP but P1                           | Audit foundations ship in Phase 1; full competition JSON ships before Gate F.                                                               | Source lines 1404–1416, 2491–2520, 2789–2794 |
| Gate A requires standings tests before Phase 8                       | Pull the sport-neutral standings kernel and invariant tests into the domain-engine phase.                                                   | Source lines 2731–2743, 2978–2988            |
| Gate C requires printable fallback before Phase 10/11                | Pull schedule and score-sheet printing into the event-operation phase.                                                                      | Source lines 2787–2794, 2824, 3002–3014      |
| Organiser Pro is MVP but P1                                          | Keep the entitlement in the Gate F release contract; its price remains configuration.                                                       | Source lines 333–340, 2770–2775              |
| Official assignment is implied but formal tracking is deferred       | MVP uses match-scoped access links only. Formal official assignment and availability stay post-MVP.                                         | Source lines 660, 1111–1123, 3146            |

Any later scope reduction requires an explicit decision record rather than a backlog priority change.

## 3. Architecture baseline

The architecture will begin as a modular monolith plus isolated workers, matching the source recommendation at lines 1799–1978.

### Repository shape

```text
apps/
  web/                 Next.js organiser, official PWA, public, and marketing surfaces
  api/                 Modular TypeScript HTTP, SSE, and WebSocket API
  scheduler/           Isolated constraint-solver worker
packages/
  domain/              Pure deterministic rules, state machines, and shared types
  database/            PostgreSQL schema, migrations, repositories, and factories
  ui/                  Accessible primitives, tokens, and product components
  contracts/           Versioned API schemas and generated client types
  config/              Typed environment and feature-flag definitions
  observability/       Logging, metrics, tracing, audit, and request IDs
infra/
  local/               Repeatable local PostgreSQL, Redis, object storage, and mail
  deploy/              Staging and production deployment definitions
docs/
  decisions/           Architecture and product decision records
  qa/                  Phase evidence and independent QA/QC verdicts
```

### Recommended technology choices

| Concern       | Baseline                                                                          | Reason                                                                          |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Workspace     | pnpm workspaces with a task graph                                                 | Shared contracts with isolated builds and tests                                 |
| Web           | Next.js with TypeScript and server-rendered public pages                          | Cacheable discovery plus one responsive product surface                         |
| API           | Fastify-based modular TypeScript service                                          | Low-overhead HTTP, schema validation, OpenAPI, SSE, and WebSocket support       |
| Data          | PostgreSQL with a type-safe relational ORM                                        | Transactions, constraints, auditability, and mature operations                  |
| Queue/cache   | Redis-compatible store with durable jobs and dead letters                         | Schedule generation, email, cache, and retry isolation                          |
| Solver        | Python worker with a constraint-programming solver                                | Strong scheduling model without moving business truth out of the domain package |
| Offline       | Service worker plus IndexedDB event queue                                         | Durable phone scoring with ordered replay                                       |
| Realtime      | SSE for public reads; WebSocket lease channel for scoring                         | Appropriate directionality and graceful polling fallback                        |
| Tests         | Unit/property tests, API integration tests, browser E2E, solver tests, load tests | Evidence matches the risk of each subsystem                                     |
| Observability | OpenTelemetry-compatible traces, structured logs, error tracking, and metrics     | Vendor-neutral production evidence                                              |

Identity, payment, email, object-storage, hosting, analytics, error-tracking, and monitoring vendors are adapters behind contracts. Provider selection is locked in decision records before dependent implementation, not embedded in domain code.

### Non-negotiable engineering rules

- Deterministic domain packages own capacity, format validity, match generation, scores, standings, advancement, and schedule publication rules.
- AI only proposes schema-validated inputs; it never decides official outcomes.
- Every mutation is authorised, idempotent where retryable, audited, correlated with a request ID, and covered by a structured error contract.
- Authorisation is tenant-, competition-, and match-scoped on every object access; role checks alone are insufficient.
- Score events and audit events are append-only. Corrections create new events.
- Scoring uses server-issued lease generations or fencing tokens, client event UUIDs, aggregate versions, and unique sequence constraints. A transferred device's stale offline events become an explicit conflict and are never merged automatically.
- Finalisation atomically appends the event, advances the aggregate version, updates the result projection, recalculates standings/advancement, records conflicts, audits the mutation, and writes the outbox event.
- Public result publication and schedule publication are separate transactions.
- Public projections carry a monotonic publication version. Commit triggers cache invalidation; a client expecting a newer version reads from a confirmed-current projection rather than a lagging replica.
- Database and event publication use an outbox or equivalent atomic pattern.
- Public reads may degrade to stale cache; scoring writes may not depend on public traffic.
- Schema migrations use expand-contract and must be proven against the previous application version.
- QR passes are high-entropy opaque secrets stored only as hashes, exchanged for short-lived match sessions, and excluded from URLs after exchange, logs, analytics, and referrers.
- Deep health checks are private. Readiness checks only dependencies required for the traffic served, so an AI outage cannot remove scoring capacity.
- Realtime deployments drain connections and preserve scoring leases before terminating an application version.

## 4. Product-design direction

### Visual thesis

Event-day control room meets modern sports editorial: calm graphite and warm neutral surfaces, one signal accent, high-contrast score typography, asymmetric composition where it aids scanning, and no decorative clutter during live operation.

### Surface-specific rules

| Surface            | Direction                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marketing          | Full-bleed sports photography, unmistakable product name, concise promise, proof through real competition workflow, and a direct create-competition action |
| Organiser          | Card-light operational workspace with stable navigation, clear status, strong tables/timelines, and a contextual inspector rather than dashboard mosaics   |
| Official scoring   | Phone-first, outdoor-readable contrast, minimum 48 px targets, visible writer/sync state, reversible actions, and no ornamental motion                     |
| Public competition | Score and next-match information first, semantic tables and brackets, visible freshness, resilient server render, and shareable deep links                 |

### Design-system contract

- Use no more than two sans-serif families and one restrained accent colour.
- Define semantic tokens for surface, text, action, success, warning, danger, focus, score state, conflict, and offline state.
- Do not rely on colour alone; every state has text or icon support.
- Provide loading, empty, error, offline, conflict, read-only, and permission-denied states from the first implemented flow.
- Provide a non-drag alternative for every drag-and-drop action.
- WCAG 2.2 AA is a release requirement, including keyboard operation, screen-reader announcements, 400% reflow, visible focus, target size, and semantic schedule/bracket alternatives.
- Use transform and opacity for motion; frequent operational actions stay instant or under 200 ms.
- Marketing may use isolated scroll choreography. Product and scoring surfaces use CSS or WAAPI by default and respect reduced motion.
- Touch hover effects are gated to fine pointers. Keyboard actions do not wait for animation.
- Visual acceptance requires screenshots at phone, tablet, desktop, high-contrast, reduced-motion, loading, empty, error, and offline states where applicable.

## 5. Delivery phases

### Phase 0 — Product, policy, and design validation

**Scope:** VAL-001 through VAL-010, plus specification reconciliation and three interactive prototypes.

**Deliverables**

- Local and national competition artefact set with canonical 8/12/16/24/48 fixtures.
- Signed policy for minors, public fields, consent, retention, deletion, corrections, forfeits, withdrawals, and offline scoring.
- Confirmed Canoe Polo placement rules and configurable commercial parameters.
- Clickable wizard, format-designer, and phone-scoring prototypes.
- Brand direction, tokens, type scale, spacing, motion rules, component governance, and responsive behaviour.
- Decision records for identity, payments, email, storage, hosting, observability, analytics, and solver runtime.
- Signed contracts for scoring leases/fencing, offline transfer conflicts, publication versions, regional durability/RPO, object-level authorisation, and API style.
- Re-baselined source backlog whose MVP, priority, phase, and release-gate labels agree.

**Exit evidence**

- Requirements traceability has no unresolved P0 contradiction.
- At least one local organiser and one national-level organiser are committed design partners.
- Usability findings from spreadsheet-based organisers are recorded and high-severity issues are resolved.
- Independent QA/QC verdict: `PASS`.

### Phase 1 — Production foundation and design system

**Scope:** FND-001 through FND-028 plus reusable design primitives.

**Deliverables**

- Monorepo, local dependencies, typed configuration, CI, migration workflow, factories, and environment contracts.
- Identity, organisation membership, RBAC, session security, audit, request IDs, structured errors, rate limits, headers, and CORS.
- Queue, transactional email, in-app notifications, feature flags, observability, health endpoints, and backup/restore procedure.
- Accessible UI primitives, application shells, internationalised message catalogue, error pages, and visual-test harness.

**Exit evidence**

- Fresh-machine setup is reproducible.
- Lint, format, typecheck, unit, integration, build, migration, and secret scans pass in CI.
- Health endpoints and degraded dependency states behave as specified.
- Desktop, tablet, and phone shell screenshots pass visual and accessibility review.
- Independent QA/QC verdict: `PASS`.

### Phase 2 — Canoe Polo end-to-end vertical slice

**Scope:** The 14-step first implementation slice at source lines 3181–3201.

**Deliverables**

- Account, one Canoe Polo competition, one division, 8/16 entries, capacity, one group-to-knockout template, deterministic matches, basic schedule, publish, QR access, mobile scoring, standings, bracket, audit, and public page.
- This is an internal learning gate, not a claim that the full MVP is complete.

**Exit evidence**

- One canonical competition completes from creation through public final result.
- Score and standings calculations match independent fixtures.
- Phone scoring, correction, publication isolation, and recovery paths pass E2E tests.
- Independent QA/QC verdict: `PASS`.

### Phase 3 — Domain engine completeness and Gate A

**Scope:** CMP-001–018, SPT-001–015, CAP-001–009, FMT-001–003, FMT-005–016, FMT-024–026, and RES-001–010; all five sports and all five default sizes.

**Deliverables**

- Competition/division/entry lifecycle, imports, sport packs, overrides, capacity, format graph, revisions, templates, validation, deterministic match generation, recommendations, and standings invariants.
- This phase owns the domain and recommendation engines. It does not own the manual or drag-and-drop builder UI.

**Exit evidence**

- Property and invariant suites cover every sport and 8/12/16/24/48 fixtures.
- Invalid graphs cannot persist or publish.
- Capacity and match-count results remain deterministic across time zones and availability boundaries.
- Gate A checklist passes and receives an independent QA/QC `PASS`.

### Phase 4 — Organiser alpha and Gate B

**Scope:** FMT-017–023, AST-001–010, AI-001–006, AI-010–015, SCH-001–005, SCH-007–023, and SCH-027–028.

**Deliverables**

- Autosaving setup, non-AI fallback, equivalent stored graph from both builders, background solver, alternatives, timeline editor, mobile move flow, locks, comparisons, cancellation, and explicit publication.

**Exit evidence**

- Complete organiser E2E passes on phone, tablet, and desktop.
- Gate B free-plan enforcement is supplied by CMP-016 from Phase 3; tests prove the 16-entry cross-division limit and a non-destructive upgrade path.
- Solver constraints, cancellation, best-result retention, and revision isolation pass.
- User-like visual QA includes screenshots and browser-console review.
- Gate B checklist passes and receives an independent QA/QC `PASS`.

### Phase 5 — Event-operation beta and Gate C

**Scope:** SCH-024–026, ACC-001–010, SCR-001–020, OFF-001–008, RES-011–020, RES-022–024, EXP-001–002, and QA-018.

**Deliverables**

- One active writer with lease, transfer, revocation, fallback codes, ordered offline replay, conflict handling, corrections, critical downstream review, immediate public results, private schedule revisions, all public views, and printed fallback.

**Exit evidence**

- Concurrent-device, expired/revoked token, refresh/restart, four-hour offline, unsynchronised transfer, correction, and downstream-conflict suites pass.
- Public update p95 and score-write p95 meet pilot targets under load.
- Real iOS and low-end Android scoring has no terminal, browser-console, service-worker, or sync errors.
- Gate C checklist passes and receives an independent QA/QC `PASS`.

### Phase 6 — Commercial and operational completeness

**Scope:** FMT-004, AI-007–009, AI-016–017, RES-021, RES-025–032, BIL-001–014, EXP-003–006, and ADM-001–007.

**Deliverables**

- Double elimination, natural-language format and schedule changes, affected-match AI recommendations, prompt/model tracking, and AI cost monitoring.
- Idempotent billing ledger and reconciliation, configurable prices, all entitlements, full JSON export, possible future matches, support tooling, privacy controls, published policies, consent, search, marketing pages, and email infrastructure.

**Exit evidence**

- Entitlement bypass, webhook replay, reconciliation, refund/support adjustment, AI exhaustion, and export/re-import tests pass.
- Legal, privacy, SEO, email-deliverability, and accessibility reviews pass.
- Independent QA/QC verdict: `PASS`.

### Phase 7 — Pilots, security, and release hardening; Gates D and E

**Scope:** QA-001 through QA-030, local pilot, then national parallel pilot.

**Deliverables**

- Complete automated suite, load and endurance evidence, browser/device matrix, penetration test, backup restoration, incident/event-day runbooks, support process, and all pilot defect closures.

**Exit evidence**

- No unresolved critical or high-severity defects.
- Standings match manual calculations and officials score without developer intervention.
- Every organiser intervention and discrepancy is recorded and resolved.
- Gates D and E each receive a separate independent QA/QC `PASS`.

### Phase 8 — Production operations and Gate F

**Scope:** OPS-001 through OPS-018 and every pre-launch checklist item.

**Deliverables**

- Isolated production environment, zero-downtime pipeline, safe migrations, autoscaling, CDN purge, read replica, monitoring, alerts, status page, backups, cross-region recovery, SSL/DNS, deployment freeze, cost monitoring, and feature-flag administration.

**Exit evidence**

- Staging production simulation proves deploy, automatic rollback, restore, failover, cache purge, alert routing, and disaster recovery.
- SLO dashboards hold baseline measurements and synthetic probes are live.
- Security, legal, accessibility, SEO, email, and operations evidence is current.
- Gate F and the full deployment checklist receive an independent QA/QC `PASS`.

## 6. Source task ownership and gate mapping

Each source backlog task has one completion owner. Phase 2 is deliberately an integration milestone: it exercises partial implementations from later-owned tasks but closes no source task unless that task's full source scope and Definition of Done are already satisfied.

| Execution phase | Completion-owned source tasks                                                                    | Release checkpoint                       |
| --------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Phase 0         | VAL-001–010                                                                                      | Phase 0 validation gate                  |
| Phase 1         | FND-001–028                                                                                      | Foundation gate                          |
| Phase 2         | No automatic task closure; 14-step Canoe Polo integration milestone                              | Internal vertical-slice gate             |
| Phase 3         | CMP-001–018; SPT-001–015; CAP-001–009; FMT-001–003, 005–016, 024–026; RES-001–010                | Gate A                                   |
| Phase 4         | FMT-017–023; AST-001–010; AI-001–006, 010–015; SCH-001–005, 007–023, 027–028                     | Gate B                                   |
| Phase 5         | SCH-024–026; ACC-001–010; SCR-001–020; OFF-001–008; RES-011–020, 022–024; EXP-001–002; QA-018    | Gate C                                   |
| Phase 6         | FMT-004; AI-007–009, 016–017; RES-021, 025–032; BIL-001–014; EXP-003–006; ADM-001–007            | Commercial completeness before Gates D/E |
| Phase 7         | QA-001–017, 019–030                                                                              | Gates D and E                            |
| Phase 8         | OPS-001–018                                                                                      | Gate F                                   |
| Post-Gate F     | SCH-006 formal official availability constraints, coupled to the later official-assignment model | Later-release backlog                    |

Quality task completion is owned in Phase 7, except QA-018, but relevant test coverage is an exit requirement in every earlier phase. Phase 7 expands and audits those suites; it does not postpone their creation.

Later-release product scope without source task IDs remains planned after Gate F: registration and participant payments, federation hierarchy/rule packs, national rankings, multi-sport collections, native apps, advanced statistics, team-manager disputes, venue marketplace, livestreaming, social feed, messaging, white-label portals, and sponsorship marketplace.

## 7. QA/QC protocol for every phase

1. The implementing agent records requirement IDs, changed files, commands, screenshots, and residual risks in `docs/qa/phase-<n>.md`.
2. A separate QA/QC agent that did not implement the phase audits the source requirements, phase exit criteria, diff, tests, runtime, and visible UI.
3. The reviewer must inspect terminal output and browser or simulator consoles and record any warning or error relevant to the phase.
4. UI phases require Playwright screenshots and visual review at phone, tablet, and desktop sizes; scoring also requires a real-device pass before Gate C.
5. The phase cannot pass on a narrow test if its acceptance criterion is broader. Missing or indirect evidence is a failure.
6. Findings are fixed, the relevant checks rerun, and the same or another independent reviewer issues the final verdict.
7. A phase advances only with `PASS`; `PASS WITH FOLLOW-UP` is not a release-gate verdict.

Minimum automated gate where applicable:

```text
format
lint
typecheck
unit tests
integration tests
solver tests
build
database migration check
end-to-end tests
accessibility checks
visual regression
dependency and secret scans
```

## 8. External evidence and decisions

Engineering can begin before every commercial value is known because prices and limits are configuration. Production release cannot be claimed without:

- Local and national design partners and representative artefacts.
- Confirmed Canoe Polo placement behaviour.
- Public/minor visibility, consent, deletion, and retention policy approval.
- Event Pass and Organiser Pro prices, selling currency, and legal entity.
- Brand/product name, domain, support address, and target legal jurisdictions.
- Expected peak competitions, scoring devices, spectators, support hours, and browser/device floor.
- Availability tier and a truthful disaster RPO; “no committed-write loss” and a 15-minute disaster RPO cannot both be unqualified promises.
- MFA and audited break-glass policy for platform administrators and high-risk organiser actions.
- Managed-provider accounts and production credentials.
- Independent legal review and penetration test.
- Local and national pilot evidence.

Until those items exist, the product may progress through engineering phases but cannot pass the dependent release gate.
