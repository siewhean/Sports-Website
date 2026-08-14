-- Gate C C2 canonical five-sport scoring, projection, and correction foundation.
-- The Phase 2 Canoe Polo score_events table remains readable for historical
-- aggregates. New writes use the sport-neutral stream below.

CREATE TABLE match_score_streams (
  match_id uuid PRIMARY KEY,
  competition_id uuid NOT NULL,
  division_id uuid NOT NULL,
  sport_code text NOT NULL CHECK (
    sport_code IN ('canoe_polo','badminton','table_tennis','volleyball','basketball')
  ),
  pack_version text NOT NULL,
  settings_snapshot jsonb NOT NULL,
  settings_fingerprint text NOT NULL CHECK (length(settings_fingerprint)=64),
  current_version integer NOT NULL DEFAULT 0 CHECK (current_version>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (match_id,competition_id) REFERENCES matches(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (division_id,competition_id) REFERENCES divisions(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (sport_code,pack_version) REFERENCES sport_pack_versions(sport_code,version),
  UNIQUE (match_id,competition_id,division_id),
  CHECK (jsonb_typeof(settings_snapshot)='object')
);

CREATE TABLE canonical_score_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL,
  division_id uuid NOT NULL,
  match_id uuid NOT NULL,
  client_event_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version>0),
  sequence integer NOT NULL CHECK (sequence>0),
  event_type text NOT NULL CHECK (length(btrim(event_type)) BETWEEN 1 AND 80),
  command jsonb NOT NULL,
  command_fingerprint text NOT NULL CHECK (length(command_fingerprint)=64),
  actor_access_session_id uuid,
  actor_account_id uuid REFERENCES accounts(id),
  writer_generation integer,
  device_timestamp timestamptz NOT NULL,
  server_timestamp timestamptz NOT NULL DEFAULT now(),
  reversal_target_event_id uuid,
  reason text,
  legacy_score_event_id uuid UNIQUE REFERENCES score_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (match_id,competition_id,division_id)
    REFERENCES match_score_streams(match_id,competition_id,division_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_access_session_id,match_id,competition_id)
    REFERENCES scoring_access_sessions(id,match_id,competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (reversal_target_event_id)
    REFERENCES canonical_score_events(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (match_id,client_event_id),
  UNIQUE (match_id,aggregate_version),
  UNIQUE (match_id,sequence),
  UNIQUE (id,match_id),
  CHECK (jsonb_typeof(command)='object'),
  CHECK (sequence=aggregate_version),
  CHECK ((actor_access_session_id IS NOT NULL)::integer + (actor_account_id IS NOT NULL)::integer = 1),
  CHECK (
    (actor_access_session_id IS NOT NULL AND writer_generation IS NOT NULL AND writer_generation>0)
    OR
    (actor_account_id IS NOT NULL AND writer_generation IS NULL)
  ),
  CHECK (event_type<>'reversal' OR (reversal_target_event_id IS NOT NULL AND length(btrim(reason))>=3)),
  CHECK (event_type<>'match_reopened' OR length(btrim(reason))>=3)
);

CREATE FUNCTION gate_c_guard_score_stream_update() RETURNS trigger AS $$
BEGIN
  IF NEW.match_id IS DISTINCT FROM OLD.match_id
     OR NEW.competition_id IS DISTINCT FROM OLD.competition_id
     OR NEW.division_id IS DISTINCT FROM OLD.division_id
     OR NEW.sport_code IS DISTINCT FROM OLD.sport_code
     OR NEW.pack_version IS DISTINCT FROM OLD.pack_version
     OR NEW.settings_snapshot IS DISTINCT FROM OLD.settings_snapshot
     OR NEW.settings_fingerprint IS DISTINCT FROM OLD.settings_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'score stream sport and settings context is immutable';
  END IF;
  IF NEW.current_version<OLD.current_version THEN
    RAISE EXCEPTION 'score stream version cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER match_score_streams_context_guard
BEFORE UPDATE ON match_score_streams
FOR EACH ROW EXECUTE FUNCTION gate_c_guard_score_stream_update();

CREATE INDEX canonical_score_events_match_version_idx
ON canonical_score_events(match_id,aggregate_version);

CREATE INDEX canonical_score_events_competition_timestamp_idx
ON canonical_score_events(competition_id,server_timestamp,id);

CREATE TABLE score_correction_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL,
  division_id uuid NOT NULL,
  match_id uuid NOT NULL,
  client_event_id uuid NOT NULL,
  command_fingerprint text NOT NULL CHECK (length(command_fingerprint)=64),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  from_aggregate_version integer NOT NULL CHECK (from_aggregate_version>=0),
  through_aggregate_version integer NOT NULL CHECK (through_aggregate_version>from_aggregate_version),
  result_version integer NOT NULL CHECK (result_version>0),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (match_id,competition_id,division_id)
    REFERENCES match_score_streams(match_id,competition_id,division_id) ON DELETE RESTRICT,
  UNIQUE (match_id,client_event_id)
);

CREATE TRIGGER score_correction_transactions_immutable
BEFORE UPDATE OR DELETE ON score_correction_transactions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();

CREATE FUNCTION gate_c_prevent_score_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'canonical score events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER canonical_score_events_immutable
BEFORE UPDATE OR DELETE ON canonical_score_events
FOR EACH ROW EXECUTE FUNCTION gate_c_prevent_score_event_mutation();

CREATE FUNCTION gate_c_validate_reversal_target() RETURNS trigger AS $$
BEGIN
  IF NEW.reversal_target_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM canonical_score_events target
    WHERE target.id=NEW.reversal_target_event_id
      AND target.match_id=NEW.match_id
      AND target.aggregate_version<NEW.aggregate_version
      AND target.event_type NOT IN (
        'match_started','match_reopened','finalisation','reversal',
        'game_completion','set_completion','period_change','deciding_set','overtime'
      )
  ) THEN
    RAISE EXCEPTION 'reversal target must be an earlier reversible event in the same match';
  END IF;
  IF NEW.reversal_target_event_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM canonical_score_events reversal
    WHERE reversal.match_id=NEW.match_id
      AND reversal.event_type='reversal'
      AND reversal.reversal_target_event_id=NEW.reversal_target_event_id
  ) THEN
    RAISE EXCEPTION 'score event has already been reversed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER canonical_score_events_reversal_guard
