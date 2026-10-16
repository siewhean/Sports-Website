-- Redesign Phase 0 (scheduling safety): started and finished matches keep their published placement.
--
-- Function-only migration: no table, column, constraint or row changes, so existing and archived
-- rows are untouched and need no backfill. Both functions only accept MORE snapshots than before;
-- every snapshot valid under 0027/0066 stays valid.
--
-- 1. Solver snapshots may fix a match with reason 'started' (state in_progress) or 'finished'
--    (final/corrected, which includes walkovers and forfeits) in addition to 'locked' and
--    'published_history'. The body is 0066's search-path-safe validator with only that list widened.
-- 2. A started/finished match whose published slot is no longer in current capacity (court closed,
--    hours changed, or the slot became a reserve) is carried as a slot `historical:<match id>`
--    with interval_id = match id. The input guard accepts such a slot only when it is exactly that
--    match's placement in the latest published revision and the snapshot fixes the match there;
--    every other slot must still lie inside authoritative capacity, as in 0027.
DO $migration$
DECLARE
  target_schema text := current_schema();
BEGIN
  EXECUTE format($function$
CREATE OR REPLACE FUNCTION %1$I.phase4_schedule_input_valid(value jsonb) RETURNS boolean AS $$
DECLARE match_value jsonb; slot_value jsonb; setting_value jsonb; constraint_key text;
DECLARE constraint_keys text[]:=ARRAY['minimum_rest','maximum_matches_per_day','preferred_final_time','entry_unavailable',
  'official_availability','featured_playing_area','avoid_consecutive_matches','balance_early_matches','balance_late_matches',
  'keep_division_together','preserve_existing_schedule'];
BEGIN
  IF jsonb_typeof(value)<>'object'
     OR (SELECT count(*)<>11 OR NOT bool_and(key=ANY(ARRAY['schema_version','job_id','competition_id','source_revision','time_zone','objective','capacity_revision','capacity_hash','matches','slots','constraints']))
       FROM jsonb_object_keys(value) key)
     OR value->'schema_version'<>'1'::jsonb
     OR jsonb_typeof(value->'job_id')<>'string' OR (value->>'job_id')::uuid IS NULL
     OR jsonb_typeof(value->'competition_id')<>'string' OR (value->>'competition_id')::uuid IS NULL
     OR NOT %1$I.phase3_json_positive_integer(value->'source_revision')
     OR NOT %1$I.phase3_json_positive_integer(value->'capacity_revision')
     OR jsonb_typeof(value->'capacity_hash')<>'string' OR value->>'capacity_hash' !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(value->'time_zone')<>'string' OR btrim(value->>'time_zone')=''
     OR value->>'objective' NOT IN ('fastest','balanced','rest_focused')
     OR jsonb_typeof(value->'matches')<>'array' OR jsonb_array_length(value->'matches')=0
     OR jsonb_typeof(value->'slots')<>'array' OR jsonb_array_length(value->'slots')=0
     OR jsonb_typeof(value->'constraints')<>'object' THEN RETURN false; END IF;
  IF (SELECT count(*)<>array_length(constraint_keys,1) OR NOT bool_and(key=ANY(constraint_keys))
      FROM jsonb_object_keys(value->'constraints') key) THEN RETURN false; END IF;
  FOREACH constraint_key IN ARRAY constraint_keys LOOP
    setting_value:=value->'constraints'->constraint_key;
    IF jsonb_typeof(setting_value)<>'object' OR setting_value->>'mode' NOT IN ('required','preferred','ignored')
       OR NOT setting_value ? 'value'
       OR NOT %1$I.phase4_schedule_constraint_value_valid(constraint_key,setting_value->'value')
       OR (SELECT count(*)<>CASE WHEN setting_value ? 'weight' THEN 3 ELSE 2 END
         OR NOT bool_and(key=ANY(ARRAY['mode','value','weight'])) FROM jsonb_object_keys(setting_value) key)
       OR (setting_value ? 'weight' AND (NOT %1$I.phase3_json_positive_integer(setting_value->'weight') OR setting_value->>'mode'<>'preferred')) THEN RETURN false; END IF;
  END LOOP;
  FOR match_value IN SELECT item FROM jsonb_array_elements(value->'matches') item LOOP
    IF jsonb_typeof(match_value)<>'object'
       OR (SELECT count(*)<>CASE WHEN match_value ? 'fixed_assignment' THEN 8 ELSE 7 END
         OR NOT bool_and(key=ANY(ARRAY['match_id','division_id','duration_minutes','dependency_match_ids','possible_entry_ids','official_ids','is_championship_final','fixed_assignment']))
         FROM jsonb_object_keys(match_value) key)
       OR (match_value->>'match_id')::uuid IS NULL OR (match_value->>'division_id')::uuid IS NULL
       OR NOT %1$I.phase3_json_positive_integer(match_value->'duration_minutes')
       OR jsonb_typeof(match_value->'dependency_match_ids')<>'array' OR jsonb_typeof(match_value->'possible_entry_ids')<>'array'
       OR jsonb_array_length(match_value->'possible_entry_ids')<2
       OR jsonb_typeof(match_value->'official_ids')<>'array' OR jsonb_typeof(match_value->'is_championship_final')<>'boolean'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(match_value->'dependency_match_ids') item WHERE item::uuid IS NULL)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(match_value->'possible_entry_ids') item WHERE item::uuid IS NULL)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(match_value->'official_ids') item WHERE item::uuid IS NULL)
       OR (SELECT count(*)<>count(DISTINCT item) FROM jsonb_array_elements_text(match_value->'possible_entry_ids') item)
       OR (match_value ? 'fixed_assignment' AND (jsonb_typeof(match_value->'fixed_assignment')<>'object'
         OR (SELECT count(*)<>5 OR NOT bool_and(key=ANY(ARRAY['reason','area_id','slot_id','start_epoch_ms','end_epoch_ms']))
           FROM jsonb_object_keys(match_value->'fixed_assignment') key)
         OR match_value->'fixed_assignment'->>'reason' NOT IN ('locked','published_history','started','finished')
         OR (match_value->'fixed_assignment'->>'area_id')::uuid IS NULL OR btrim(match_value->'fixed_assignment'->>'slot_id')=''
         OR jsonb_typeof(match_value->'fixed_assignment'->'start_epoch_ms')<>'number'
         OR jsonb_typeof(match_value->'fixed_assignment'->'end_epoch_ms')<>'number')) THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*)<>count(DISTINCT item->>'match_id') FROM jsonb_array_elements(value->'matches') item) THEN RETURN false; END IF;
  FOR slot_value IN SELECT item FROM jsonb_array_elements(value->'slots') item LOOP
    IF jsonb_typeof(slot_value)<>'object'
       OR (SELECT count(*)<>5 OR NOT bool_and(key=ANY(ARRAY['slot_id','interval_id','area_id','start_epoch_ms','end_epoch_ms'])) FROM jsonb_object_keys(slot_value) key)
       OR btrim(slot_value->>'slot_id')='' OR (slot_value->>'interval_id')::uuid IS NULL
       OR (slot_value->>'area_id')::uuid IS NULL OR jsonb_typeof(slot_value->'start_epoch_ms')<>'number'
       OR jsonb_typeof(slot_value->'end_epoch_ms')<>'number'
       OR (slot_value->>'end_epoch_ms')::numeric<=(slot_value->>'start_epoch_ms')::numeric THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*)<>count(DISTINCT item->>'slot_id') FROM jsonb_array_elements(value->'slots') item) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
