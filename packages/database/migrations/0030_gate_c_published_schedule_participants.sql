ALTER TABLE scheduled_matches
  ADD COLUMN home_entry_id uuid REFERENCES division_entries(id) ON DELETE RESTRICT,
  ADD COLUMN away_entry_id uuid REFERENCES division_entries(id) ON DELETE RESTRICT;

UPDATE scheduled_matches scheduled
SET home_entry_id=match.home_entry_id,
    away_entry_id=match.away_entry_id
FROM matches match
WHERE match.id=scheduled.match_id;

CREATE FUNCTION gate_c_snapshot_schedule_participants()
RETURNS trigger AS $$
BEGIN
  SELECT match.home_entry_id,match.away_entry_id
  INTO NEW.home_entry_id,NEW.away_entry_id
  FROM matches match
  WHERE match.id=NEW.match_id AND match.competition_id=NEW.competition_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled match must reference an authoritative competition match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scheduled_matches_participant_snapshot
BEFORE INSERT ON scheduled_matches
FOR EACH ROW EXECUTE FUNCTION gate_c_snapshot_schedule_participants();

DO $$
DECLARE
  invalid_ids text;
  duplicate_target_ids text;
BEGIN
  SELECT string_agg(id::text,',' ORDER BY id) INTO invalid_ids
  FROM canonical_score_events
  WHERE (event_type='reversal' AND (
           reversal_target_event_id IS NULL OR reason IS NULL OR length(btrim(reason))<3
         ))
     OR (event_type='match_reopened' AND (reason IS NULL OR length(btrim(reason))<3));

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'canonical score events require retained reversal/reopen provenance; invalid event ids: %',
      invalid_ids;
  END IF;

  SELECT string_agg(reversal_target_event_id::text,',' ORDER BY reversal_target_event_id)
  INTO duplicate_target_ids
  FROM (
    SELECT reversal_target_event_id
    FROM canonical_score_events
    WHERE event_type='reversal' AND reversal_target_event_id IS NOT NULL
    GROUP BY reversal_target_event_id
    HAVING count(*)>1
  ) duplicate_targets;

  IF duplicate_target_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'canonical score events contain duplicate reversal targets: %',
      duplicate_target_ids;
  END IF;
END;
$$;

ALTER TABLE canonical_score_events
  ADD CONSTRAINT canonical_score_events_reversal_reason_required CHECK (
    event_type<>'reversal'
    OR (
      reversal_target_event_id IS NOT NULL
      AND reason IS NOT NULL
      AND length(btrim(reason))>=3
    )
  ),
  ADD CONSTRAINT canonical_score_events_reopen_reason_required CHECK (
    event_type<>'match_reopened'
    OR (reason IS NOT NULL AND length(btrim(reason))>=3)
  );

CREATE UNIQUE INDEX canonical_score_events_one_reversal_per_target_idx
ON canonical_score_events(reversal_target_event_id)
WHERE event_type='reversal' AND reversal_target_event_id IS NOT NULL;

DO $$
DECLARE invalid_ids text;
BEGIN
  SELECT string_agg(event.id::text,',' ORDER BY event.id) INTO invalid_ids
  FROM canonical_score_events event
  LEFT JOIN scoring_access_sessions access_session
    ON access_session.id=event.actor_access_session_id
   AND access_session.match_id=event.match_id
   AND access_session.competition_id=event.competition_id
   AND access_session.generation=event.writer_generation
  WHERE event.actor_access_session_id IS NOT NULL
    AND access_session.id IS NULL;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'canonical score events contain writer generations that do not match their scoring sessions: %',
      invalid_ids;
  END IF;
END;
$$;

ALTER TABLE scoring_access_sessions
  ADD CONSTRAINT scoring_access_sessions_event_writer_generation_key
  UNIQUE (id,match_id,competition_id,generation);

ALTER TABLE canonical_score_events
  ADD CONSTRAINT canonical_score_events_writer_generation_fkey
  FOREIGN KEY (actor_access_session_id,match_id,competition_id,writer_generation)
  REFERENCES scoring_access_sessions(id,match_id,competition_id,generation)
  ON DELETE RESTRICT;

CREATE FUNCTION gate_c_validate_score_event_writer_session()
RETURNS trigger AS $$
BEGIN
  IF NEW.actor_access_session_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.match_id::text,0));

  PERFORM 1
  FROM match_writer_leases lease
  WHERE lease.match_id=NEW.match_id
    AND lease.competition_id=NEW.competition_id
    AND lease.access_session_id=NEW.actor_access_session_id
    AND lease.generation=NEW.writer_generation
    AND lease.session_mode='writer'
    AND lease.expires_at>clock_timestamp()
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'canonical score event writer generation must reference the active writer lease'
      USING
        ERRCODE='23514',
        CONSTRAINT='canonical_score_events_writer_session_guard';
  END IF;

  PERFORM 1
  FROM scoring_access_sessions access_session
  JOIN scoring_access_passes access_pass
    ON access_pass.id=access_session.access_pass_id
   AND access_pass.match_id=access_session.match_id
   AND access_pass.competition_id=access_session.competition_id
  WHERE access_session.id=NEW.actor_access_session_id
    AND access_session.match_id=NEW.match_id
    AND access_session.competition_id=NEW.competition_id
    AND access_session.generation=NEW.writer_generation
    AND access_session.mode='writer'
    AND access_session.revoked_at IS NULL
    AND access_session.expires_at>clock_timestamp()
    AND access_pass.revoked_at IS NULL
    AND access_pass.expires_at>clock_timestamp()
  FOR SHARE OF access_session,access_pass;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'canonical score event writer generation must reference an active writer scoring session'
      USING
        ERRCODE='23514',
        CONSTRAINT='canonical_score_events_writer_session_guard';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER canonical_score_events_writer_session_guard