BEFORE INSERT ON canonical_score_events
FOR EACH ROW EXECUTE FUNCTION gate_c_validate_reversal_target();

-- Backfill deployed Canoe Polo streams without mutating their original event
-- history. The original UUID is retained as the canonical event UUID so links
-- and reversal targets can be resolved deterministically.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM score_events score
    JOIN matches match ON match.id=score.match_id
    LEFT JOIN competition_sport_settings settings ON settings.competition_id=match.competition_id
    LEFT JOIN sport_pack_versions pack
      ON pack.sport_code='canoe_polo' AND pack.version=settings.pack_version
    LEFT JOIN division_sport_settings division_settings ON division_settings.division_id=match.division_id
    WHERE settings.pack_version IS NULL OR pack.version IS NULL
       OR (division_settings.pack_version IS NOT NULL
         AND division_settings.pack_version<>settings.pack_version)
  ) THEN
    RAISE EXCEPTION
      'legacy score history requires an authoritative Canoe Polo pack version before Gate C migration';
  END IF;
END;
$$;

INSERT INTO match_score_streams (
  match_id,competition_id,division_id,sport_code,pack_version,
  settings_snapshot,settings_fingerprint,current_version,created_at,updated_at
)
SELECT
  match.id,match.competition_id,match.division_id,'canoe_polo',
  settings.pack_version,
  settings.recommended_snapshot || settings.settings_override ||
    COALESCE(division_settings.settings_override,'{}'::jsonb),
  encode(digest(convert_to(
    phase3_canonical_jsonb(
      settings.recommended_snapshot || settings.settings_override ||
      COALESCE(division_settings.settings_override,'{}'::jsonb)
    ),'UTF8'
  ),'sha256'),'hex'),
  max(score.sequence),min(score.received_at),max(score.received_at)
FROM score_events score
JOIN matches match ON match.id=score.match_id
JOIN competition_sport_settings settings ON settings.competition_id=match.competition_id
LEFT JOIN division_sport_settings division_settings ON division_settings.division_id=match.division_id
GROUP BY
  match.id,match.competition_id,match.division_id,settings.pack_version,
  settings.recommended_snapshot,settings.settings_override,division_settings.settings_override;

