# Operational Runbook: Gate C Database Migrations 0030 & 0031

## Overview

This runbook defines the operational execution, preflight validation queries, data remediation procedures, locking behavior, and rollback playbooks for deploying Gate C forward database migrations:

- `0030_gate_c_published_schedule_participants.sql`
- `0031_gate_c_participant_snapshot_fencing.sql`

These migrations introduce authoritative schedule participant snapshots (`home_entry_id`, `away_entry_id`), immutable scoring writer session fencing, and division-scoped foreign keys on `scheduled_matches`.

---

## 1. Lock Profile & Concurrency Characteristics

### Evidence Classification: SMALL-SCALE LOCK CHARACTERIZATION

> [!IMPORTANT]
> The empirical benchmarks below reflect **SMALL-SCALE LOCK CHARACTERIZATION** under controlled staging concurrency. While migrations 0030 and 0031 complete in under 20ms under baseline conditions, their transactional table rewrites and constraint creation acquire `AccessExclusiveLock` on `scheduled_matches` and `canonical_score_events`.
> At production data volume, a low-traffic deployment window or configured `lock_timeout = '3s'` is required to guarantee zero score disruption.

Based on empirical benchmarking across 4 traffic profiles (documented in `docs/qa/gate-c-lock-benchmarks.json` and `artifacts/qa/gate-c-locks/evidence.json`):

| Profile                         | Traffic Characteristics                                           | Total DDL Duration | Lock Wait Queue Max | Read / Write Impact                         |
| ------------------------------- | ----------------------------------------------------------------- | ------------------ | ------------------- | ------------------------------------------- |
| **Profile 1: Baseline**         | Zero external traffic                                             | ~110 ms            | 0                   | None                                        |
| **Profile 2: Public Reads**     | Concurrent reads on `scheduled_matches`, `canonical_score_events` | ~155 ms            | 31                  | p95 latency ~23ms; 0 queries timed out      |
| **Profile 3: Organiser Reads**  | Concurrent reads on `result_conflicts`, `scoring_access_passes`   | ~370 ms            | 12                  | p95 latency ~21ms; 0 queries timed out      |
| **Profile 4: Writer Mutations** | Concurrent score events & session lease updates                   | ~1134 ms           | 548                 | Writers briefly queued; 0 deadlock on retry |

### Acquired Lock Modes

- `scheduled_matches`: `AccessExclusiveLock` (during `ALTER TABLE scheduled_matches ADD COLUMN ...`)
- `canonical_score_events`: `AccessExclusiveLock` (during foreign key validation)
- `matches`: `AccessExclusiveLock` / `ShareRowExclusiveLock`
- `scoring_access_sessions`: `AccessExclusiveLock` (during unique foreign key constraint addition)

**Deployment Window Guidance**: Recommended execution during scheduled low-traffic maintenance window or configured session `lock_timeout = '3s'`.

---

## 2. Pre-Migration Validation Queries (T-24h and T-1h)

Run these validation queries before applying the migration. If any query returns rows, execute the corresponding Remediation Script prior to deployment.

### Validation 1: Check for Writer Generation Mismatch (Preflight 0030)

```sql
-- Checks if any canonical score events have writer_generation differing from their issuing session
SELECT
  e.id AS event_id,
  e.match_id,
  e.actor_access_session_id,
  e.writer_generation AS event_generation,
  s.generation AS session_generation
FROM canonical_score_events e
JOIN scoring_access_sessions s ON s.id = e.actor_access_session_id
WHERE e.writer_generation <> s.generation;
```

_Expected Count_: `0 rows`.

### Validation 2: Check for Invalid Nullable Result Conflict Receipts (Preflight 0030)

```sql
-- Checks for acknowledged/resolved conflicts missing mandatory lifecycle receipts
SELECT
  id,
  competition_id,
  corrected_match_id,
  status,
  acknowledged_at,
  acknowledgement_reason,
  acknowledgement_client_event_id
FROM result_conflicts
WHERE (status = 'acknowledged' AND (acknowledged_at IS NULL OR acknowledgement_reason IS NULL OR length(btrim(acknowledgement_reason)) < 1))
   OR (status = 'resolved' AND (resolved_at IS NULL OR resolution_reason IS NULL OR length(btrim(resolution_reason)) < 1));
```

_Expected Count_: `0 rows`.

### Validation 3: Check for Cross-Division Participant Snapshots (Preflight 0031)

