CREATE FUNCTION phase4_default_format_preferences() RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'minimum_matches',jsonb_build_object('per_entry',3),
    'ranking',jsonb_build_object('rank_all_entries',true),
    'knockout',jsonb_build_object('required',false),
    'placement',jsonb_build_object('required',false),
    'qualification',jsonb_build_object('cross_group_allowed',true),
    'priority',jsonb_build_object('value','participation')
  );
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION phase4_seed_setup_preferences() RETURNS trigger AS $$
BEGIN
  IF NEW.steps->'format_preferences' IS NULL OR NEW.steps->'format_preferences'='null'::jsonb THEN
    NEW.steps:=jsonb_set(
      NEW.steps,
      '{format_preferences}',
      phase4_default_format_preferences(),
      true
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ab_setup_drafts_phase4_preferences
BEFORE INSERT ON setup_drafts
FOR EACH ROW EXECUTE FUNCTION phase4_seed_setup_preferences();

-- Active drafts belonging to archived competitions cannot be mutated by the
-- setup-draft guard. Leave those historical drafts untouched during migration.
UPDATE setup_drafts draft
SET revision=draft.revision+1,
    steps=jsonb_set(draft.steps,'{format_preferences}',phase4_default_format_preferences(),true),
    updated_at=clock_timestamp()
WHERE draft.status='active'
  AND (draft.steps->'format_preferences' IS NULL OR draft.steps->'format_preferences'='null'::jsonb)
  AND EXISTS (
    SELECT 1
    FROM competitions competition
    WHERE competition.id=draft.competition_id AND competition.status<>'archived'
  );

CREATE FUNCTION phase4_refresh_setup_draft_references(
  target_organisation uuid,
  target_competition uuid,
  actor uuid,
  request_id_value text
) RETURNS jsonb AS $$
DECLARE
  draft setup_drafts%ROWTYPE;
  seeded jsonb;
  next_steps jsonb;
  next_completed_steps jsonb;
  next_completed_at jsonb;
  next_validation jsonb;
  next_current_step text;
  changed boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM organisation_memberships
    WHERE organisation_id=target_organisation
      AND account_id=actor
      AND status='active'
      AND role IN ('owner','organiser')
  ) THEN RAISE EXCEPTION 'setup refresh requires organiser permission'; END IF;

  SELECT * INTO draft
  FROM setup_drafts
  WHERE competition_id=target_competition
  FOR UPDATE;
  IF draft.id IS NULL OR draft.organisation_id<>target_organisation THEN
    RAISE EXCEPTION 'setup draft does not exist in organisation';
  END IF;
  IF draft.status<>'active' THEN RETURN to_jsonb(draft); END IF;

  seeded:=phase4_setup_seed_values(target_competition);
  changed:=
    draft.steps->'capacity' IS DISTINCT FROM seeded->'capacity' OR
    draft.steps->'settings' IS DISTINCT FROM seeded->'settings' OR
    draft.steps->'entries' IS DISTINCT FROM seeded->'entries';
  IF NOT changed THEN RETURN to_jsonb(draft); END IF;

  next_steps:=draft.steps||jsonb_build_object(
    'capacity',seeded->'capacity',
    'settings',seeded->'settings',
    'entries',seeded->'entries',
    'format_recommendations',NULL,
    'schedule_review',NULL,
    'review_publish',NULL
  );

  SELECT COALESCE(jsonb_agg(step_name ORDER BY ordinal),'[]'::jsonb)
  INTO next_completed_steps
  FROM jsonb_array_elements_text(draft.completed_steps) WITH ORDINALITY completed(step_name,ordinal)
  WHERE CASE step_name
    WHEN 'basics' THEN seeded->'basics' IS NOT NULL
    WHEN 'capacity' THEN seeded->'capacity' IS NOT NULL
    WHEN 'settings' THEN seeded->'capacity' IS NOT NULL AND seeded->'settings' IS NOT NULL
    WHEN 'entries' THEN seeded->'capacity' IS NOT NULL AND seeded->'settings' IS NOT NULL AND seeded->'entries' IS NOT NULL
    WHEN 'format_preferences' THEN
      seeded->'capacity' IS NOT NULL AND seeded->'settings' IS NOT NULL AND seeded->'entries' IS NOT NULL
      AND draft.steps->'format_preferences' IS NOT NULL AND draft.steps->'format_preferences'<>'null'::jsonb
    ELSE false
  END;

  SELECT COALESCE(jsonb_object_agg(completed.key,completed.value),'{}'::jsonb)
  INTO next_completed_at
  FROM jsonb_each(COALESCE(draft.validation->'completed_at_by_step','{}'::jsonb)) completed
  WHERE next_completed_steps ? completed.key;

  next_current_step:=CASE
    WHEN draft.current_step='basics' THEN 'basics'
    WHEN seeded->'capacity' IS NULL THEN 'capacity'
    WHEN seeded->'settings' IS NULL THEN 'settings'
    WHEN seeded->'entries' IS NULL THEN 'entries'
    WHEN draft.current_step IN ('schedule_review','review_publish') THEN 'format_recommendations'
    ELSE draft.current_step
  END;

  next_validation:=jsonb_build_object(
    'valid',false,
    'pending',true,
    'issues','[]'::jsonb,
    'completed_at_by_step',next_completed_at
  );

  UPDATE setup_drafts
  SET revision=revision+1,
      current_step=next_current_step,
      completed_steps=next_completed_steps,
      steps=next_steps,
      validation=next_validation,
      updated_by=actor,
      updated_at=clock_timestamp()
  WHERE id=draft.id
  RETURNING * INTO draft;

  INSERT INTO audit_events(
    request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata
  ) VALUES(
    request_id_value,actor,'account',target_organisation,'setup.references.refreshed','setup_draft',draft.id::text,
    jsonb_build_object(
      'revision',draft.revision,
      'competition_id',target_competition,
      'current_step',draft.current_step
    )
  );
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES(
    'setup_draft',draft.id::text,'setup.references.refreshed',
    jsonb_build_object('competition_id',target_competition,'revision',draft.revision,'current_step',draft.current_step),
    'phase4:setup-reference-refresh:'||draft.id::text||':'||draft.revision::text
  ) ON CONFLICT(idempotency_key) DO NOTHING;
  RETURN to_jsonb(draft);
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_resume_setup_draft(
  target_organisation uuid,
  target_competition uuid,
  actor uuid,
  idempotency_value text,
  request_id_value text
) RETURNS jsonb AS $$
DECLARE
  receipt phase4_mutation_receipts%ROWTYPE;
  request_hash_value text;
  response_value jsonb;
BEGIN
  request_hash_value:=phase4_sha256_json(jsonb_build_object('competition_id',target_competition));
  PERFORM pg_advisory_xact_lock(hashtextextended('phase4-receipt:'||idempotency_value,0));
  SELECT * INTO receipt
  FROM phase4_mutation_receipts
  WHERE organisation_id=target_organisation AND idempotency_key=idempotency_value;
  IF receipt.id IS NOT NULL THEN
    IF receipt.operation<>'setup.resume' OR receipt.request_hash<>request_hash_value THEN
      RAISE EXCEPTION 'idempotency key was reused with a different setup resume request';
    END IF;
    RETURN receipt.response;
  END IF;

  response_value:=phase4_refresh_setup_draft_references(
    target_organisation,
    target_competition,
    actor,
    request_id_value
  );
  INSERT INTO phase4_mutation_receipts(organisation_id,idempotency_key,operation,request_hash,response)
  VALUES(target_organisation,idempotency_value,'setup.resume',request_hash_value,response_value);
  RETURN response_value;
END;
$$ LANGUAGE plpgsql;
