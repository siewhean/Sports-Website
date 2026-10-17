-- Additive court/day reserves (follow-up to redesign Phase 0; needs owner approval).
-- NULL preserves the original per-court policy. No backfill: existing and archived rows stay NULL.
-- The started/finished schedule-input reasons live in 0075, not here.
CREATE FUNCTION phase3_daily_reserves_valid(value jsonb) RETURNS boolean AS $$
DECLARE pair record;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value)<>'object' THEN RETURN false; END IF;
  FOR pair IN SELECT key,val FROM jsonb_each(value) AS item(key,val) LOOP
    IF pair.key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR to_char(pair.key::date,'YYYY-MM-DD')<>pair.key
       OR jsonb_typeof(pair.val)<>'number'
       OR (pair.val::text)::numeric<0
       OR (pair.val::text)::numeric>9007199254740991
       OR trunc((pair.val::text)::numeric)<>(pair.val::text)::numeric THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE playing_areas ADD COLUMN daily_reserve_slots jsonb
  CHECK (phase3_daily_reserves_valid(daily_reserve_slots));

-- Slots restart after each unavailable split, then use their competition-local
-- START date. Elapsed-time stepping matches domain DST and overnight semantics.
CREATE FUNCTION phase3_capacity_totals(target_competition uuid)
RETURNS TABLE(raw_slots integer,requested_reserves numeric,available_slots integer) AS $$
  WITH area_slots AS (
    SELECT a.id,a.fixed_reserve_slots,a.daily_reserve_slots,
      (slot.starts_at AT TIME ZONE COALESCE(c.capacity_timezone,c.timezone))::date::text AS local_date,
      slot.starts_at
    FROM playing_areas a JOIN competitions c ON c.id=a.competition_id
    LEFT JOIN LATERAL (
      SELECT generated AS starts_at
      FROM unnest(
        COALESCE((SELECT range_agg(tstzrange(w.starts_at,w.ends_at,'[)')) FROM competition_availability_windows w WHERE w.playing_area_id=a.id),'{}'::tstzmultirange)
        - COALESCE((SELECT range_agg(tstzrange(u.starts_at,u.ends_at,'[)')) FROM playing_area_unavailable_intervals u WHERE u.playing_area_id=a.id),'{}'::tstzmultirange)
      ) AS usable(slot)
      CROSS JOIN LATERAL generate_series(lower(usable.slot),upper(usable.slot)-make_interval(mins=>COALESCE(a.slot_minutes,30)),make_interval(mins=>COALESCE(a.slot_minutes,30))) generated
    ) slot ON true
    WHERE a.competition_id=target_competition
  ), grouped AS (
    SELECT id,fixed_reserve_slots,daily_reserve_slots,
      CASE WHEN daily_reserve_slots IS NULL THEN NULL ELSE local_date END AS reserve_date,
      count(starts_at)::integer AS slots
    FROM area_slots GROUP BY id,fixed_reserve_slots,daily_reserve_slots,
      CASE WHEN daily_reserve_slots IS NULL THEN NULL ELSE local_date END
  ), totals AS (
    SELECT COALESCE(sum(slots),0)::integer AS raw,
      COALESCE(sum(GREATEST(0,slots-CASE WHEN daily_reserve_slots IS NULL THEN fixed_reserve_slots::numeric
        ELSE COALESCE((daily_reserve_slots->>reserve_date)::numeric,0) END)),0)::integer AS available
    FROM grouped
  )
  SELECT raw,
    COALESCE((SELECT sum(CASE WHEN a.daily_reserve_slots IS NULL THEN a.fixed_reserve_slots::numeric
      ELSE COALESCE((SELECT sum((item.value::text)::numeric) FROM jsonb_each(a.daily_reserve_slots) item),0) END)
      FROM playing_areas a WHERE a.competition_id=target_competition),0),
    available FROM totals;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION phase3_available_match_slots(target_competition uuid) RETURNS integer AS $$
  SELECT available_slots FROM phase3_capacity_totals(target_competition);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION phase4_capacity_hash(target_competition uuid) RETURNS text AS $$
