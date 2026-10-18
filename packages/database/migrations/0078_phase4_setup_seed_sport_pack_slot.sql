-- Migration 0078: Setup seed values use configured competition sport pack slot length
--
-- Preserves daily reserve slot logic from 0076 and wrappers from 0017 / 0020.
-- Reads recommended slot minutes from effective competition sport settings:
--   1. competition_sport_settings.settings_override->>'slotMinutes' (organiser override)
--   2. competition_sport_settings.recommended_snapshot->>'slotMinutes' (pack recommended)
--   3. sport_pack_versions.definition->>'recommendedSlotMinutes' (pinned pack definition)
--   4. Fallback default: 30 minutes
-- Guards all integer casts with regex check against non-numeric or corrupt payloads.

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
         COALESCE(
           CASE WHEN (css.settings_override->>'slotMinutes') ~ '^[0-9]+$' THEN (css.settings_override->>'slotMinutes')::integer END,
           CASE WHEN (css.recommended_snapshot->>'slotMinutes') ~ '^[0-9]+$' THEN (css.recommended_snapshot->>'slotMinutes')::integer END,
           CASE WHEN (pack.definition->>'recommendedSlotMinutes') ~ '^[0-9]+$' THEN (pack.definition->>'recommendedSlotMinutes')::integer END,
           30
         ) recommended_slot_minutes
  INTO competition_row
  FROM competitions c
  LEFT JOIN competition_sport_settings css ON css.competition_id = c.id
  LEFT JOIN LATERAL (
    SELECT definition
    FROM sport_pack_versions
    WHERE sport_code=c.sport_code
      AND (
        (css.pack_version IS NOT NULL AND version = css.pack_version)
        OR (css.pack_version IS NULL AND status = 'active')
      )
    ORDER BY CASE WHEN css.pack_version IS NOT NULL AND version = css.pack_version THEN 0 ELSE 1 END,
             activated_at DESC NULLS LAST, created_at DESC, version DESC
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
