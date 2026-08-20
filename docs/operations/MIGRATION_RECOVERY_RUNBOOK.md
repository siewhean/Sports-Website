# Gate C Migration Recovery Runbook

## Overview and Principles

This runbook documents operational diagnosis, triage, data repair, and recovery procedures for Gate C database migrations:

- `0030_gate_c_published_schedule_participants.sql`
- `0031_gate_c_participant_snapshot_fencing.sql`
- `0038_gate_c_repair_schedule_participant_snapshots.sql`

### Zero Data-Loss Invariant

Under no circumstances should historical audit records, canonical score events, match streams, or schedule revisions be deleted or truncated during migration recovery. All remediation procedures must:

1. Preserve immutable event and audit bytes.
2. Reconcile missing relationships or metadata using existing audit/provenance receipts.
3. Verify integrity through read-only diagnosis queries before and after applying changes.
4. Execute inside an explicit transaction (`BEGIN; ... COMMIT;`).

---

## Migration 0030: Published Schedule Participants & Scoring Runtime Integrity

### Purpose

Migration 0030 introduces:

- Participant snapshots (`home_entry_id`, `away_entry_id`) on `scheduled_matches`.
- Reversal and reopen provenance constraints on `canonical_score_events`.
- Writer generation foreign key and trigger fencing between `canonical_score_events` and `scoring_access_sessions`.
- Strict lifecycle receipt check constraint on `result_conflicts`.
- Match-division foreign keys on `match_score_streams` and `result_conflicts`.

### Failure Symptoms and Diagnosis

#### Symptom 1: Canonical Score Event Reversal/Reopen Provenance Abort

- **Error message**:
  `canonical score events require retained reversal/reopen provenance; invalid event ids: <ids>` or
  `canonical score events contain duplicate reversal targets: <ids>`
- **Diagnosis SQL**:
  ```sql
  -- Identify invalid reversal or reopen score events
  SELECT id, competition_id, match_id, sequence, event_type, reversal_target_event_id, reason
  FROM canonical_score_events
  WHERE (event_type = 'reversal' AND (reversal_target_event_id IS NULL OR reason IS NULL OR length(btrim(reason)) < 3))
     OR (event_type = 'match_reopened' AND (reason IS NULL OR length(btrim(reason)) < 3));

  -- Identify duplicate reversal targets
  SELECT reversal_target_event_id, count(*) AS reversal_count, array_agg(id) AS reversal_event_ids
  FROM canonical_score_events
  WHERE event_type = 'reversal' AND reversal_target_event_id IS NOT NULL
  GROUP BY reversal_target_event_id
  HAVING count(*) > 1;
  ```
- **Remediation Procedure**:
  1. Inspect the scorekeeper audit log or operator session logs for the affected matches to recover the reason and target event IDs.
  2. In an explicit transaction, populate the valid reason or target reference:
     ```sql
     BEGIN;
     UPDATE canonical_score_events
     SET reason = 'Operator corrected score entry'
     WHERE id IN ('<invalid_event_id>') AND (reason IS NULL OR length(btrim(reason)) < 3);
     COMMIT;
     ```
  3. Re-run migration check: `pnpm db:migrate:check`.

#### Symptom 2: Writer Generation Mismatch Abort

- **Error message**:
  `canonical score events contain writer generations that do not match their scoring sessions: <ids>`
- **Diagnosis SQL**:
  ```sql
  SELECT event.id AS event_id,
         event.match_id,
         event.actor_access_session_id,
         event.writer_generation AS event_writer_generation,
         access_session.id AS session_id,
         access_session.generation AS session_generation
  FROM canonical_score_events event
  LEFT JOIN scoring_access_sessions access_session
    ON access_session.id = event.actor_access_session_id
   AND access_session.match_id = event.match_id
   AND access_session.competition_id = event.competition_id
   AND access_session.generation = event.writer_generation
  WHERE event.actor_access_session_id IS NOT NULL
    AND access_session.id IS NULL;
  ```