DECLARE material text;
BEGIN
  SELECT concat_ws('|',c.id,c.capacity_revision,COALESCE(c.capacity_timezone,c.timezone),
    COALESCE((SELECT string_agg(concat_ws(':',a.id,a.slot_minutes,a.fixed_reserve_slots,a.revision,a.updated_at,CASE WHEN a.daily_reserve_slots IS NOT NULL THEN a.daily_reserve_slots::text END),',' ORDER BY a.id)
      FROM playing_areas a WHERE a.competition_id=c.id),''),
    COALESCE((SELECT string_agg(concat_ws(':',w.id,w.playing_area_id,w.starts_at,w.ends_at,w.source_date,w.source_start_time,w.source_end_time,w.source_cross_midnight),',' ORDER BY w.id)
      FROM competition_availability_windows w WHERE w.competition_id=c.id),''),
    COALESCE((SELECT string_agg(concat_ws(':',u.id,u.playing_area_id,u.starts_at,u.ends_at,u.source_date,u.source_start_time,u.source_end_time,u.source_cross_midnight),',' ORDER BY u.id)
      FROM playing_area_unavailable_intervals u WHERE u.competition_id=c.id),''))
  INTO material FROM competitions c WHERE c.id=target_competition;
  IF material IS NULL THEN RETURN NULL; END IF;
  RETURN encode(pg_catalog.sha256(convert_to(material,'UTF8')),'hex');
END;
$$ LANGUAGE plpgsql STABLE;

-- Preserve the upgrade/recommendation-evidence wrappers introduced in 0017/0020.
CREATE OR REPLACE FUNCTION phase4_setup_seed_values_unchecked(target_competition uuid) RETURNS jsonb AS $$
DECLARE
  competition_row record;
  division_count_value integer;
  entry_count_value integer;
  basics_value jsonb;
  settings_value jsonb;
  entries_value jsonb;
  capacity_value jsonb;
  area_count_value integer;
  area_ids_value jsonb;
  minimum_slot_minutes integer;
  maximum_slot_minutes integer;
  recommended_slot_minutes integer;
  fixed_reserve_slots_value numeric;
  available_slots_value integer;
  required_slots_value integer;
  raw_slots_value integer;
  remaining_slots_value integer;