$function$, target_schema);
END;
$migration$;

-- 0027's guard, unchanged except for the historical-slot branch in the slot loop.
CREATE OR REPLACE FUNCTION phase4_guard_schedule_job_input_references() RETURNS trigger AS $$
DECLARE competition_row competitions%ROWTYPE; match_value jsonb; slot_value jsonb; stored_match matches%ROWTYPE;
BEGIN
  SELECT * INTO competition_row FROM competitions WHERE id=NEW.competition_id FOR SHARE;
  IF competition_row.id IS NULL OR competition_row.organisation_id<>NEW.organisation_id
     OR (NEW.input_snapshot->>'capacity_revision')::bigint<>competition_row.capacity_revision
     OR NEW.input_snapshot->>'capacity_hash'<>phase4_capacity_hash(NEW.competition_id) THEN
    RAISE EXCEPTION 'schedule job capacity provenance is stale or invalid';
  END IF;
  FOR match_value IN SELECT item FROM jsonb_array_elements(NEW.input_snapshot->'matches') item LOOP
    SELECT * INTO stored_match FROM matches WHERE id=(match_value->>'match_id')::uuid;
    IF stored_match.id IS NULL OR stored_match.competition_id<>NEW.competition_id
       OR stored_match.division_id<>(match_value->>'division_id')::uuid
       OR NOT EXISTS (SELECT 1 FROM format_revisions fr WHERE fr.id=stored_match.format_revision_id AND fr.status='published')
       OR EXISTS (SELECT possible::uuid FROM jsonb_array_elements_text(match_value->'possible_entry_ids') possible
          EXCEPT SELECT entry_id FROM phase4_match_possible_entries(stored_match.id))
       OR EXISTS (SELECT entry_id FROM phase4_match_possible_entries(stored_match.id)
          EXCEPT SELECT possible::uuid FROM jsonb_array_elements_text(match_value->'possible_entry_ids') possible)
       OR EXISTS (SELECT dependency.source_match_id FROM phase4_match_schedule_dependencies(stored_match.id) dependency
          EXCEPT SELECT item::uuid FROM jsonb_array_elements_text(match_value->'dependency_match_ids') item)
       OR EXISTS (SELECT item::uuid FROM jsonb_array_elements_text(match_value->'dependency_match_ids') item
          EXCEPT SELECT dependency.source_match_id FROM phase4_match_schedule_dependencies(stored_match.id) dependency) THEN
      RAISE EXCEPTION 'schedule job match, division, participants, or dependencies are not authoritative';
    END IF;
  END LOOP;
  FOR slot_value IN SELECT item FROM jsonb_array_elements(NEW.input_snapshot->'slots') item LOOP
    IF slot_value->>'slot_id'='historical:' || (slot_value->>'interval_id') THEN
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.input_snapshot->'matches') fixed_match
        JOIN matches started ON started.id=(fixed_match->>'match_id')::uuid
        JOIN scheduled_matches placement ON placement.match_id=started.id
          AND placement.schedule_revision_id=(
            SELECT revision.id FROM schedule_revisions revision
            WHERE revision.competition_id=NEW.competition_id AND revision.status='published'
            ORDER BY revision.revision DESC,revision.id DESC LIMIT 1)
        WHERE fixed_match->>'match_id'=slot_value->>'interval_id'
          AND fixed_match->'fixed_assignment'->>'reason' IN ('started','finished')
          AND fixed_match->'fixed_assignment'->>'slot_id'=slot_value->>'slot_id'
          AND started.competition_id=NEW.competition_id
          AND started.state IN ('in_progress','final','corrected')
          AND placement.playing_area_id=(slot_value->>'area_id')::uuid
          AND placement.starts_at=to_timestamp((slot_value->>'start_epoch_ms')::double precision/1000)
          AND placement.ends_at=to_timestamp((slot_value->>'end_epoch_ms')::double precision/1000)
      ) THEN RAISE EXCEPTION 'schedule job historical slot is not a started or finished match''s published placement'; END IF;
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM competition_availability_windows availability_window
      JOIN playing_areas area ON area.id=availability_window.playing_area_id AND area.competition_id=availability_window.competition_id
      WHERE availability_window.id=(slot_value->>'interval_id')::uuid AND availability_window.competition_id=NEW.competition_id
        AND availability_window.playing_area_id=(slot_value->>'area_id')::uuid
        AND to_timestamp((slot_value->>'start_epoch_ms')::double precision/1000)>=availability_window.starts_at
        AND to_timestamp((slot_value->>'end_epoch_ms')::double precision/1000)<=availability_window.ends_at
        AND (slot_value->>'end_epoch_ms')::numeric-(slot_value->>'start_epoch_ms')::numeric=area.slot_minutes::numeric*60000
        AND NOT EXISTS (SELECT 1 FROM playing_area_unavailable_intervals unavailable
          WHERE unavailable.playing_area_id=area.id
            AND tstzrange(unavailable.starts_at,unavailable.ends_at,'[)') && tstzrange(
              to_timestamp((slot_value->>'start_epoch_ms')::double precision/1000),
              to_timestamp((slot_value->>'end_epoch_ms')::double precision/1000),'[)'))
    ) THEN RAISE EXCEPTION 'schedule job slot is outside authoritative capacity'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
