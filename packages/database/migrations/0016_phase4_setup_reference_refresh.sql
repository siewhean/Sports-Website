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

UPDATE setup_drafts
SET revision=revision+1,
    steps=jsonb_set(steps,'{format_preferences}',phase4_default_format_preferences(),true),
    updated_at=clock_timestamp()
WHERE status='active'
  AND (steps->'format_preferences' IS NULL OR steps->'format_preferences'='null'::jsonb);

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
  next_validation jsonb;
  changed boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM organisation_memberships
    WHERE organisation_id=target_organisation
      AND account_id=actor
      AND status='active'
      AND role IN ('owner','organiser','viewer')
  ) THEN RAISE EXCEPTION 'setup refresh requires competition membership'; END IF;

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
  WHERE step_name NOT IN ('format_recommendations','schedule_review','review_publish');
  next_validation:=jsonb_build_object(
    'valid',false,
    'pending',true,
    'issues','[]'::jsonb,
    'completed_at_by_step',COALESCE(draft.validation->'completed_at_by_step','{}'::jsonb)
  );

  UPDATE setup_drafts
  SET revision=revision+1,
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
    jsonb_build_object('revision',draft.revision,'competition_id',target_competition)
  );
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES(
    'setup_draft',draft.id::text,'setup.references.refreshed',
    jsonb_build_object('competition_id',target_competition,'revision',draft.revision),
    'phase4:setup-reference-refresh:'||draft.id::text||':'||draft.revision::text
  ) ON CONFLICT(idempotency_key) DO NOTHING;
  RETURN to_jsonb(draft);
END;
$$ LANGUAGE plpgsql;
