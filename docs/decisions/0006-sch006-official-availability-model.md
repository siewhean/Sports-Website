# ADR 0006 — SCH-006 Official Availability Constraints: Domain & Persistence Design

**Status:** Accepted  
**Date:** 28 September 2026 (Updated with Checkpoint 1A hardening)  
**Applies to:** Post-Gate-F SCH-006 Official Availability Constraints

## Context

Matchday's Phase 4 scheduling constraint engine (`packages/domain/src/schedule-constraints.ts`) already implements complete validation and pruning for:

- `official_overlap`: Prevents an official from being assigned to overlapping match times (intrinsic hard constraint).
- `official_unavailable`: Verifies assigned officials are available during their match times according to configured constraint mode (`required`, `preferred`, `ignored`), with solver pruning and soft penalty evaluation.

Furthermore, `apps/scheduler/src/domain-optimizer.ts` accepts `official_ids` on matches and `official_availability` constraints.

However, the persistent data layer lacked:

1. An authoritative entity for competition officials.
2. Authoritative persistence for official availability windows.
3. Authoritative match-official assignments.
4. Wiring of these entities into schedule generation problem inputs and manual move validation.

## Architectural Decision

### 1. Authoritative Domain & Persistence Entities

We introduce a competition-scoped official model with three tables:

#### a. `competition_officials`

Authoritative roster of officials available for a specific competition.

- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `competition_id uuid NOT NULL`
- `organisation_id uuid NOT NULL`
- `name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80)`
- `default_role text NULL CHECK (default_role IS NULL OR length(trim(default_role)) BETWEEN 1 AND 40)`
- `archived_at timestamptz NULL`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()`
- `UNIQUE (id, competition_id, organisation_id)`
- `FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE`

**Role Taxonomy**: SCH-006 does **not** hardcode a global role enum (e.g. referee vs table official) at the schema level. Matchday supports multi-sport tournaments, and scheduling logic for SCH-006 is role-agnostic: the solver ensures an official is not double-booked and is within their availability window. `default_role` is an optional display label.

**Archival Lifecycle**: Officials are **never hard-deleted** when removed by an organiser. Setting `archived_at = now()` preserves referential integrity for match assignments, past schedules, and audit records. Archived officials are excluded from new-assignment pickers by default but remain fully resolvable for historical schedules.

**Privacy Boundary**: Strictly minimal display attributes (`name`, optional `default_role`). No telephone numbers, residential addresses, national identity documents, or unnecessary PII are stored.

#### b. `official_availability_windows`

Discrete availability intervals for an official.

- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `competition_id uuid NOT NULL`
- `organisation_id uuid NOT NULL`
- `official_id uuid NOT NULL`
- `starts_at timestamptz NOT NULL`
- `ends_at timestamptz NOT NULL CHECK (ends_at > starts_at)`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()`
- `UNIQUE (official_id, starts_at, ends_at)`
- `FOREIGN KEY (official_id, competition_id, organisation_id) REFERENCES competition_officials(id, competition_id, organisation_id) ON DELETE CASCADE`
- `FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE`

**Timezone & Canonicalisation**: Stored in UTC (`timestamptz`). UI displays and edits windows in the competition's local timezone. Overlapping and exactly adjacent intervals are deterministically merged when constructing solver intervals.

#### c. `match_official_assignments`

Authoritative assignment linking a match to an official.

- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `competition_id uuid NOT NULL`
- `organisation_id uuid NOT NULL`
- `match_id uuid NOT NULL`
- `official_id uuid NOT NULL`
- `assigned_role text NULL CHECK (assigned_role IS NULL OR length(trim(assigned_role)) BETWEEN 1 AND 40)`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()`
- `UNIQUE (match_id, official_id)`
- `FOREIGN KEY (match_id, competition_id) REFERENCES matches(id, competition_id) ON DELETE CASCADE`
- `FOREIGN KEY (official_id, competition_id, organisation_id) REFERENCES competition_officials(id, competition_id, organisation_id) ON DELETE CASCADE`
- `FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE`

**Cross-Competition Isolation**: Multi-column composite foreign keys guarantee that an official from Competition A cannot be assigned to a match in Competition B, even within the same organisation.

---

### 2. Revision & Invalidation Semantics

The core principle is:

> **New input invalidates/requires revalidation of future draft work; published history is never silently mutated.**

#### Distinction: Scheduling Mutations vs. Metadata Mutations

To prevent spurious `STALE_SCHEDULE_INPUT` failures during schedule generation or move validation, mutations are categorized:

1. **Scheduling-Affecting Mutations** (Increment `competitions.revision` in the **same transaction**):
   - Assigning an official to a match (`POST` / `PUT` assignments);
   - Unassigning an official from a match (`DELETE` / `PUT` assignments);
   - Creating, modifying, or deleting availability windows for an official who has at least one match assignment;
   - Archiving an official who is currently assigned to a match;
   - Restoring an archived official who has existing match assignments.

2. **Metadata-Only Mutations** (Do **not** increment `competitions.revision`):
   - Renaming an official (`name`);
   - Updating an official's `default_role` or a match assignment's `assigned_role`;
   - Creating a new official who has no match assignments yet;
   - Updating availability windows for an unassigned official;
   - Archiving an unassigned official.

#### State Interactions

1. **When no schedule exists:** Mutations update setup state cleanly.
2. **When a draft schedule exists:** Any scheduling-affecting mutation increments `competitions.revision`. As a result, `assertScheduleJobCurrent` detects `(j.input_snapshot->>'source_revision')::integer <> c.revision`, throwing `STALE_SCHEDULE_INPUT` and informing the organiser to regenerate or revalidate.
3. **When a job is running:** If scheduling inputs change while a solver job runs, the job cannot be accepted because `acceptScheduleOption` calls `assertScheduleJobCurrent`, rejecting stale solutions.
4. **When a draft revision exists:** Manual match moves call `validateScheduleMoveOn`, which re-evaluates the proposed move against the snapshot problem using `validateSchedule(problem, moved)`.
5. **When a schedule is published:** Published schedule revisions, their snapshot hashes, and `scheduled_matches` are strictly immutable. Altering official availability or assignments afterwards never mutates historical published match times. Any post-publication scheduling adjustments must proceed via existing formal schedule repair / republication workflows.

---

### 3. Schedule Input Construction Invariants

#### a. Availability Scoped Strictly to Assigned Officials

The domain validator (`packages/domain/src/schedule-constraints.ts`) asserts that any official present in `constraints.official_availability.value.by_official_id` is an assigned official on at least one match in the problem.

Therefore, `buildScheduleProblem` must:

1. Query all `match_official_assignments` for the competition matches.
2. Derive `assignedOfficialIds = new Set(matches.flatMap(m => m.official_ids))`.
3. Query `official_availability_windows` **only** for officials in `assignedOfficialIds`.
4. Construct `constraints.official_availability.value.by_official_id` **only** for those assigned officials.
5. Sort official IDs deterministically to ensure deterministic schedule input hashing.

Unassigned officials are completely omitted from the solver constraint payload.

#### b. Deterministic Interval Canonicalisation

When transforming persisted availability windows into `ScheduleInterval[]` (`start_epoch_ms`, `end_epoch_ms`):

1. Windows are sorted by `starts_at ASC`, `ends_at ASC`.
2. Overlapping intervals (`windowB.starts_at <= current.ends_at`) are merged into a single interval spanning `[current.starts_at, max(current.ends_at, windowB.ends_at)]`.
3. Exactly adjacent intervals (`windowB.starts_at == current.ends_at`) are also merged, representing continuous availability.
4. The merged intervals are converted to epoch milliseconds in strictly increasing order.

This guarantees that identical real availability always yields an identical canonical hash.

---

### 4. Data Flow

```text
Organiser UI (roster, availability windows, match assignments)
       │
       ▼
API Routes & Phase4Runtime (CRUD + validation + audit events)
       │
       ▼
PostgreSQL Persistence (competition_officials, official_availability_windows, match_official_assignments)
       │
       ▼
buildScheduleProblem:
   1. matches[].officialIds <= match_official_assignments
   2. assignedOfficialIds = union(matches[].officialIds)
   3. by_official_id <= canonicalise(availability for assignedOfficialIds only)
       │
       ▼
Existing Domain Constraint Engine (validateSchedule, pruneImpossibleCandidate, evaluateScheduleQuality)
       │
       ▼
Scheduler Worker Output / Move Validation Result (feasible schedule or structured official violations)
```

---

### 5. Tenant Isolation & Security

- All queries and mutations verify organiser permissions through `competitionAccess(tx, competitionId, actor, true)`.
- Multi-column foreign keys `(competition_id, organisation_id) REFERENCES competitions(id, organisation_id)` guarantee database-level tenant isolation.
- Mutations produce structured audit and outbox events (`official.created`, `official.updated`, `official.archived`, `official.restored`, `official.availability.updated`, `official.assignments.updated`).