- **Remediation Procedure**:
  1. Cross-reference `match_writer_leases` and `scoring_access_sessions` for the affected session IDs to verify if the session row generation was modified or unaligned.
  2. If the session generation record was omitted or desynchronized during a historical lease takeover:
     ```sql
     BEGIN;
     -- Verify matching session exists
     SELECT * FROM scoring_access_sessions WHERE id = '<actor_access_session_id>';
     -- Align session generation if authoritative lease records confirm the generation
     UPDATE scoring_access_sessions
     SET generation = <authoritative_generation>
     WHERE id = '<actor_access_session_id>' AND match_id = '<match_id>';
     COMMIT;
     ```
  3. Re-run diagnosis query to ensure zero orphaned event generations.

#### Symptom 3: Result Conflict Lifecycle Receipt Abort

- **Error message**:
  `result conflicts contain an invalid lifecycle receipt; invalid conflict ids: <ids>`
- **Diagnosis SQL**:
  ```sql
  SELECT id, competition_id, status,
         acknowledged_at, acknowledged_by_account_id, acknowledgement_client_event_id,
         acknowledgement_fingerprint, acknowledgement_reason,
         resolved_at, resolved_by_account_id, resolution_reason
  FROM result_conflicts
  WHERE NOT (
    (
      status = 'open'
      AND acknowledged_at IS NULL AND acknowledged_by_account_id IS NULL
      AND acknowledgement_client_event_id IS NULL AND acknowledgement_fingerprint IS NULL
      AND acknowledgement_reason IS NULL AND resolved_at IS NULL AND resolved_by_account_id IS NULL
      AND resolution_reason IS NULL
    )
    OR (
      status = 'acknowledged'
      AND acknowledged_at IS NOT NULL AND acknowledged_by_account_id IS NOT NULL
      AND acknowledgement_client_event_id IS NOT NULL AND acknowledgement_fingerprint IS NOT NULL
      AND acknowledgement_reason IS NOT NULL AND length(btrim(acknowledgement_reason)) BETWEEN 3 AND 1000
      AND resolved_at IS NULL AND resolved_by_account_id IS NULL AND resolution_reason IS NULL
    )
    OR (
      status = 'resolved'
      AND acknowledged_at IS NOT NULL AND acknowledged_by_account_id IS NOT NULL
      AND acknowledgement_client_event_id IS NOT NULL AND acknowledgement_fingerprint IS NOT NULL
      AND acknowledgement_reason IS NOT NULL AND length(btrim(acknowledgement_reason)) BETWEEN 3 AND 1000
      AND resolved_at IS NOT NULL AND resolved_by_account_id IS NOT NULL
      AND resolution_reason IS NOT NULL AND length(btrim(resolution_reason)) BETWEEN 3 AND 1000
    )
  ) IS TRUE;
  ```
- **Remediation Procedure**:
  1. For `status = 'acknowledged'` missing acknowledgement metadata: recover the operator account ID and receipt from audit log.
  2. For `status = 'open'` having partially populated fields: null out extraneous draft values or advance status with complete receipt.
  3. Execute inside a transaction and verify with diagnosis SQL.

### Post-Migration 0030 Verification

```sql
-- Verify constraint presence
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'canonical_score_events'::regclass
  AND conname IN (
    'canonical_score_events_reversal_reason_required',
    'canonical_score_events_reopen_reason_required',
    'canonical_score_events_writer_generation_fkey'
  );

-- Verify scheduled_matches backfill
SELECT count(*) AS unbacked_scheduled_matches
FROM scheduled_matches
WHERE home_entry_id IS NULL OR away_entry_id IS NULL;
```

---

## Migration 0031: Participant Snapshot Fencing & Immutability

### Purpose

Migration 0031 introduces:

- Mandatory `division_id` on `scheduled_matches`.
- Foreign key constraints ensuring `scheduled_matches` entries belong to the exact division and competition.
- Trigger `scheduled_matches_participant_snapshot_immutable` preventing mutations of snapshot identity.

### Failure Symptoms and Diagnosis

#### Symptom: Cross-Division Participant Snapshot Abort

