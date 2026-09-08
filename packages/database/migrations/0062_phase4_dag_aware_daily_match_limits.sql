-- Migration 0062: Phase 4 DAG-aware daily match limit in schedule assignment validation

CREATE OR REPLACE FUNCTION phase4_max_entry_matches_for_day(
  snapshot jsonb,
  assignments_value jsonb,
  target_entry_id text,
  target_day text
) RETURNS integer AS $$
DECLARE
  def_count integer := 0;
  adv_count integer := 0;
  max_chain integer := 0;
BEGIN
  -- Count definite matches (possible_entry_ids has exactly 2 entries) on target_day
  SELECT count(*) INTO def_count
  FROM jsonb_array_elements(assignments_value) a
  JOIN jsonb_array_elements(snapshot->'matches') m ON m->>'match_id' = a->>'match_id'
  WHERE to_char(to_timestamp((a->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'),'YYYY-MM-DD') = target_day
    AND jsonb_array_length(m->'possible_entry_ids') = 2
    AND m->'possible_entry_ids' ? target_entry_id;

  -- Advancement matches (possible_entry_ids > 2) on target_day
  SELECT count(*) INTO adv_count
  FROM jsonb_array_elements(assignments_value) a
  JOIN jsonb_array_elements(snapshot->'matches') m ON m->>'match_id' = a->>'match_id'
  WHERE to_char(to_timestamp((a->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'),'YYYY-MM-DD') = target_day
    AND jsonb_array_length(m->'possible_entry_ids') > 2
    AND m->'possible_entry_ids' ? target_entry_id;

  IF adv_count = 0 THEN
    RETURN def_count;
  END IF;

  -- Longest dependency chain among advancement matches on target_day
  WITH RECURSIVE day_adv AS (
    SELECT m->>'match_id' AS match_id, m->'dependency_match_ids' AS dep_ids
    FROM jsonb_array_elements(assignments_value) a
    JOIN jsonb_array_elements(snapshot->'matches') m ON m->>'match_id' = a->>'match_id'
    WHERE to_char(to_timestamp((a->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'),'YYYY-MM-DD') = target_day
      AND jsonb_array_length(m->'possible_entry_ids') > 2
      AND m->'possible_entry_ids' ? target_entry_id
  ),
  chains(match_id, depth) AS (
    SELECT match_id, 1
    FROM day_adv
    UNION ALL
    SELECT da.match_id, c.depth + 1
    FROM day_adv da
    JOIN chains c ON da.dep_ids ? c.match_id
  )
  SELECT COALESCE(max(depth), 0) INTO max_chain FROM chains;

  RETURN def_count + max_chain;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION phase4_schedule_assignments_valid(snapshot jsonb,assignments_value jsonb) RETURNS boolean AS $$
DECLARE assignment jsonb; match_value jsonb; fixed_value jsonb; required_rest numeric:=0;
DECLARE required_max_per_day integer; constraint_value jsonb; balance_spread integer; threshold_minutes integer;
BEGIN
  IF jsonb_typeof(assignments_value)<>'array'
     OR jsonb_array_length(assignments_value)<>jsonb_array_length(snapshot->'matches')
     OR (SELECT count(*)<>count(DISTINCT item->>'match_id') FROM jsonb_array_elements(assignments_value) item)
     OR (SELECT count(*)<>count(DISTINCT item->>'slot_id') FROM jsonb_array_elements(assignments_value) item) THEN RETURN false; END IF;
  FOR assignment IN SELECT item FROM jsonb_array_elements(assignments_value) item LOOP
    IF NOT phase4_json_exact_keys(assignment,ARRAY['match_id','division_id','area_id','interval_id','slot_id','start_epoch_ms','end_epoch_ms','fixed'])
       OR jsonb_typeof(assignment->'fixed')<>'boolean'
       OR NOT phase4_json_nonnegative_integer(assignment->'start_epoch_ms')
       OR NOT phase4_json_nonnegative_integer(assignment->'end_epoch_ms')
       OR (assignment->>'end_epoch_ms')::numeric<=(assignment->>'start_epoch_ms')::numeric THEN RETURN false; END IF;
    SELECT item INTO match_value FROM jsonb_array_elements(snapshot->'matches') item
      WHERE item->>'match_id'=assignment->>'match_id';
    IF match_value IS NULL OR match_value->>'division_id'<>assignment->>'division_id'
       OR (assignment->>'end_epoch_ms')::numeric-(assignment->>'start_epoch_ms')::numeric
         <>(match_value->>'duration_minutes')::numeric*60000
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot->'slots') slot
         WHERE slot->>'slot_id'=assignment->>'slot_id' AND slot->>'interval_id'=assignment->>'interval_id'
           AND slot->>'area_id'=assignment->>'area_id' AND slot->'start_epoch_ms'=assignment->'start_epoch_ms'
           AND slot->'end_epoch_ms'=assignment->'end_epoch_ms') THEN RETURN false; END IF;
    fixed_value:=match_value->'fixed_assignment';
    IF fixed_value IS NOT NULL AND (assignment->'fixed'<>'true'::jsonb OR assignment->>'area_id'<>fixed_value->>'area_id'
       OR assignment->>'slot_id'<>fixed_value->>'slot_id' OR assignment->'start_epoch_ms'<>fixed_value->'start_epoch_ms'
       OR assignment->'end_epoch_ms'<>fixed_value->'end_epoch_ms') THEN RETURN false;
    ELSIF fixed_value IS NULL AND assignment->'fixed'<>'false'::jsonb THEN RETURN false; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(assignments_value) a, jsonb_array_elements(assignments_value) b
    WHERE a->>'match_id'<b->>'match_id' AND a->>'area_id'=b->>'area_id'
      AND (a->>'start_epoch_ms')::numeric<(b->>'end_epoch_ms')::numeric
      AND (b->>'start_epoch_ms')::numeric<(a->>'end_epoch_ms')::numeric
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') dependent,
      jsonb_array_elements_text(dependent->'dependency_match_ids') source_id,
      jsonb_array_elements(assignments_value) dependent_assignment,
      jsonb_array_elements(assignments_value) source_assignment
    WHERE dependent_assignment->>'match_id'=dependent->>'match_id' AND source_assignment->>'match_id'=source_id
      AND (source_assignment->>'end_epoch_ms')::numeric>(dependent_assignment->>'start_epoch_ms')::numeric
  ) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') m1,jsonb_array_elements(snapshot->'matches') m2,
      jsonb_array_elements(assignments_value) a1,jsonb_array_elements(assignments_value) a2
    WHERE m1->>'match_id'<m2->>'match_id' AND a1->>'match_id'=m1->>'match_id' AND a2->>'match_id'=m2->>'match_id'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m1->'official_ids') o1
        JOIN jsonb_array_elements_text(m2->'official_ids') o2 ON o2=o1)
      AND (a1->>'start_epoch_ms')::numeric<(a2->>'end_epoch_ms')::numeric
      AND (a2->>'start_epoch_ms')::numeric<(a1->>'end_epoch_ms')::numeric
  ) THEN RETURN false; END IF;
  IF snapshot->'constraints'->'minimum_rest'->>'mode'='required' THEN
    required_rest:=GREATEST(required_rest,(snapshot->'constraints'->'minimum_rest'->'value'->>'minutes')::numeric);
  END IF;
  IF snapshot->'constraints'->'avoid_consecutive_matches'->>'mode'='required' THEN
    required_rest:=GREATEST(required_rest,(snapshot->'constraints'->'avoid_consecutive_matches'->'value'->>'minutes')::numeric);
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') m1,jsonb_array_elements(snapshot->'matches') m2,
      jsonb_array_elements(assignments_value) a1,jsonb_array_elements(assignments_value) a2
    WHERE m1->>'match_id'<m2->>'match_id' AND a1->>'match_id'=m1->>'match_id' AND a2->>'match_id'=m2->>'match_id'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m1->'possible_entry_ids') e1
        JOIN jsonb_array_elements_text(m2->'possible_entry_ids') e2 ON e2=e1)
      AND ((a1->>'start_epoch_ms')::numeric<(a2->>'end_epoch_ms')::numeric
        AND (a2->>'start_epoch_ms')::numeric<(a1->>'end_epoch_ms')::numeric
        OR GREATEST((a1->>'start_epoch_ms')::numeric,(a2->>'start_epoch_ms')::numeric)
          -LEAST((a1->>'end_epoch_ms')::numeric,(a2->>'end_epoch_ms')::numeric)<required_rest*60000)
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'entry_unavailable';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') match_item,jsonb_array_elements(assignments_value) assigned,
      jsonb_array_elements_text(match_item->'possible_entry_ids') entry_id,
      jsonb_array_elements(constraint_value->'value'->'by_entry_id'->entry_id) blocked
    WHERE assigned->>'match_id'=match_item->>'match_id'
      AND (assigned->>'start_epoch_ms')::numeric<(blocked->>'end_epoch_ms')::numeric
      AND (blocked->>'start_epoch_ms')::numeric<(assigned->>'end_epoch_ms')::numeric
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'official_availability';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') match_item,jsonb_array_elements(assignments_value) assigned,
      jsonb_array_elements_text(match_item->'official_ids') official_id
    WHERE assigned->>'match_id'=match_item->>'match_id' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(constraint_value->'value'->'by_official_id'->official_id) available
      WHERE (available->>'start_epoch_ms')::numeric<=(assigned->>'start_epoch_ms')::numeric
        AND (available->>'end_epoch_ms')::numeric>=(assigned->>'end_epoch_ms')::numeric)
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'featured_playing_area';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(constraint_value->'value'->'match_ids') featured,
      jsonb_array_elements(assignments_value) assigned
    WHERE assigned->>'match_id'=featured AND assigned->>'area_id'<>constraint_value->'value'->>'area_id'
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'preferred_final_time';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') match_item,jsonb_array_elements(assignments_value) assigned
    WHERE assigned->>'match_id'=match_item->>'match_id' AND match_item->'is_championship_final'='true'::jsonb
      AND abs((assigned->>'start_epoch_ms')::numeric-(constraint_value->'value'->>'target_start_epoch_ms')::numeric)
        >(constraint_value->'value'->>'tolerance_minutes')::numeric*60000
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'preserve_existing_schedule';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_each(constraint_value->'value'->'by_match_id') preserved(match_id,original),
      jsonb_array_elements(assignments_value) assigned
    WHERE assigned->>'match_id'=preserved.match_id AND (assigned->>'area_id'<>preserved.original->>'area_id'
      OR abs((assigned->>'start_epoch_ms')::numeric-(preserved.original->>'start_epoch_ms')::numeric)
        >(constraint_value->'value'->>'maximum_shift_minutes')::numeric*60000)
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'maximum_matches_per_day';
  IF constraint_value->>'mode'='required' THEN
    required_max_per_day:=(constraint_value->'value'->>'matches')::integer;
    IF EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT
          entry_id,
          to_char(to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'),'YYYY-MM-DD') as day
        FROM jsonb_array_elements(assignments_value) assigned
        JOIN jsonb_array_elements(snapshot->'matches') snapshot_match ON snapshot_match->>'match_id'=assigned->>'match_id'
        CROSS JOIN LATERAL jsonb_array_elements_text(snapshot_match->'possible_entry_ids') entry_id
      ) entry_days
      WHERE phase4_max_entry_matches_for_day(snapshot, assignments_value, entry_days.entry_id, entry_days.day) > required_max_per_day
    ) THEN RETURN false; END IF;
  END IF;
  constraint_value:=snapshot->'constraints'->'keep_division_together';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(assignments_value) assigned
    GROUP BY assigned->>'division_id'
    HAVING count(DISTINCT assigned->>'area_id')>(constraint_value->'value'->>'maximum_area_count')::integer
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'balance_early_matches';
  IF constraint_value->>'mode'='required' THEN
    threshold_minutes:=split_part(constraint_value->'value'->>'before_local_time',':',1)::integer*60
      +split_part(constraint_value->'value'->>'before_local_time',':',2)::integer;
    SELECT COALESCE(max(match_count)-min(match_count),0)::integer INTO balance_spread FROM (
      SELECT entry_id,count(assigned->>'match_id') FILTER (WHERE
        extract(hour FROM to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'))*60
        +extract(minute FROM to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'))<threshold_minutes) match_count
      FROM (SELECT DISTINCT entry_id FROM jsonb_array_elements(snapshot->'matches') source_match
        CROSS JOIN LATERAL jsonb_array_elements_text(source_match->'possible_entry_ids') entry_id) entries
      LEFT JOIN jsonb_array_elements(snapshot->'matches') source_match
        ON EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_match->'possible_entry_ids') possible WHERE possible=entries.entry_id)
      LEFT JOIN jsonb_array_elements(assignments_value) assigned ON assigned->>'match_id'=source_match->>'match_id'
      GROUP BY entry_id
    ) early_counts;
    IF balance_spread>1 THEN RETURN false; END IF;
  END IF;
  constraint_value:=snapshot->'constraints'->'balance_late_matches';
  IF constraint_value->>'mode'='required' THEN
    threshold_minutes:=split_part(constraint_value->'value'->>'at_or_after_local_time',':',1)::integer*60
      +split_part(constraint_value->'value'->>'at_or_after_local_time',':',2)::integer;
    SELECT COALESCE(max(match_count)-min(match_count),0)::integer INTO balance_spread FROM (
      SELECT entry_id,count(assigned->>'match_id') FILTER (WHERE
        extract(hour FROM to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'))*60
        +extract(minute FROM to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'))>=threshold_minutes) match_count
      FROM (SELECT DISTINCT entry_id FROM jsonb_array_elements(snapshot->'matches') source_match
        CROSS JOIN LATERAL jsonb_array_elements_text(source_match->'possible_entry_ids') entry_id) entries
      LEFT JOIN jsonb_array_elements(snapshot->'matches') source_match
        ON EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_match->'possible_entry_ids') possible WHERE possible=entries.entry_id)
      LEFT JOIN jsonb_array_elements(assignments_value) assigned ON assigned->>'match_id'=source_match->>'match_id'
      GROUP BY entry_id
    ) late_counts;
    IF balance_spread>1 THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
