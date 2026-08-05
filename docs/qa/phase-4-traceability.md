# Phase 4 — Gate B traceability

**Date:** 27 July 2026

**Branch:** `fix/gate-b-local-remediation-20260724-132224`
**Validated source commit:** `4f9202e4e1c546bfef2a23bcfc7e26825c90b314`
**Current Gate B status:** Local PASS with schema-v2 exact-SHA evidence and a
fresh independent verdict.

The verified rows below are supported by the current exact-SHA command ledger,
two isolated real organiser journeys and independent review. Exact commands,
counts, browser limitations, dependency findings and release status are
maintained in `docs/qa/phase-4-acceptance.md`,
`docs/qa/phase-4-local-run.md`, and `docs/qa/phase-4-verdict.md`; concept comparison is in
`docs/qa/phase-4-fidelity-ledger.md`.

## Format builder

| Tasks       | Required evidence                                                                                                                       | Status   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FMT-017–020 | Manual and visual projections edit one persisted canonical graph; stable IDs, positions, advancement and hashes round-trip without loss | Verified |
| FMT-021–022 | Canonical validation and preview derive from the exact graph and block invalid selection, materialisation and publication               | Verified |
| FMT-023     | Organisation-scoped, sport-bound and versioned organiser templates can be reused and archived without mutating prior competitions       | Verified |

## Assisted Setup

| Tasks       | Required evidence                                                                                        | Status   |
| ----------- | -------------------------------------------------------------------------------------------------------- | -------- |
| AST-001–006 | Eight production steps persist basics, capacity, pinned dynamic settings, entries and format preferences | Verified |
| AST-007–008 | At most three capacity-filtered recommendations lead to schedule review and explicit publication         | Verified |
| AST-009–010 | Server-owned optimistic autosave/resume and phone/tablet/desktop wizard behavior pass                    | Verified |

## AI boundary

| Tasks      | Required evidence                                                                                                                              | Status   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| AI-001–006 | Strict structured brief, provider abstraction, text preservation, missing-information UI and deterministic setup mapping                       | Verified |
| AI-010–012 | Schema/business validation and concurrency-safe accounting charge only valid successful uncached actions                                       | Verified |
| AI-013–015 | Bounded retry/manual fallback, provider failure and quota failure classification, privacy-safe audit, cache replay and canonical fixtures pass | Verified |

## Scheduling

| Tasks            | Required evidence                                                                                                                   | Status   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| SCH-001–005, 007 | Versioned constraints enforce hard rules, rest, maximum matches/day and preferred final time across time zones                      | Verified |
| SCH-008–011      | Fastest, Balanced and Rest-focused alternatives expose deterministic named quality components                                       | Verified |
| SCH-012–016      | Redis-backed jobs checkpoint current best, reject duplicate active work, continue/cancel safely and preserve locks/revision lineage | Verified |
| SCH-017–020      | Desktop/tablet timeline, semantic alternatives, phone move flow and immutable revision comparison pass                              | Verified |
| SCH-021–023      | Organiser-only publication, one-calendar-month draft expiry and idempotent 7-day/1-day warnings pass                                | Verified |
| SCH-027–028      | 8/12/16/24/48 and competition-wide multi-division shared-area fixtures pass deterministically                                       | Verified |

## Gate B closure

- [x] One competition and setup-draft lineage runs through create/resume, Canoe Polo to Basketball sport change, canonical capacity/settings refresh, 16 entries across two divisions, preferences, capacity-filtered recommendation, exact format IDs, PostgreSQL materialisation/publication, Redis queue, scheduler worker, alternatives, current best, accept, lock, move, compare, organiser-only publication, setup completion, public schedule versions 1/2, and stale-input fencing.
- [x] Manual and visual browser projections send the same canonical graph and reload the saved layout lineage. The generic responsive matrix is complemented by a separately isolated 3/3 real browser→BFF→API→PostgreSQL/Redis journey.
- [x] Assisted Setup autosaves and resumes without browser-local source of truth; manual fallback preserves organiser text for provider failure and quota exhaustion.
- [x] The 16-entry cross-division free-plan limit, concurrent writes and non-destructive upgrade path remain enforced by Phase 3/Gate B database evidence.
- [x] Solver hard constraints, objectives, quality components, alternatives, current-best retention, cancellation and revision isolation pass.
- [x] Locks, edits, comparisons, immutable provenance, one-calendar-month expiry, warnings and explicit publication preserve public/draft boundaries.
- [x] AI validation, privacy, cache identity, bounded retry, accounting, failure non-charging and quota-race behavior pass.
- [x] Permissions, idempotency, audit/outbox atomicity, loading/empty/error states, accessibility and operator backup evidence satisfy the local gate.
- [x] Repository checks, migrated PostgreSQL integration, Redis worker integration, production build, retries-disabled browser matrix, console/network guards and four-concept visual inspection pass locally.
- [x] Independent QA/QC inspected the complete main diff and recorded its fresh severity counts, accepted residual risks and exact release-gate verdict in `docs/qa/phase-4-verdict.md`.

## External boundary

Gate B is an internal local organiser-alpha gate. Hosted GitHub Actions: Not executed because the account Actions allowance is unavailable. This work also does not resolve the separate Phase 1 live identity-provider, CDN/purge, hosted telemetry, managed-backup, real payment/billing-provider, or authenticated production-device evidence gaps. Moving the pull request out of draft after this verdict does not convert local validation into a hosted result.