INSERT INTO canonical_score_events (
  id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
  command,command_fingerprint,actor_access_session_id,actor_account_id,writer_generation,
  device_timestamp,server_timestamp,reversal_target_event_id,reason,legacy_score_event_id
)
SELECT
  score.id,match.competition_id,match.division_id,score.match_id,score.client_event_id,score.sequence,score.sequence,
  CASE score.event_type
    WHEN 'period_changed' THEN 'period_change'
    WHEN 'goal_added' THEN 'goal'
    WHEN 'goal_reversed' THEN 'reversal'
    WHEN 'card_added' THEN COALESCE(score.payload->>'colour','') || '_card'
    WHEN 'card_reversed' THEN 'reversal'
    WHEN 'timeout_added' THEN 'timeout'
    WHEN 'incident_added' THEN 'incident'
    WHEN 'match_finalised' THEN 'finalisation'
    WHEN 'correction' THEN 'legacy_correction'
    ELSE score.event_type
  END,
  command.document,
  encode(digest(convert_to(phase3_canonical_jsonb(command.document),'UTF8'),'sha256'),'hex'),
  score.actor_access_session_id,score.actor_account_id,
  CASE WHEN score.actor_access_session_id IS NOT NULL THEN score.writer_generation ELSE NULL END,
  score.occurred_at,score.received_at,target.id,score.correction_reason,score.id
FROM score_events score
JOIN matches match ON match.id=score.match_id
LEFT JOIN score_events target
  ON target.match_id=score.match_id
 AND target.client_event_id::text=score.payload->>'reversal_target_event_id'
CROSS JOIN LATERAL (
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'client_event_id',score.client_event_id,
    'type',CASE score.event_type
      WHEN 'period_changed' THEN 'period_change'
      WHEN 'goal_added' THEN 'goal'
      WHEN 'goal_reversed' THEN 'reversal'
      WHEN 'card_added' THEN COALESCE(score.payload->>'colour','') || '_card'
      WHEN 'card_reversed' THEN 'reversal'
      WHEN 'timeout_added' THEN 'timeout'
      WHEN 'incident_added' THEN 'incident'
      WHEN 'match_finalised' THEN 'finalisation'
      WHEN 'correction' THEN 'legacy_correction'
      ELSE score.event_type
    END,
    'occurred_at',score.occurred_at,
    'team_slot',score.team_slot,
    'participant_id',score.scorer,
    'segment_number',score.manual_period,
    'manual_time_seconds',score.manual_event_seconds,
    'reversal_target_event_id',target.id,
    'reason',score.correction_reason
  )) AS document
) command
WHERE score.event_type NOT IN ('goal_reversed','card_reversed');

-- Reversal targets must already be visible to the database trigger, so legacy
-- reversals are inserted only after every possible target has been retained.
INSERT INTO canonical_score_events (
  id,competition_id,division_id,match_id,client_event_id,aggregate_version,sequence,event_type,
  command,command_fingerprint,actor_access_session_id,actor_account_id,writer_generation,
  device_timestamp,server_timestamp,reversal_target_event_id,reason,legacy_score_event_id
)
SELECT
  score.id,match.competition_id,match.division_id,score.match_id,score.client_event_id,score.sequence,score.sequence,
  'reversal',command.document,
  encode(digest(convert_to(phase3_canonical_jsonb(command.document),'UTF8'),'sha256'),'hex'),
  score.actor_access_session_id,score.actor_account_id,
  CASE WHEN score.actor_access_session_id IS NOT NULL THEN score.writer_generation ELSE NULL END,
  score.occurred_at,score.received_at,target.id,score.correction_reason,score.id
FROM score_events score
JOIN matches match ON match.id=score.match_id
JOIN score_events target
  ON target.match_id=score.match_id
 AND target.client_event_id::text=score.payload->>'reversal_target_event_id'
CROSS JOIN LATERAL (
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'client_event_id',score.client_event_id,
    'type','reversal',
    'occurred_at',score.occurred_at,
    'segment_number',score.manual_period,
    'manual_time_seconds',score.manual_event_seconds,
    'reversal_target_event_id',target.id,
    'reason',score.correction_reason
  )) AS document
) command
WHERE score.event_type IN ('goal_reversed','card_reversed');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM score_events score
    WHERE score.event_type IN ('goal_reversed','card_reversed')
      AND NOT EXISTS (
        SELECT 1 FROM canonical_score_events canonical
        WHERE canonical.legacy_score_event_id=score.id
      )
  ) THEN
    RAISE EXCEPTION 'legacy reversal history contains an unresolved target';
  END IF;