BEFORE INSERT ON canonical_score_events
FOR EACH ROW EXECUTE FUNCTION gate_c_validate_score_event_writer_session();

DO $$
DECLARE invalid_ids text;
BEGIN
  SELECT string_agg(id::text,',' ORDER BY id) INTO invalid_ids
  FROM result_conflicts
  WHERE NOT (
    (
      status='open'
      AND acknowledged_at IS NULL
      AND acknowledged_by_account_id IS NULL
      AND acknowledgement_client_event_id IS NULL
      AND acknowledgement_fingerprint IS NULL
      AND acknowledgement_reason IS NULL
      AND resolved_at IS NULL
      AND resolved_by_account_id IS NULL
      AND resolution_reason IS NULL
    )
    OR (
      status='acknowledged'
      AND acknowledged_at IS NOT NULL
      AND acknowledged_by_account_id IS NOT NULL
      AND acknowledgement_client_event_id IS NOT NULL
      AND acknowledgement_fingerprint IS NOT NULL
      AND acknowledgement_reason IS NOT NULL
      AND length(btrim(acknowledgement_reason)) BETWEEN 3 AND 1000
      AND resolved_at IS NULL
      AND resolved_by_account_id IS NULL
      AND resolution_reason IS NULL
    )
    OR (
      status='resolved'
      AND acknowledged_at IS NOT NULL
      AND acknowledged_by_account_id IS NOT NULL
      AND acknowledgement_client_event_id IS NOT NULL
      AND acknowledgement_fingerprint IS NOT NULL
      AND acknowledgement_reason IS NOT NULL
      AND length(btrim(acknowledgement_reason)) BETWEEN 3 AND 1000
      AND resolved_at IS NOT NULL
      AND resolved_by_account_id IS NOT NULL
      AND resolution_reason IS NOT NULL
      AND length(btrim(resolution_reason)) BETWEEN 3 AND 1000
    )
  ) IS TRUE;

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'result conflicts contain an invalid lifecycle receipt; invalid conflict ids: %',
      invalid_ids;
  END IF;
END;
$$;

ALTER TABLE result_conflicts
  ADD CONSTRAINT result_conflicts_lifecycle_receipt_required CHECK (
    (
      (status='open' AND acknowledged_at IS NULL AND acknowledged_by_account_id IS NULL
        AND acknowledgement_client_event_id IS NULL AND acknowledgement_fingerprint IS NULL
        AND acknowledgement_reason IS NULL AND resolved_at IS NULL AND resolved_by_account_id IS NULL
        AND resolution_reason IS NULL)
      OR
      (status='acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_by_account_id IS NOT NULL
        AND acknowledgement_client_event_id IS NOT NULL AND acknowledgement_fingerprint IS NOT NULL
        AND acknowledgement_reason IS NOT NULL
        AND length(btrim(acknowledgement_reason)) BETWEEN 3 AND 1000
        AND resolved_at IS NULL AND resolved_by_account_id IS NULL AND resolution_reason IS NULL)
      OR
      (status='resolved' AND acknowledged_at IS NOT NULL AND acknowledged_by_account_id IS NOT NULL
        AND acknowledgement_client_event_id IS NOT NULL AND acknowledgement_fingerprint IS NOT NULL
        AND acknowledgement_reason IS NOT NULL
        AND length(btrim(acknowledgement_reason)) BETWEEN 3 AND 1000
        AND resolved_at IS NOT NULL AND resolved_by_account_id IS NOT NULL
        AND resolution_reason IS NOT NULL
        AND length(btrim(resolution_reason)) BETWEEN 3 AND 1000)
    ) IS TRUE
  );

ALTER TABLE matches
  ADD CONSTRAINT matches_id_competition_division_unique UNIQUE (id,competition_id,division_id);

ALTER TABLE match_score_streams
  ADD CONSTRAINT match_score_streams_match_division_fk
  FOREIGN KEY (match_id,competition_id,division_id)
  REFERENCES matches(id,competition_id,division_id) ON DELETE CASCADE;

ALTER TABLE result_conflicts
  ADD CONSTRAINT result_conflicts_corrected_match_division_fk
  FOREIGN KEY (corrected_match_id,competition_id,division_id)
  REFERENCES matches(id,competition_id,division_id) ON DELETE CASCADE,
  ADD CONSTRAINT result_conflicts_downstream_match_division_fk
  FOREIGN KEY (downstream_match_id,competition_id,division_id)
  REFERENCES matches(id,competition_id,division_id) ON DELETE CASCADE;
