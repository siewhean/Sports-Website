# ADR 0006 — SCH-006 Official Availability Constraints: Domain & Persistence Design

**Status:** Accepted  
**Date:** 28 September 2026  
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
- `role text CHECK (role IS NULL OR role IN ('referee', 'assistant_referee', 'table_official', 'umpire'))`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()`
- `UNIQUE (id, competition_id)`
- `FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE`

Privacy boundary: Strictly minimal display attributes (`name`, optional `role`). No phone numbers, residential addresses, national identity documents, or other unnecessary PII are stored.

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
- `FOREIGN KEY (official_id, competition_id) REFERENCES competition_officials(id, competition_id) ON DELETE CASCADE`
- `FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE`

Timezone normalization: Stored in UTC (`timestamptz`). UI converts to and from competition local timezone. Overlapping windows for the same official are merged when building `ScheduleInterval`s (`start_epoch_ms`, `end_epoch_ms`).

#### c. `match_official_assignments`
Authoritative assignment linking a match to an official.
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `competition_id uuid NOT NULL`
- `organisation_id uuid NOT NULL`
- `match_id uuid NOT NULL`
- `official_id uuid NOT NULL`
- `assigned_role text CHECK (assigned_role IS NULL OR assigned_role IN ('referee', 'assistant_referee', 'table_official', 'umpire'))`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `UNIQUE (match_id, official_id)`
- `FOREIGN KEY (match_id, competition_id) REFERENCES matches(id, competition_id) ON DELETE CASCADE`
- `FOREIGN KEY (official_id, competition_id) REFERENCES competition_officials(id, competition_id) ON DELETE CASCADE`
- `FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE`

### 2. Revision & Invalidation Semantics

The core principle is:
> **New input invalidates/requires revalidation of future draft work; published history is never silently mutated.**

1. **When no schedule exists:** Mutations safely update setup state for future generation.
2. **When a draft schedule exists:** Any creation, modification, or deletion of official availability or assignments increments `competitions.revision`. This causes `assertScheduleJobCurrent` to detect `(j.input_snapshot->>'source_revision')::integer <> c.revision`, throwing `STALE_SCHEDULE_INPUT` and prompting the organiser to regenerate or revalidate.
3. **When a job is running:** If inputs change while a solver job runs, the job cannot be accepted because `acceptScheduleOption` verifies `assertScheduleJobCurrent`, safely rejecting stale solutions.
4. **When a draft revision exists:** Manual match moves call `validateScheduleMoveOn`, which re-evaluates the moved assignments against the problem snapshot using the domain engine `validateSchedule(problem, moved)`.
5. **When a schedule is published:** Published schedule revisions, their snapshot hashes, and `scheduled_matches` are strictly immutable. Altering official availability afterwards does not alter published match times. Any post-publication scheduling adjustments must proceed via existing formal schedule repair / republication workflows.

### 3. Data Flow

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
buildScheduleProblem (maps match_official_assignments -> matches[].official_ids,
                      maps official_availability_windows -> constraints.official_availability.value.by_official_id)
       │
       ▼
Existing Domain Constraint Engine (validateSchedule, pruneImpossibleCandidate, evaluateScheduleQuality)
       │
       ▼
Scheduler Worker Output / Move Validation Result (feasible schedule or structured official violations)
```

### 4. Tenant Isolation & Security

- All queries and mutations verify organiser permissions through `competitionAccess(tx, competitionId, actor, true)`.
- Multi-column foreign keys `(competition_id, organisation_id) REFERENCES competitions(id, organisation_id)` guarantee database-level tenant isolation.
- Mutations produce structured audit and outbox events (`official.created`, `official.updated`, `official.deleted`, `official.availability.updated`, `official.match_assigned`, `official.match_unassigned`).
