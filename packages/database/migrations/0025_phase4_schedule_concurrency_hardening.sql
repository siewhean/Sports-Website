-- Gate B merge-readiness: serialize accepted schedule revision allocation and
-- keep assignment-lock state and outbox evidence consistent across revisions.

CREATE OR REPLACE FUNCTION phase4_set_schedule_assignment_lock(target_competition uuid,target_match uuid,target_revision uuid,
  target_area uuid,start_value timestamptz,end_value timestamptz,actor uuid,request_id_value text)
RETURNS schedule_assignment_locks AS $$
DECLARE lock_row schedule_assignment_locks%ROWTYPE; target_org uuid; outbox_key text;
BEGIN
  PERFORM phase3_assert_competition_mutable(target_competition);
  SELECT organisation_id INTO target_org FROM competitions WHERE id=target_competition FOR UPDATE;
  IF end_value<=start_value OR NOT EXISTS (SELECT 1 FROM matches WHERE id=target_match AND competition_id=target_competition)
     OR NOT EXISTS (SELECT 1 FROM playing_areas WHERE id=target_area AND competition_id=target_competition)
     OR (target_revision IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM schedule_revisions
         WHERE id=target_revision AND competition_id=target_competition AND status IN ('draft','ready_for_review'))
       OR NOT EXISTS (SELECT 1 FROM scheduled_matches assignment
         WHERE assignment.schedule_revision_id=target_revision
           AND assignment.match_id=target_match
           AND assignment.competition_id=target_competition
           AND assignment.playing_area_id=target_area
           AND assignment.starts_at=start_value
           AND assignment.ends_at=end_value)
     )) THEN
    RAISE EXCEPTION 'schedule assignment lock provenance is invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM schedule_assignment_locks existing
    WHERE existing.competition_id=target_competition
      AND existing.match_id<>target_match
      AND existing.playing_area_id=target_area
      AND tstzrange(existing.starts_at,existing.ends_at,'[)') && tstzrange(start_value,end_value,'[)')
  ) THEN
    RAISE EXCEPTION 'schedule assignment lock conflicts with an existing locked interval';
  END IF;
  PERFORM set_config('matchday.phase4_schedule_lock','on',true);
  INSERT INTO schedule_assignment_locks(competition_id,organisation_id,match_id,source_schedule_revision_id,playing_area_id,starts_at,ends_at,locked_by)
  VALUES(target_competition,target_org,target_match,target_revision,target_area,start_value,end_value,actor)
  ON CONFLICT(competition_id,match_id) DO UPDATE SET source_schedule_revision_id=excluded.source_schedule_revision_id,
    playing_area_id=excluded.playing_area_id,starts_at=excluded.starts_at,ends_at=excluded.ends_at,locked_by=excluded.locked_by,created_at=now()
  RETURNING * INTO lock_row;
  PERFORM set_config('matchday.phase4_schedule_lock','off',true);
  outbox_key:='phase4:schedule-lock:'||target_match::text||':'||phase4_sha256_json(jsonb_build_object(
    'source_schedule_revision_id',target_revision,'area_id',target_area,
    'starts_at_epoch',extract(epoch FROM start_value),'ends_at_epoch',extract(epoch FROM end_value)
  ));
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(request_id_value,actor,'account',target_org,'schedule.assignment.locked','match',target_match::text,
    jsonb_build_object('source_schedule_revision_id',target_revision,'area_id',target_area,'starts_at',start_value,'ends_at',end_value));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('match',target_match::text,'schedule.assignment.locked',jsonb_build_object(
    'competition_id',target_competition,'source_schedule_revision_id',target_revision,
    'area_id',target_area,'starts_at',start_value,'ends_at',end_value
  ),outbox_key)
  ON CONFLICT(idempotency_key) DO NOTHING;
  RETURN lock_row;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase4_accept_schedule_option(target_option uuid,actor uuid,request_id_value text)
