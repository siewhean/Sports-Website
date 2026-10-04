-- pg_restore evaluates CHECK expressions with a restricted search_path.
-- Repair schedule-input validators in the schema selected by the migration runner,
-- preserving the historical bodies except for schema-qualified helper lookups.
DO $migration$
DECLARE
  target_schema text := current_schema();
BEGIN
  EXECUTE format($function$
CREATE OR REPLACE FUNCTION %1$I.phase4_schedule_intervals_valid(value jsonb) RETURNS boolean AS $$
BEGIN
  RETURN jsonb_typeof(value)='array' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(value) interval_value
    WHERE NOT %1$I.phase4_json_exact_keys(interval_value,ARRAY['start_epoch_ms','end_epoch_ms'])
      OR NOT %1$I.phase4_json_nonnegative_integer(interval_value->'start_epoch_ms')
      OR NOT %1$I.phase4_json_nonnegative_integer(interval_value->'end_epoch_ms')
      OR (interval_value->>'end_epoch_ms')::numeric<=(interval_value->>'start_epoch_ms')::numeric);
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
$function$, target_schema);

  EXECUTE format($function$
CREATE OR REPLACE FUNCTION %1$I.phase4_schedule_constraint_value_valid(constraint_key text,value jsonb) RETURNS boolean AS $$
DECLARE item record;
BEGIN
  IF constraint_key IN ('minimum_rest','avoid_consecutive_matches') THEN
    RETURN %1$I.phase4_json_exact_keys(value,ARRAY['minutes']) AND %1$I.phase4_json_nonnegative_integer(value->'minutes');
  ELSIF constraint_key='maximum_matches_per_day' THEN
    RETURN %1$I.phase4_json_exact_keys(value,ARRAY['matches']) AND %1$I.phase3_json_positive_integer(value->'matches');
  ELSIF constraint_key='preferred_final_time' THEN
    RETURN %1$I.phase4_json_exact_keys(value,ARRAY['target_start_epoch_ms','tolerance_minutes'])
      AND %1$I.phase4_json_nonnegative_integer(value->'target_start_epoch_ms') AND %1$I.phase4_json_nonnegative_integer(value->'tolerance_minutes');
  ELSIF constraint_key IN ('entry_unavailable','official_availability') THEN
    IF NOT %1$I.phase4_json_exact_keys(value,ARRAY[CASE WHEN constraint_key='entry_unavailable' THEN 'by_entry_id' ELSE 'by_official_id' END]) THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_each(value->(CASE WHEN constraint_key='entry_unavailable' THEN 'by_entry_id' ELSE 'by_official_id' END)) LOOP
      IF item.key::uuid IS NULL OR NOT %1$I.phase4_schedule_intervals_valid(item.value) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  ELSIF constraint_key='featured_playing_area' THEN
    RETURN %1$I.phase4_json_exact_keys(value,ARRAY['area_id','match_ids']) AND (value->>'area_id')::uuid IS NOT NULL
      AND jsonb_typeof(value->'match_ids')='array'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(value->'match_ids') match_item(value) WHERE match_item.value::uuid IS NULL)
      AND (SELECT count(*)=count(DISTINCT match_item.value) FROM jsonb_array_elements_text(value->'match_ids') match_item(value));
  ELSIF constraint_key='balance_early_matches' THEN
    RETURN %1$I.phase4_json_exact_keys(value,ARRAY['before_local_time']) AND value->>'before_local_time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  ELSIF constraint_key='balance_late_matches' THEN
    RETURN %1$I.phase4_json_exact_keys(value,ARRAY['at_or_after_local_time']) AND value->>'at_or_after_local_time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  ELSIF constraint_key='keep_division_together' THEN
    RETURN %1$I.phase4_json_exact_keys(value,ARRAY['maximum_area_count']) AND %1$I.phase3_json_positive_integer(value->'maximum_area_count');
  ELSIF constraint_key='preserve_existing_schedule' THEN
    IF NOT %1$I.phase4_json_exact_keys(value,ARRAY['maximum_shift_minutes','by_match_id'])
       OR NOT %1$I.phase4_json_nonnegative_integer(value->'maximum_shift_minutes') OR jsonb_typeof(value->'by_match_id')<>'object' THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_each(value->'by_match_id') LOOP
      IF item.key::uuid IS NULL OR NOT %1$I.phase4_json_exact_keys(item.value,ARRAY['area_id','start_epoch_ms'])
         OR (item.value->>'area_id')::uuid IS NULL OR NOT %1$I.phase4_json_nonnegative_integer(item.value->'start_epoch_ms') THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
$function$, target_schema);

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
         OR match_value->'fixed_assignment'->>'reason' NOT IN ('locked','published_history')
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