END;
$$;

CREATE TABLE result_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL,
  division_id uuid NOT NULL,
  corrected_match_id uuid NOT NULL,
  downstream_match_id uuid NOT NULL,
  result_version integer NOT NULL CHECK (result_version>0),
  reason text NOT NULL CHECK (
    reason IN ('downstream_match_started','downstream_result_finalised','manual_slot_preserved')
  ),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by_account_id uuid REFERENCES accounts(id),
  acknowledgement_client_event_id uuid UNIQUE,
  acknowledgement_fingerprint text CHECK (
    acknowledgement_fingerprint IS NULL OR length(acknowledgement_fingerprint)=64
  ),
  acknowledgement_reason text,
  resolved_at timestamptz,
  resolved_by_account_id uuid REFERENCES accounts(id),
  resolution_reason text,
  FOREIGN KEY (division_id,competition_id) REFERENCES divisions(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (corrected_match_id,competition_id) REFERENCES matches(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (downstream_match_id,competition_id) REFERENCES matches(id,competition_id) ON DELETE CASCADE,
  UNIQUE (competition_id,result_version,corrected_match_id,downstream_match_id,reason),
  CHECK (corrected_match_id<>downstream_match_id),
  CHECK (
    (status='open' AND acknowledged_at IS NULL AND acknowledged_by_account_id IS NULL
      AND acknowledgement_client_event_id IS NULL AND acknowledgement_fingerprint IS NULL
      AND acknowledgement_reason IS NULL AND resolved_at IS NULL AND resolved_by_account_id IS NULL
      AND resolution_reason IS NULL)
    OR
    (status='acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_by_account_id IS NOT NULL
      AND acknowledgement_client_event_id IS NOT NULL AND acknowledgement_fingerprint IS NOT NULL
      AND length(btrim(acknowledgement_reason)) BETWEEN 3 AND 1000
      AND resolved_at IS NULL AND resolved_by_account_id IS NULL AND resolution_reason IS NULL)
    OR
    (status='resolved' AND acknowledged_at IS NOT NULL AND acknowledged_by_account_id IS NOT NULL
      AND acknowledgement_client_event_id IS NOT NULL AND acknowledgement_fingerprint IS NOT NULL
      AND length(btrim(acknowledgement_reason)) BETWEEN 3 AND 1000
      AND resolved_at IS NOT NULL AND resolved_by_account_id IS NOT NULL
      AND length(btrim(resolution_reason)) BETWEEN 3 AND 1000)
  )
);

CREATE INDEX result_conflicts_organiser_queue_idx
ON result_conflicts(competition_id,status,created_at,id);

CREATE FUNCTION gate_c_guard_result_conflict_update() RETURNS trigger AS $$
BEGIN
  IF NEW.competition_id IS DISTINCT FROM OLD.competition_id
     OR NEW.division_id IS DISTINCT FROM OLD.division_id
     OR NEW.corrected_match_id IS DISTINCT FROM OLD.corrected_match_id
     OR NEW.downstream_match_id IS DISTINCT FROM OLD.downstream_match_id
     OR NEW.result_version IS DISTINCT FROM OLD.result_version
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.detail IS DISTINCT FROM OLD.detail
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'result conflict source facts are immutable';
  END IF;
  IF OLD.status='resolved' OR (OLD.status='acknowledged' AND NEW.status<>'resolved') THEN
    RAISE EXCEPTION 'result conflict lifecycle cannot move backwards';
  END IF;
  IF OLD.status<>'open' AND (
       NEW.acknowledgement_client_event_id IS DISTINCT FROM OLD.acknowledgement_client_event_id
       OR NEW.acknowledgement_fingerprint IS DISTINCT FROM OLD.acknowledgement_fingerprint
       OR NEW.acknowledgement_reason IS DISTINCT FROM OLD.acknowledgement_reason
       OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
       OR NEW.acknowledged_by_account_id IS DISTINCT FROM OLD.acknowledged_by_account_id
     ) THEN
    RAISE EXCEPTION 'result conflict acknowledgement receipt is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER result_conflicts_lifecycle_guard
BEFORE UPDATE ON result_conflicts
FOR EACH ROW EXECUTE FUNCTION gate_c_guard_result_conflict_update();

CREATE TRIGGER result_conflicts_no_delete
BEFORE DELETE ON result_conflicts
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