RETURNS schedule_revisions AS $$
DECLARE option_row schedule_generation_options%ROWTYPE; job schedule_generation_jobs%ROWTYPE;
DECLARE revision_row schedule_revisions%ROWTYPE; assignment jsonb; next_revision integer;
BEGIN
  SELECT * INTO option_row FROM schedule_generation_options WHERE id=target_option FOR UPDATE;
  IF option_row.id IS NULL OR option_row.result_status<>'valid' THEN RAISE EXCEPTION 'only a valid generated option can be accepted'; END IF;
  SELECT * INTO job FROM schedule_generation_jobs WHERE id=option_row.job_id FOR UPDATE;
  IF job.id IS NULL OR job.current_best_option_id<>option_row.id OR job.status NOT IN ('valid_best_found','completed') THEN
    RAISE EXCEPTION 'schedule option is not the current accepted candidate';
  END IF;
  IF (option_row.quality->>'required_violation_count')::numeric<>0 OR NOT phase4_schedule_preferred_violations_valid(option_row.violations)
     OR NOT phase4_schedule_assignments_valid(job.input_snapshot,option_row.assignments) THEN
    RAISE EXCEPTION 'schedule option no longer satisfies the authoritative job snapshot';
  END IF;
  IF EXISTS (SELECT 1 FROM schedule_revisions WHERE source_option_id=option_row.id) THEN
    SELECT * INTO revision_row FROM schedule_revisions WHERE source_option_id=option_row.id; RETURN revision_row;
  END IF;
  -- Different completed jobs can be accepted concurrently. Lock the aggregate
  -- before allocating its monotonic revision instead of relying on a unique-key
  -- failure after two transactions observe the same maximum.
  PERFORM 1 FROM competitions WHERE id=job.competition_id FOR UPDATE;
  SELECT COALESCE(max(revision),0)+1 INTO next_revision FROM schedule_revisions WHERE competition_id=job.competition_id;
  INSERT INTO schedule_revisions(competition_id,format_revision_id,revision,input_hash,status,created_by,source_job_id,source_option_id,quality)
  VALUES(job.competition_id,(SELECT match_row.format_revision_id FROM matches match_row
    WHERE match_row.id IN (SELECT (item->>'match_id')::uuid FROM jsonb_array_elements(option_row.assignments) item) LIMIT 1),
    next_revision,job.input_hash,'draft',actor,job.id,option_row.id,option_row.quality)
  RETURNING * INTO revision_row;
  INSERT INTO schedule_revision_formats(schedule_revision_id,competition_id,division_id,format_revision_id)
  SELECT DISTINCT revision_row.id,job.competition_id,match_row.division_id,match_row.format_revision_id
  FROM matches match_row WHERE match_row.id IN (SELECT (item->>'match_id')::uuid FROM jsonb_array_elements(option_row.assignments) item);
  FOR assignment IN SELECT item FROM jsonb_array_elements(option_row.assignments) item LOOP
    IF NOT phase4_json_exact_keys(assignment,ARRAY['match_id','division_id','area_id','interval_id','slot_id','start_epoch_ms','end_epoch_ms','fixed'])
       OR NOT phase4_json_nonnegative_integer(assignment->'start_epoch_ms') OR NOT phase4_json_nonnegative_integer(assignment->'end_epoch_ms')
       OR (assignment->>'end_epoch_ms')::numeric<=(assignment->>'start_epoch_ms')::numeric
       OR NOT EXISTS (SELECT 1 FROM matches target WHERE target.id=(assignment->>'match_id')::uuid
         AND target.competition_id=job.competition_id AND target.division_id=(assignment->>'division_id')::uuid)
       OR NOT EXISTS (SELECT 1 FROM playing_areas area WHERE area.id=(assignment->>'area_id')::uuid AND area.competition_id=job.competition_id) THEN
      RAISE EXCEPTION 'generated schedule assignment provenance is invalid';
    END IF;
    INSERT INTO scheduled_matches(schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at)
    VALUES(revision_row.id,(assignment->>'match_id')::uuid,job.competition_id,(assignment->>'area_id')::uuid,
      to_timestamp((assignment->>'start_epoch_ms')::double precision/1000),to_timestamp((assignment->>'end_epoch_ms')::double precision/1000));
  END LOOP;
  PERFORM set_config('matchday.phase4_accept_schedule','on',true);
  UPDATE schedule_revisions SET assignment_hash=phase4_schedule_assignment_hash(revision_row.id),status='ready_for_review',updated_at=now()
  WHERE id=revision_row.id RETURNING * INTO revision_row;
  PERFORM set_config('matchday.phase4_accept_schedule','off',true);
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id)
  VALUES(request_id_value,actor,'account',job.organisation_id,'schedule.option.accepted','schedule_revision',revision_row.id::text);
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('schedule_revision',revision_row.id::text,'schedule.option.accepted',jsonb_build_object('option_id',option_row.id),
    'phase4:schedule-option-accepted:'||option_row.id::text);
  RETURN revision_row;
END;
$$ LANGUAGE plpgsql;