- **Error message**:
  `scheduled participant snapshots must belong to the authoritative match division and competition; invalid assignments: <schedule_id/match_id>`
- **Diagnosis SQL**:
  ```sql
  SELECT scheduled.schedule_revision_id,
         scheduled.match_id,
         scheduled.competition_id,
         scheduled.division_id,
         match.division_id AS authoritative_match_division,
         scheduled.home_entry_id,
         home_entry.division_id AS home_entry_division,
         scheduled.away_entry_id,
         away_entry.division_id AS away_entry_division
  FROM scheduled_matches scheduled
  LEFT JOIN matches match
    ON match.id = scheduled.match_id
   AND match.competition_id = scheduled.competition_id
  LEFT JOIN divisions division
    ON division.id = scheduled.division_id
   AND division.competition_id = scheduled.competition_id
  LEFT JOIN division_entries home_entry
    ON home_entry.id = scheduled.home_entry_id
   AND home_entry.division_id = scheduled.division_id
  LEFT JOIN division_entries away_entry
    ON away_entry.id = scheduled.away_entry_id
   AND away_entry.division_id = scheduled.division_id
  WHERE scheduled.division_id IS NULL
     OR division.id IS NULL
     OR (scheduled.home_entry_id IS NOT NULL AND home_entry.id IS NULL)
     OR (scheduled.away_entry_id IS NOT NULL AND away_entry.id IS NULL);
  ```

### Remediation Procedure

1. Identify whether `division_id` is unpopulated or if participant entries reference sibling divisions.
2. In an explicit transaction, backfill `division_id` and correct participant snapshots from authoritative `matches`:
   ```sql
   BEGIN;
   -- 1. Sync division_id from authoritative matches
   UPDATE scheduled_matches scheduled
   SET division_id = match.division_id
   FROM matches match
   WHERE match.id = scheduled.match_id
     AND match.competition_id = scheduled.competition_id
     AND (scheduled.division_id IS NULL OR scheduled.division_id <> match.division_id);

   -- 2. Sync home and away entries from authoritative matches if mismatched
   UPDATE scheduled_matches scheduled
   SET home_entry_id = match.home_entry_id,
       away_entry_id = match.away_entry_id
   FROM matches match
   WHERE match.id = scheduled.match_id
     AND match.competition_id = scheduled.competition_id
     AND (
       (scheduled.home_entry_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM division_entries de WHERE de.id = scheduled.home_entry_id AND de.division_id = match.division_id
       ))
       OR
       (scheduled.away_entry_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM division_entries de WHERE de.id = scheduled.away_entry_id AND de.division_id = match.division_id
       ))
     );
   COMMIT;
   ```
3. Re-run diagnosis query to verify 0 invalid assignments before continuing migration.

### Post-Migration 0031 Verification

```sql
-- Verify foreign keys
SELECT conname
FROM pg_constraint
WHERE conrelid = 'scheduled_matches'::regclass
  AND conname IN (
    'scheduled_matches_division_competition_fkey',
    'scheduled_matches_home_entry_division_fkey',
    'scheduled_matches_away_entry_division_fkey'
  );

-- Verify immutable trigger is active
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'scheduled_matches'::regclass
  AND tgname = 'scheduled_matches_participant_snapshot_immutable';
```

---

## Migration 0038: Repair Schedule Participant Snapshots

### Purpose

Migration 0038 introduces:

- `source_repair_revision_id` column and foreign key on `schedule_revisions`.
- Dynamic participant snapshot resolution function `gate_c_resolved_repair_entry` supporting `accept_proposed`, `set_manual_entry`, `keep_current`, and `leave_protected`.
- State fencing ensuring started, finalised, or corrected matches cannot have their participants overwritten.
- Division boundary enforcement for repair-resolved participants.
- Immutability trigger `schedule_revisions_repair_source_immutable`.

### Failure Symptoms and Diagnosis

#### Symptom 1: Missing or Unsupported Repair Decision

- **Error message**:
  `repair-derived schedule requires a retained decision for every affected participant slot` or
  `repair-derived schedule contains an unsupported participant decision`