BEGIN
  SELECT c.id,c.name,c.sport_code,c.venue,c.address,c.locality,c.country_code,
         c.starts_on,c.ends_on,c.timezone,c.locale,c.capacity_revision,
         COALESCE((pack.definition->>'recommendedSlotMinutes')::integer,30) recommended_slot_minutes
  INTO competition_row
  FROM competitions c
  LEFT JOIN LATERAL (
    SELECT definition
    FROM sport_pack_versions
    WHERE sport_code=c.sport_code AND status='active'
    ORDER BY activated_at DESC NULLS LAST,created_at DESC,version DESC
    LIMIT 1
  ) pack ON true
  WHERE c.id=target_competition;
  IF competition_row.id IS NULL THEN RAISE EXCEPTION 'setup seed competition does not exist'; END IF;

  SELECT count(*)::integer INTO division_count_value FROM divisions WHERE competition_id=target_competition;
  SELECT count(*)::integer INTO entry_count_value
  FROM division_entries entry
  JOIN divisions division ON division.id=entry.division_id
  WHERE division.competition_id=target_competition AND entry.status IN ('confirmed','active');

  basics_value:=jsonb_build_object(
    'name',competition_row.name,
    'sport_code',competition_row.sport_code,
    'location',jsonb_build_object(
      'venue',competition_row.venue,
      'address',competition_row.address,
      'locality',competition_row.locality,
      'country_code',competition_row.country_code
    ),
    'starts_on',competition_row.starts_on::text,
    'ends_on',competition_row.ends_on::text,
    'time_zone',competition_row.timezone,
    'locale',competition_row.locale,
    'entry_count',entry_count_value,
    'division_count',division_count_value,
    'entry_count_status',CASE WHEN entry_count_value>0 THEN 'confirmed' ELSE 'estimated' END
  );

  SELECT COALESCE(jsonb_agg(reference ORDER BY sort_order,division_id NULLS FIRST),'[]'::jsonb)
  INTO settings_value
  FROM (
    SELECT 0 sort_order,NULL::uuid division_id,jsonb_build_object(
      'competition_id',settings.competition_id,
      'scope','competition',
      'division_id',NULL,
      'settings_revision',settings.revision,
      'mode',CASE WHEN settings.customised THEN 'customised' ELSE 'recommended' END,
      'pack_schema_version',pack.schema_version,
      'pack_version',pack.version,
      'pack_definition_hash',pack.definition_hash
    ) reference
    FROM competition_sport_settings settings
    JOIN sport_pack_versions pack
      ON pack.sport_code=settings.sport_code AND pack.version=settings.pack_version
    WHERE settings.competition_id=target_competition
    UNION ALL
    SELECT 1,settings.division_id,jsonb_build_object(
      'competition_id',settings.competition_id,
      'scope','division',
      'division_id',settings.division_id,
      'settings_revision',settings.revision,
      'mode',CASE WHEN settings.settings_override='{}'::jsonb THEN 'recommended' ELSE 'customised' END,
      'pack_schema_version',pack.schema_version,
      'pack_version',pack.version,
      'pack_definition_hash',pack.definition_hash
    ) reference
    FROM division_sport_settings settings
    JOIN sport_pack_versions pack
      ON pack.sport_code=settings.sport_code AND pack.version=settings.pack_version
    WHERE settings.competition_id=target_competition
  ) setting_references;

  SELECT CASE WHEN division_count_value=0 THEN NULL ELSE jsonb_build_object(
    'competition_id',target_competition,
    'divisions',COALESCE(jsonb_agg(division_value ORDER BY division_id),'[]'::jsonb),
    'imports','[]'::jsonb,
    'total_entry_count',entry_count_value
  ) END
  INTO entries_value
  FROM (
    SELECT division.id division_id,jsonb_build_object(
      'division_id',division.id,
      'division_revision',division.revision,
      'entry_ids',COALESCE(jsonb_agg(entry.id ORDER BY entry.id)
        FILTER (WHERE entry.id IS NOT NULL AND entry.status IN ('confirmed','active')),'[]'::jsonb),
      'confirmed_count',count(entry.id) FILTER (WHERE entry.status IN ('confirmed','active')),
      'placeholder_count',count(entry.id) FILTER (
        WHERE entry.status IN ('confirmed','active') AND entry.entry_type='placeholder'
      )
    ) division_value
    FROM divisions division
    LEFT JOIN division_entries entry ON entry.division_id=division.id
    WHERE division.competition_id=target_competition
    GROUP BY division.id,division.revision
  ) divisions;

  recommended_slot_minutes:=competition_row.recommended_slot_minutes;
  SELECT count(*)::integer,
         COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb),
         min(COALESCE(slot_minutes,recommended_slot_minutes)),
         max(COALESCE(slot_minutes,recommended_slot_minutes)),
         COALESCE(sum(fixed_reserve_slots),0)::integer
  INTO area_count_value,area_ids_value,minimum_slot_minutes,maximum_slot_minutes,fixed_reserve_slots_value
  FROM playing_areas WHERE competition_id=target_competition;

  SELECT COALESCE(sum(jsonb_array_length(latest.definition->'matches')),0)::integer
  INTO required_slots_value
  FROM (
    SELECT DISTINCT ON (division_id) division_id,definition
    FROM format_revisions
    WHERE competition_id=target_competition
    ORDER BY division_id,revision DESC
  ) latest;

  IF area_count_value>0 AND minimum_slot_minutes=maximum_slot_minutes THEN
    SELECT raw_slots,requested_reserves,available_slots
    INTO raw_slots_value,fixed_reserve_slots_value,available_slots_value
    FROM phase3_capacity_totals(target_competition);
    remaining_slots_value:=available_slots_value-required_slots_value;
    capacity_value:=jsonb_build_object(
      'kind','phase3_capacity_revision',
      'competition_id',target_competition,
      'revision',competition_row.capacity_revision,
      'time_zone',competition_row.timezone,
      'area_ids',area_ids_value,
      'source_hash',phase4_capacity_hash(target_competition),
      'effective',jsonb_build_object(
        'slotMinutes',minimum_slot_minutes,
        'rawTotalSlots',raw_slots_value,
        'fixedReserveSlots',fixed_reserve_slots_value,
        'availableMatchSlots',available_slots_value,
        'requiredMatchSlots',required_slots_value,
        'remainingMatchSlots',remaining_slots_value,
        'status',CASE
          WHEN remaining_slots_value<0 THEN 'does_not_fit'
          WHEN remaining_slots_value<=0 THEN 'tight'
          ELSE 'comfortable'
        END
      )
    );
  ELSE
    capacity_value:=NULL;
  END IF;

  RETURN jsonb_build_object(
    'basics',basics_value,
    'capacity',capacity_value,
    'settings',CASE WHEN jsonb_array_length(settings_value)>0 THEN settings_value ELSE NULL END,
    'entries',entries_value,
    'format_preferences',NULL,
    'format_recommendations',NULL,
    'schedule_review',NULL,
    'review_publish',NULL
  );
END;
$$ LANGUAGE plpgsql STABLE;