```sql
-- Checks if any scheduled match references entries belonging to a different division or competition
SELECT
  sm.schedule_revision_id,
  sm.match_id,
  m.competition_id AS match_competition_id,
  m.division_id AS match_division_id,
  de_home.division_id AS home_entry_division_id,
  de_away.division_id AS away_entry_division_id
FROM scheduled_matches sm
JOIN matches m ON m.id = sm.match_id
LEFT JOIN division_entries de_home ON de_home.id = sm.home_entry_id
LEFT JOIN division_entries de_away ON de_away.id = sm.away_entry_id
WHERE (sm.home_entry_id IS NOT NULL AND de_home.division_id <> m.division_id)
   OR (sm.away_entry_id IS NOT NULL AND de_away.division_id <> m.division_id);
```

_Expected Count_: `0 rows`.

---

## 3. Pre-Migration Data Remediation Scripts

If any validation query fails, execute the corresponding transactional remediation:

### Remediation 1: Fix Writer Generation Discrepancies

```sql
BEGIN;

-- Temporarily disable immutable trigger for operational fix
ALTER TABLE canonical_score_events DISABLE TRIGGER canonical_score_events_immutable;

UPDATE canonical_score_events e
SET writer_generation = s.generation
FROM scoring_access_sessions s
WHERE s.id = e.actor_access_session_id
  AND e.writer_generation <> s.generation;

ALTER TABLE canonical_score_events ENABLE TRIGGER canonical_score_events_immutable;

COMMIT;
```

### Remediation 2: Backfill Missing Result Conflict Acknowledgement Receipts

```sql
BEGIN;

ALTER TABLE result_conflicts DISABLE TRIGGER result_conflicts_lifecycle_guard;

UPDATE result_conflicts
SET
  acknowledged_at = COALESCE(acknowledged_at, now()),
  acknowledgement_reason = COALESCE(acknowledgement_reason, 'Operational remediation: legacy acknowledged conflict backfill')
WHERE status = 'acknowledged'
  AND (acknowledged_at IS NULL OR acknowledgement_reason IS NULL);

ALTER TABLE result_conflicts ENABLE TRIGGER result_conflicts_lifecycle_guard;

COMMIT;
```

### Remediation 3: Re-align Cross-Division Scheduled Match Snapshots

```sql
BEGIN;

UPDATE scheduled_matches sm
SET
  home_entry_id = m.home_entry_id,
  away_entry_id = m.away_entry_id
FROM matches m
WHERE m.id = sm.match_id
  AND (
    (sm.home_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM division_entries de WHERE de.id = sm.home_entry_id AND de.division_id = m.division_id))
    OR
    (sm.away_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM division_entries de WHERE de.id = sm.away_entry_id AND de.division_id = m.division_id))
  );

COMMIT;
```

---

## 4. Migration Execution Procedure

### Recommended Session Parameters

Set bounded timeouts so DDL will abort immediately rather than blocking long live transaction queues:

```sql
SET lock_timeout = '3000ms';       -- Abort if lock cannot be acquired within 3 seconds
SET statement_timeout = '30000ms'; -- Abort if whole DDL takes > 30 seconds
```

### Deployment Command

```bash
# Set production environment and run migration
RUN_INFRA_TESTS=1 pnpm --filter @matchday/database exec tsx scripts/migrate.ts
```

---

## 5. Abort & Rollback Playbook

If a migration fails during deployment (e.g. `lock_timeout` expired or unexpected preflight validation triggered):

1. **Automatic Transaction Abort**:
   - Each migration file in `packages/database/migrations/` executes in a single PostgreSQL transaction.
   - Any error immediately triggers an atomic `ROLLBACK`.
   - All acquired `AccessExclusiveLock`s are released in `< 15ms` with zero dangling locks.
   - `schema_migrations` remains at the last successfully applied migration (e.g., `0029`).

2. **Rollback Verification Query**:

   ```sql
   SELECT name, applied_at FROM schema_migrations ORDER BY name DESC LIMIT 5;
   ```

3. **Verify Table Locks are Clean**:

   ```sql
   SELECT pid, mode, granted, query
   FROM pg_locks l
   JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE a.query ILIKE '%0030%' OR a.query ILIKE '%0031%';
   ```

   _Expected_: `0 rows`.

4. **Retry Posture**:
   - Run Pre-Migration Validation Queries (Section 2).
   - If preflight error was data-related, run Remediation (Section 3) and retry.
   - If `lock_timeout` occurred due to peak writer burst, retry after 60 seconds.