- **Diagnosis SQL**:
  ```sql
  SELECT revision.id AS schedule_revision_id,
         revision.source_repair_revision_id,
         action.id AS action_id,
         action.match_id,
         action.slot,
         action.proposed_entry_id,
         decision.id AS decision_id,
         decision.decision,
         decision.selected_entry_id
  FROM schedule_revisions revision
  JOIN schedule_repair_actions action
    ON action.repair_revision_id = revision.source_repair_revision_id
  LEFT JOIN schedule_repair_decisions decision
    ON decision.repair_action_id = action.id
  WHERE revision.source_repair_revision_id IS NOT NULL
    AND (
      decision.id IS NULL
      OR decision.decision NOT IN ('accept_proposed', 'set_manual_entry', 'keep_current', 'leave_protected')
    );
  ```
- **Remediation Procedure**:
  1. Inspect the repair audit trail in `schedule_repair_revisions` and organizer review logs.
  2. Insert missing retained decisions with proper operator attribution:
     ```sql
     BEGIN;
     INSERT INTO schedule_repair_decisions (
       id, repair_action_id, decision, selected_entry_id, decided_by_account_id, decided_at
     )
     SELECT gen_random_uuid(), action.id, 'keep_current', NULL, repair.created_by, now()
     FROM schedule_repair_actions action
     JOIN schedule_repair_revisions repair ON repair.id = action.repair_revision_id
     WHERE action.id = '<unresolved_action_id>';
     COMMIT;
     ```

#### Symptom 2: Started/Finalised Match Participant Mutation Conflict

- **Error message**:
  `started or finalised match participants cannot be changed by schedule repair`
- **Diagnosis SQL**:
  ```sql
  SELECT revision.id AS schedule_revision_id,
         repair.id AS repair_revision_id,
         match.id AS match_id,
         match.state AS match_state,
         match.home_entry_id AS authoritative_home,
         match.away_entry_id AS authoritative_away,
         action.slot,
         decision.decision
  FROM schedule_revisions revision
  JOIN schedule_repair_revisions repair ON repair.id = revision.source_repair_revision_id
  JOIN scheduled_matches sm ON sm.schedule_revision_id = revision.id
  JOIN matches match ON match.id = sm.match_id
  JOIN schedule_repair_actions action ON action.repair_revision_id = repair.id AND action.match_id = match.id
  JOIN schedule_repair_decisions decision ON decision.repair_action_id = action.id
  WHERE revision.source_repair_revision_id IS NOT NULL
    AND match.state IN ('in_progress', 'final', 'corrected')
    AND decision.decision IN ('accept_proposed', 'set_manual_entry');
  ```
- **Remediation Procedure**:
  1. Matches that have already started or concluded cannot have their participants altered. Update the repair decision to `keep_current` or `leave_protected` to preserve in-progress game integrity:
     ```sql
     BEGIN;
     UPDATE schedule_repair_decisions
     SET decision = 'leave_protected', selected_entry_id = NULL
     WHERE id = '<decision_id>';
     COMMIT;
     ```

### Post-Migration 0038 Verification

```sql
-- Verify repair source column and index
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'schedule_revisions' AND column_name = 'source_repair_revision_id';

SELECT indexname FROM pg_indexes
WHERE tablename = 'schedule_revisions' AND indexname = 'schedule_revisions_one_per_repair_revision';

-- Verify trigger definition
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'schedule_revisions'::regclass
  AND tgname = 'schedule_revisions_repair_source_immutable';
```

---

## Migration Re-run Procedure

After completing data repair:

1. Ensure the PostgreSQL connection is active and has schema migration privileges.
2. Execute migration check to verify clean migration from the baseline:
   ```sh
   pnpm db:migrate:check
   ```
3. Run the database integration test suite to verify all preflights and triggers:
   ```sh
   RUN_INFRA_TESTS=1 pnpm --filter @matchday/database test:integration
   ```
4. Verify application read and write paths with API integration tests:
   ```sh
   pnpm --filter @matchday/api test:integration
   ```
