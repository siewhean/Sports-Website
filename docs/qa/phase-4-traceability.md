# Phase 4 — Gate B traceability

**Date:** 21 July 2026  
**Status:** In progress

This file tracks the exact Phase 4 scope in `docs/EXECUTION_ROADMAP.md`. A row becomes verified only when production implementation and objective automated/runtime evidence both exist. Prototype-only or mocked browser state cannot close a row.

## Current implementation slice

The `agent/phase4-organiser-alpha` branch contains the first Gate B remediation slice. It deliberately does not close any row below until the repository suites and production-like browser journey pass.

Implemented source evidence:

- The authenticated organiser workspace accepts and labels all five launch sports instead of rejecting every sport except Canoe Polo.
- The manual and visual format surfaces now expose every stage kind already supported by the canonical graph contract, including consolation and classification.
- The format workspace carries the competition sport into server-rendered state and filters saved organiser templates to that sport.
- Template-save commands derive the sport from authenticated competition setup rather than trusting the browser-provided value, and reject organisation mismatches.
- PostgreSQL now rejects template application across organisations, across sports, from archived templates, or with inconsistent source metadata.
- Unit and integration regression suites were added for the five-sport workspace, stage-library parity, shared graph identity, template version replacement, same-origin competition context, and database template application.

Evidence still required before status changes:

- Frozen install, format, lint, typecheck, unit, migrated PostgreSQL integration, build, and browser E2E results from an executable runner.
- A true non-navigating setup-draft patch transition for debounced autosave. The existing `save_step` transition advances the wizard and must not be reused as an autosave shortcut.
- Complete manual/visual builder persistence, Assisted Setup resume, scheduler, publication, accessibility, and visual evidence listed below.

## Format builder

| Tasks       | Required evidence                                                                                                                               | Status      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| FMT-017–020 | Production manual and visual builders edit one persisted canonical graph; stable IDs, positions, advancement and hashes round-trip without loss | In progress |
| FMT-021–022 | Canonical validation panel and preview block invalid selection/publication and derive facts from the exact working graph                        | In progress |
| FMT-023     | Organisation-scoped, versioned organiser templates can be named, reused and archived without mutating prior competitions                        | In progress |

## Assisted Setup

| Tasks       | Required evidence                                                                                                   | Status      |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ----------- |
| AST-001–006 | Eight production steps persist validated basics, lossless capacity, pinned settings, entries and format preferences | In progress |
| AST-007–008 | At most three meaningfully different recommendations lead to a truthful schedule review and explicit publication    | In progress |
| AST-009–010 | Server-owned optimistic autosave/resume and the complete phone/tablet/desktop wizard pass                           | In progress |

## AI boundary

| Tasks      | Required evidence                                                                                                                     | Status      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| AI-001–006 | Strict structured brief, provider abstraction, text conversion, missing-information UI and deterministic setup/recommendation mapping | In progress |
| AI-010–012 | Schema/business validation and concurrency-safe action accounting charge only valid successful uncached actions                       | In progress |
| AI-013–015 | Bounded retry/manual fallback, privacy-safe audit evidence and canonical evaluation fixtures pass                                     | In progress |

## Scheduling

| Tasks            | Required evidence                                                                                                      | Status      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| SCH-001–005, 007 | Versioned constraints enforce hard rules, rest, maximum matches/day and preferred final time across time zones         | In progress |
| SCH-008–011      | Fastest, Balanced and Rest-focused alternatives expose deterministic, measurable quality components                    | In progress |
| SCH-012–016      | Durable jobs checkpoint current best, continue/cancel safely, preserve locks and compare equivalent-input alternatives | In progress |
| SCH-017–020      | Desktop/tablet timeline, semantic alternatives, phone move flow and immutable revision comparison pass                 | In progress |
| SCH-021–023      | Organiser-only explicit publication, 30-day draft expiry and idempotent 7-day/1-day warnings pass                      | In progress |
| SCH-027–028      | 8/12/16/24/48 and competition-wide multi-division shared-area fixtures pass deterministically                          | In progress |

## Gate B closure

- [ ] Complete organiser journey passes against production web, API, PostgreSQL, Redis, scheduler worker, and provider stub on phone, tablet, and desktop.
- [ ] Manual and visual format builders yield the same stored graph and materialised matches.
- [ ] Assisted Setup autosaves and resumes across sessions without relying on browser-local source of truth; manual fallback remains complete when AI fails or quota is unavailable.
- [ ] The 16-entry cross-division free-plan limit and non-destructive upgrade path remain enforced.
- [ ] All solver hard constraints, objectives, quality components, alternatives, checkpoint/restart, cancellation, and current-best retention pass.
- [ ] Locks, edits, comparisons, revision isolation, expiry, warnings, and explicit publication preserve public/draft boundaries.
- [ ] AI validation, privacy, cache identity, retries, accounting, failure non-charging, and canonical evaluation pass.
- [ ] Permissions, CSRF, idempotency, audit/outbox atomicity, loading/empty/error states, accessibility, monitoring, and operator documentation satisfy the shared Definition of Done.
- [ ] Repository checks, migrated-database integration, local production-build browser tests with retries disabled, strict terminal/browser-console review, and concept-to-render visual inspection pass.
- [ ] Independent QA/QC records exact `Verdict: PASS` in `docs/qa/phase-4-verdict.md`.

## External boundary

Gate B is an internal local organiser-alpha gate. It does not resolve the external Phase 1 hosted CI, live identity-provider, CDN/purge, telemetry, managed-backup, or real authenticated production-device evidence gaps.
