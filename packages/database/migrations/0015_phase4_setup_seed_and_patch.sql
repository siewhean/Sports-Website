-- Phase 4 Assisted Setup must be usable on the first production load and must
-- keep non-navigating autosaves distinct from save-and-advance transitions.

CREATE FUNCTION phase4_setup_seed_values(target_competition uuid) RETURNS jsonb AS $$
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
  fixed_reserve_slots_value integer;
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
  ) references;

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
    available_slots_value:=phase3_available_match_slots(target_competition);
    raw_slots_value:=available_slots_value+fixed_reserve_slots_value;
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

CREATE FUNCTION phase4_seed_setup_draft() RETURNS trigger AS $$
BEGIN
  IF NEW.steps='{}'::jsonb OR NEW.steps->'basics' IS NULL THEN
    NEW.steps:=phase4_setup_seed_values(NEW.competition_id)||COALESCE(NEW.steps,'{}'::jsonb);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER aa_setup_drafts_phase4_seed
BEFORE INSERT ON setup_drafts
FOR EACH ROW EXECUTE FUNCTION phase4_seed_setup_draft();

-- Repair already-created empty drafts without rewriting valid organiser input.
UPDATE setup_drafts draft
SET revision=draft.revision+1,
    steps=phase4_setup_seed_values(draft.competition_id)||draft.steps,
    updated_at=clock_timestamp()
WHERE draft.steps='{}'::jsonb OR draft.steps->'basics' IS NULL;

CREATE FUNCTION phase4_patch_setup_draft(target_organisation uuid,target_competition uuid,actor uuid,
  expected_revision integer,step_id_value text,next_steps jsonb,next_completed_steps jsonb,next_validation jsonb,
  idempotency_value text,request_id_value text) RETURNS jsonb AS $$
DECLARE
  receipt phase4_mutation_receipts%ROWTYPE;
  draft setup_drafts%ROWTYPE;
  request_document jsonb;
  request_hash_value text;
  response_value jsonb;
BEGIN
  request_document:=jsonb_build_object(
    'competition_id',target_competition,
    'expected_revision',expected_revision,
    'step_id',step_id_value,
    'steps',next_steps,
    'completed_steps',next_completed_steps,
    'validation',next_validation
  );
  request_hash_value:=phase4_sha256_json(request_document);
  PERFORM pg_advisory_xact_lock(hashtextextended('phase4-receipt:'||idempotency_value,0));
  SELECT * INTO receipt FROM phase4_mutation_receipts
  WHERE organisation_id=target_organisation AND idempotency_key=idempotency_value;
  IF receipt.id IS NOT NULL THEN
    IF receipt.operation<>'setup.patch' OR receipt.request_hash<>request_hash_value THEN
      RAISE EXCEPTION 'idempotency key was reused with a different setup patch';
    END IF;
    RETURN receipt.response;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organisation_memberships
    WHERE organisation_id=target_organisation AND account_id=actor
      AND status='active' AND role IN ('owner','organiser')
  ) THEN RAISE EXCEPTION 'setup patch requires organiser permission'; END IF;
  SELECT * INTO draft FROM setup_drafts WHERE competition_id=target_competition FOR UPDATE;
  IF draft.id IS NULL OR draft.organisation_id<>target_organisation THEN
    RAISE EXCEPTION 'setup draft does not exist in organisation';
  END IF;
  IF draft.status<>'active' THEN RAISE EXCEPTION 'completed or expired setup drafts are immutable'; END IF;
  IF draft.revision<>expected_revision THEN RAISE EXCEPTION 'setup draft revision conflict'; END IF;
  UPDATE setup_drafts
  SET revision=revision+1,
      completed_steps=next_completed_steps,
      steps=next_steps,
      validation=next_validation,
      updated_by=actor,
      updated_at=clock_timestamp()
  WHERE id=draft.id
  RETURNING * INTO draft;
  response_value:=to_jsonb(draft);
  INSERT INTO phase4_mutation_receipts(organisation_id,idempotency_key,operation,request_hash,response)
  VALUES(target_organisation,idempotency_value,'setup.patch',request_hash_value,response_value);
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(request_id_value,actor,'account',target_organisation,'setup.patched','setup_draft',draft.id::text,
    jsonb_build_object('revision',draft.revision,'current_step',draft.current_step,'step_id',step_id_value));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('setup_draft',draft.id::text,'setup.patched',
    jsonb_build_object('competition_id',draft.competition_id,'revision',draft.revision,'step_id',step_id_value),
    'phase4:setup-patch:'||target_organisation::text||':'||idempotency_value);
  RETURN response_value;
END;
$$ LANGUAGE plpgsql;
