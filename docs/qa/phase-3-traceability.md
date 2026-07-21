# Phase 3 — Gate A traceability

**Date:** 20 July 2026  
**Status:** Verified locally — Gate A PASS

This file tracks the exact Phase 3 scope in `docs/EXECUTION_ROADMAP.md`. A row becomes verified only when its implementation and automated evidence both exist. The Phase 4 manual and drag-and-drop builders and `FMT-004` double elimination are explicitly out of scope.

## Competition, divisions, and entries

| Tasks       | Required evidence                                                                         | Status   |
| ----------- | ----------------------------------------------------------------------------------------- | -------- |
| CMP-001–005 | CRUD, lifecycle, location/date/timezone, one-sport rule, first-match sport lock           | Verified |
| CMP-006–009 | Division and common team/individual/placeholder entry lifecycle                           | Verified |
| CMP-010–012 | Paste and mapped CSV imports with atomic rollback                                         | Verified |
| CMP-013–015 | Seeds, availability, withdrawal, and replacement lineage                                  | Verified |
| CMP-016     | Transactional 16-entry free limit across all active divisions and non-destructive upgrade | Verified |
| CMP-017–018 | Duplicate, archive, and restore                                                           | Verified |

## Sport packs

| Tasks       | Required evidence                                                                      | Status   |
| ----------- | -------------------------------------------------------------------------------------- | -------- |
| SPT-001–004 | Versioned schema plus competition and division overrides                               | Verified |
| SPT-005–008 | Reusable settings editor, state labels/reset, user default, copy previous              | Verified |
| SPT-009–014 | Canoe Polo, Badminton, Table Tennis, Volleyball, Basketball packs and validation suite | Verified |
| SPT-015     | Permissioned internal sport-default administration                                     | Verified |

## Capacity and format

| Tasks                | Required evidence                                                                                                                                    | Status   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| CAP-001–009          | Areas, daily windows, unavailable periods, slot length, Canoe Polo 30-minute default, interval capacity, summary states, reserves, boundary fixtures | Verified |
| FMT-001–003, 005–010 | Stage graph, supported stages, advancement, validation, deterministic matches, immutable revisions                                                   | Verified |
| FMT-011–016          | Match/guaranteed-match calculations and 8/12/16/24/48 templates                                                                                      | Verified |
| FMT-024–026          | Capacity-first recommendations, brief advantages, and feasibility tests                                                                              | Verified |

## Results and advancement

| Tasks       | Required evidence                                                                      | Status   |
| ----------- | -------------------------------------------------------------------------------------- | -------- |
| RES-001–006 | Configurable standings and all five sport criteria                                     | Verified |
| RES-007–010 | Forfeit/withdrawal, cross-group comparison, versioned snapshots, automatic advancement | Verified |

## Gate A closure

- [x] Every sport passes pack and standings invariants.
- [x] 8/12/16/24/48 templates pass structural, match-count, guaranteed-match, and deterministic-ID checks.
- [x] Capacity stays deterministic across dates, time zones, daylight-saving boundaries, breaks, reserves, and multiple areas.
- [x] Invalid graphs cannot persist or publish through either API or direct database writes.
- [x] Permissions, audit/outbox atomicity, loading/empty/error states, mobile layout, accessibility, monitoring hooks, and operator documentation satisfy the shared Definition of Done.
- [x] Repository checks, migrated-database integration, local production-build browser tests, and strict terminal/browser-console review pass.
- [x] Independent QA/QC records exact `Verdict: PASS` in `docs/qa/phase-3-verdict.md`.

The evidence summary and external boundary are recorded in `docs/qa/phase-3-acceptance.md` and `docs/qa/phase-3-verdict.md`.
