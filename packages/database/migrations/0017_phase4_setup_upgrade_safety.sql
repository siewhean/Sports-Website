-- Corrective, forward-only safety pass for Assisted Setup upgrades.

-- Existing template applications predate the 0014 trigger. Do not silently
-- bless cross-tenant, cross-sport, or orphaned history.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM format_revisions revision
    LEFT JOIN competitions competition ON competition.id=revision.competition_id
    LEFT JOIN format_template_versions version ON version.id=revision.template_version_id
    LEFT JOIN format_templates template ON template.id=version.template_id
    WHERE revision.source_kind='template'
      AND (
        revision.template_version_id IS NULL
        OR competition.id IS NULL
        OR version.id IS NULL
        OR template.id IS NULL
        OR version.organisation_id<>competition.organisation_id
        OR template.organisation_id<>competition.organisation_id
        OR template.sport_code<>competition.sport_code
      )
  ) THEN
    RAISE EXCEPTION 'pre-existing format template applications violate organisation, sport, or provenance guards';
  END IF;
END;
$$;

-- Preserve the 0015 implementation as the calculation body, then put a
-- fail-closed validator in front of it.
ALTER FUNCTION phase4_setup_seed_values(uuid) RENAME TO phase4_setup_seed_values_unchecked;

CREATE FUNCTION phase4_setup_seed_values(target_competition uuid) RETURNS jsonb AS $$
DECLARE
  competition_sport text;
  pack_definition jsonb;
  slot_value numeric;
  settings_slot_value numeric;
BEGIN
  SELECT sport_code INTO competition_sport FROM competitions WHERE id=target_competition;
  IF competition_sport IS NULL THEN
    RAISE EXCEPTION 'setup seed competition does not exist';
  END IF;

  SELECT definition INTO pack_definition
  FROM sport_pack_versions
  WHERE sport_code=competition_sport AND status='active'
  ORDER BY activated_at DESC NULLS LAST,created_at DESC,version DESC
  LIMIT 1;

  IF pack_definition IS NULL
     OR jsonb_typeof(pack_definition)<>'object'
     OR jsonb_typeof(pack_definition->'recommendedSlotMinutes')<>'number'
     OR jsonb_typeof(pack_definition->'recommendedSettings')<>'object'
     OR jsonb_typeof(pack_definition->'recommendedSettings'->'slotMinutes')<>'number' THEN
    RAISE EXCEPTION 'setup seed requires a valid active sport pack for %',competition_sport;
  END IF;

  BEGIN
    slot_value:=(pack_definition->>'recommendedSlotMinutes')::numeric;
    settings_slot_value:=(pack_definition->'recommendedSettings'->>'slotMinutes')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'setup seed requires a valid active sport pack for %',competition_sport;
  END;
  IF slot_value<>trunc(slot_value) OR slot_value NOT BETWEEN 5 AND 480 OR settings_slot_value<>slot_value THEN
    RAISE EXCEPTION 'setup seed requires a valid active sport pack for %',competition_sport;
  END IF;

  RETURN phase4_setup_seed_values_unchecked(target_competition);
END;
$$ LANGUAGE plpgsql STABLE;

DROP TRIGGER aa_setup_drafts_phase4_seed ON setup_drafts;
CREATE TRIGGER zz_setup_drafts_phase4_seed
BEFORE INSERT ON setup_drafts
FOR EACH ROW EXECUTE FUNCTION phase4_seed_setup_draft();

-- A populated upgrade must not retain active drafts which could only have
-- been seeded through the retired fallback.
DO $$
DECLARE draft record;
BEGIN
  FOR draft IN SELECT competition_id FROM setup_drafts WHERE status='active' LOOP
    PERFORM phase4_setup_seed_values(draft.competition_id);
  END LOOP;
END;
$$;

-- Detect stale downstream evidence independently from canonical capacity,
-- settings, and entry references. Malformed evidence is stale by definition.
CREATE FUNCTION phase4_setup_format_evidence_stale(target_competition uuid,evidence jsonb)
RETURNS boolean AS $$
DECLARE candidate jsonb;
BEGIN
  IF evidence IS NULL OR evidence='null'::jsonb THEN RETURN false; END IF;
  IF jsonb_typeof(evidence)<>'object'
     OR jsonb_typeof(evidence->'recommendations')<>'array'
     OR jsonb_array_length(evidence->'recommendations') NOT BETWEEN 1 AND 3
     OR NOT evidence ? 'selected_recommendation_id'
     OR jsonb_typeof(evidence->'selected_recommendation_id') NOT IN ('string','null')
     OR (jsonb_typeof(evidence->'selected_recommendation_id')='string'
       AND btrim(evidence->>'selected_recommendation_id')='')
     OR NOT evidence ? 'recommendation_set_hash'
     OR jsonb_typeof(evidence->'recommendation_set_hash')<>'string'
     OR btrim(evidence->>'recommendation_set_hash')='' THEN RETURN true; END IF;
  FOR candidate IN
    SELECT value FROM jsonb_array_elements(evidence->'recommendations')
    UNION ALL
    SELECT evidence->'requires_changes' WHERE jsonb_typeof(evidence->'requires_changes')='object'
  LOOP
    IF jsonb_typeof(candidate)<>'object'
       OR NOT EXISTS (
         SELECT 1 FROM format_revisions revision
         WHERE revision.id=(candidate->>'format_revision_id')::uuid
           AND revision.competition_id=target_competition
           AND revision.definition_hash=candidate->>'format_definition_hash'
           AND revision.status<>'superseded'
       ) THEN RETURN true; END IF;
  END LOOP;
  IF jsonb_typeof(evidence->'selected_recommendation_id')='string' AND NOT EXISTS (
       SELECT 1
       FROM (
         SELECT value FROM jsonb_array_elements(evidence->'recommendations')
         UNION ALL
         SELECT evidence->'requires_changes' WHERE jsonb_typeof(evidence->'requires_changes')='object'
       ) candidates
       WHERE candidates.value->>'id'=evidence->>'selected_recommendation_id'
     ) THEN RETURN true; END IF;
  RETURN false;
EXCEPTION WHEN others THEN RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase4_setup_schedule_evidence_stale(
  target_competition uuid,
  canonical_capacity jsonb,
  canonical_settings jsonb,
  format_evidence jsonb,
  evidence jsonb
) RETURNS boolean AS $$
BEGIN
  IF evidence IS NULL OR evidence='null'::jsonb THEN RETURN false; END IF;
  IF canonical_capacity IS NULL OR canonical_capacity='null'::jsonb
     OR canonical_settings IS NULL OR canonical_settings='null'::jsonb
     OR jsonb_typeof(evidence)<>'object'
     OR evidence->>'selected_recommendation_id' IS DISTINCT FROM format_evidence->>'selected_recommendation_id'
     OR NOT EXISTS (
       SELECT 1
       FROM (
         SELECT value FROM jsonb_array_elements(format_evidence->'recommendations')
         UNION ALL
         SELECT format_evidence->'requires_changes'
         WHERE jsonb_typeof(format_evidence->'requires_changes')='object'
       ) candidates
       WHERE candidates.value->>'id'=evidence->>'selected_recommendation_id'
         AND candidates.value->>'format_revision_id'=evidence->>'format_revision_id'
         AND candidates.value->>'format_definition_hash'=evidence->>'format_definition_hash'
     )
     OR (evidence->>'capacity_revision')::integer<>(canonical_capacity->>'revision')::integer
     OR evidence->'settings_references' IS DISTINCT FROM (
       SELECT COALESCE(jsonb_agg(
         jsonb_build_object(
           'scope',item->>'scope',
           'division_id',item->'division_id',
           'settings_revision',item->'settings_revision',
           'pack_definition_hash',item->'pack_definition_hash'
         ) ORDER BY item->>'scope',item->>'division_id'
       ),'[]'::jsonb)
       FROM jsonb_array_elements(canonical_settings) item
     )
     OR NOT EXISTS (
       SELECT 1
       FROM schedule_generation_jobs job
       JOIN schedule_generation_options option
         ON option.job_id=job.id
        AND option.result_revision=(evidence->>'selected_result_revision')::integer
        AND option.result_hash=evidence->>'selected_result_hash'
       JOIN schedule_revisions revision
         ON revision.id=(evidence->>'schedule_revision_id')::uuid
        AND revision.source_job_id=job.id
        AND revision.source_option_id=option.id
        AND revision.status<>'expired'
       JOIN format_revisions format
         ON format.id=(evidence->>'format_revision_id')::uuid
        AND format.competition_id=target_competition
        AND format.definition_hash=evidence->>'format_definition_hash'
       WHERE job.id=(evidence->>'schedule_job_id')::uuid
         AND job.competition_id=target_competition
         AND (job.input_snapshot->>'source_revision')::integer=(evidence->>'source_revision')::integer
     ) THEN RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase4_setup_publication_evidence_stale(
  target_competition uuid,
  canonical_capacity jsonb,
  canonical_settings jsonb,
  schedule_evidence jsonb,
  evidence jsonb
) RETURNS boolean AS $$
BEGIN
  IF evidence IS NULL OR evidence='null'::jsonb THEN RETURN false; END IF;
  IF canonical_capacity IS NULL OR canonical_capacity='null'::jsonb
     OR canonical_settings IS NULL OR canonical_settings='null'::jsonb
     OR jsonb_typeof(evidence)<>'object'
     OR evidence->>'selected_format_revision_id' IS DISTINCT FROM schedule_evidence->>'format_revision_id'
     OR evidence->>'selected_schedule_result_hash' IS DISTINCT FROM schedule_evidence->>'selected_result_hash'
     OR (
       evidence->>'publication_status'='published'
       AND evidence->>'published_schedule_revision_id' IS DISTINCT FROM schedule_evidence->>'schedule_revision_id'
     )
     OR (evidence->>'capacity_revision')::integer<>(canonical_capacity->>'revision')::integer
     OR evidence->'settings_references' IS DISTINCT FROM (
       SELECT COALESCE(jsonb_agg(
         jsonb_build_object(
           'scope',item->>'scope',
           'division_id',item->'division_id',
           'settings_revision',item->'settings_revision',
           'pack_definition_hash',item->'pack_definition_hash'
         ) ORDER BY item->>'scope',item->>'division_id'
       ),'[]'::jsonb)
       FROM jsonb_array_elements(canonical_settings) item
     )
     OR NOT EXISTS (
       SELECT 1
       FROM schedule_revisions revision
       JOIN schedule_generation_options option ON option.id=revision.source_option_id
       JOIN format_revisions format ON format.id=(evidence->>'selected_format_revision_id')::uuid
       WHERE revision.competition_id=target_competition
         AND revision.id=(schedule_evidence->>'schedule_revision_id')::uuid
         AND option.result_hash=evidence->>'selected_schedule_result_hash'
         AND format.competition_id=target_competition
         AND (
           evidence->>'publication_status'<>'published'
           OR (
             revision.id=(evidence->>'published_schedule_revision_id')::uuid
             AND revision.status='published'
             AND EXISTS (
               SELECT 1 FROM competition_publications publication
               WHERE publication.competition_id=target_competition
                 AND publication.published_schedule_revision_id=revision.id
             )
           )
         )
     ) THEN RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION phase4_refresh_setup_draft_references(
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
  capacity_changed boolean;
  settings_changed boolean;
  entries_changed boolean;
  format_stale boolean;
  schedule_stale boolean;
  publication_stale boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM organisation_memberships
    WHERE organisation_id=target_organisation AND account_id=actor
      AND status='active' AND role IN ('owner','organiser')
  ) THEN RAISE EXCEPTION 'setup refresh requires organiser permission'; END IF;

  SELECT * INTO draft FROM setup_drafts WHERE competition_id=target_competition FOR UPDATE;
  IF draft.id IS NULL OR draft.organisation_id<>target_organisation THEN
    RAISE EXCEPTION 'setup draft does not exist in organisation';
  END IF;
  IF draft.status<>'active' THEN RETURN to_jsonb(draft); END IF;

  seeded:=phase4_setup_seed_values(target_competition);
  capacity_changed:=draft.steps->'capacity' IS DISTINCT FROM seeded->'capacity';
  settings_changed:=draft.steps->'settings' IS DISTINCT FROM seeded->'settings';
  entries_changed:=draft.steps->'entries' IS DISTINCT FROM seeded->'entries';
  format_stale:=capacity_changed OR settings_changed OR entries_changed
    OR phase4_setup_format_evidence_stale(target_competition,draft.steps->'format_recommendations');
  schedule_stale:=format_stale OR phase4_setup_schedule_evidence_stale(
    target_competition,seeded->'capacity',seeded->'settings',
    draft.steps->'format_recommendations',draft.steps->'schedule_review'
  );
  publication_stale:=schedule_stale OR phase4_setup_publication_evidence_stale(
    target_competition,seeded->'capacity',seeded->'settings',
    draft.steps->'schedule_review',draft.steps->'review_publish'
  );

  IF NOT capacity_changed AND NOT settings_changed AND NOT entries_changed
     AND NOT format_stale AND NOT schedule_stale AND NOT publication_stale THEN
    RETURN to_jsonb(draft);
  END IF;

  next_steps:=draft.steps;
  IF capacity_changed THEN next_steps:=jsonb_set(next_steps,'{capacity}',seeded->'capacity',true); END IF;
  IF settings_changed THEN next_steps:=jsonb_set(next_steps,'{settings}',seeded->'settings',true); END IF;
  IF entries_changed THEN next_steps:=jsonb_set(next_steps,'{entries}',seeded->'entries',true); END IF;
  IF format_stale THEN next_steps:=jsonb_set(next_steps,'{format_recommendations}','null'::jsonb,true); END IF;
  IF schedule_stale THEN next_steps:=jsonb_set(next_steps,'{schedule_review}','null'::jsonb,true); END IF;
  IF publication_stale THEN next_steps:=jsonb_set(next_steps,'{review_publish}','null'::jsonb,true); END IF;

  SELECT COALESCE(jsonb_agg(step_name ORDER BY ordinal),'[]'::jsonb)
  INTO next_completed_steps
  FROM jsonb_array_elements_text(draft.completed_steps) WITH ORDINALITY completed(step_name,ordinal)
  WHERE CASE step_name
    WHEN 'basics' THEN seeded->'basics' IS NOT NULL
    WHEN 'capacity' THEN seeded->'capacity' IS NOT NULL
    WHEN 'settings' THEN seeded->'capacity' IS NOT NULL AND seeded->'settings' IS NOT NULL
    WHEN 'entries' THEN seeded->'capacity' IS NOT NULL AND seeded->'settings' IS NOT NULL AND seeded->'entries' IS NOT NULL
    WHEN 'format_preferences' THEN seeded->'capacity' IS NOT NULL AND seeded->'settings' IS NOT NULL
      AND seeded->'entries' IS NOT NULL AND draft.steps->'format_preferences' IS NOT NULL
      AND draft.steps->'format_preferences'<>'null'::jsonb
    WHEN 'format_recommendations' THEN NOT format_stale
    WHEN 'schedule_review' THEN NOT schedule_stale
    WHEN 'review_publish' THEN NOT publication_stale
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
    WHEN format_stale AND draft.current_step IN ('format_recommendations','schedule_review','review_publish') THEN 'format_recommendations'
    WHEN schedule_stale AND draft.current_step IN ('schedule_review','review_publish') THEN 'schedule_review'
    WHEN publication_stale AND draft.current_step='review_publish' THEN 'review_publish'
    ELSE draft.current_step
  END;
  next_validation:=jsonb_build_object(
    'valid',false,'pending',true,'issues','[]'::jsonb,'completed_at_by_step',next_completed_at
  );

  UPDATE setup_drafts
  SET revision=revision+1,current_step=next_current_step,completed_steps=next_completed_steps,
      steps=next_steps,validation=next_validation,updated_by=actor,updated_at=clock_timestamp()
  WHERE id=draft.id RETURNING * INTO draft;

  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(request_id_value,actor,'account',target_organisation,'setup.references.refreshed','setup_draft',draft.id::text,
    jsonb_build_object(
      'revision',draft.revision,'competition_id',target_competition,'current_step',draft.current_step,
      'capacity_changed',capacity_changed,'settings_changed',settings_changed,'entries_changed',entries_changed,
      'format_invalidated',format_stale,'schedule_invalidated',schedule_stale,'publication_invalidated',publication_stale
    ));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('setup_draft',draft.id::text,'setup.references.refreshed',
    jsonb_build_object('competition_id',target_competition,'revision',draft.revision,'current_step',draft.current_step),
    'phase4:setup-reference-refresh:'||draft.id::text||':'||draft.revision::text)
  ON CONFLICT(idempotency_key) DO NOTHING;
  RETURN to_jsonb(draft);
END;
$$ LANGUAGE plpgsql;

-- Exact resume replays remain idempotent, but authorisation is checked before
-- a stored response can be returned.
CREATE OR REPLACE FUNCTION phase4_resume_setup_draft(
  target_organisation uuid,target_competition uuid,actor uuid,
  idempotency_value text,request_id_value text
) RETURNS jsonb AS $$
DECLARE
  receipt phase4_mutation_receipts%ROWTYPE;
  request_hash_value text;
  response_value jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM organisation_memberships
    WHERE organisation_id=target_organisation AND account_id=actor
      AND status='active' AND role IN ('owner','organiser')
  ) THEN RAISE EXCEPTION 'setup resume requires organiser permission'; END IF;
  request_hash_value:=phase4_sha256_json(jsonb_build_object('competition_id',target_competition));
  PERFORM pg_advisory_xact_lock(hashtextextended('phase4-receipt:'||idempotency_value,0));
  SELECT * INTO receipt FROM phase4_mutation_receipts
  WHERE organisation_id=target_organisation AND idempotency_key=idempotency_value;
  IF receipt.id IS NOT NULL THEN
    IF receipt.operation<>'setup.resume' OR receipt.request_hash<>request_hash_value THEN
      RAISE EXCEPTION 'idempotency key was reused with a different setup resume request';
    END IF;
    RETURN receipt.response;
  END IF;
  response_value:=phase4_refresh_setup_draft_references(
    target_organisation,target_competition,actor,request_id_value
  );
  INSERT INTO phase4_mutation_receipts(organisation_id,idempotency_key,operation,request_hash,response)
  VALUES(target_organisation,idempotency_value,'setup.resume',request_hash_value,response_value);
  RETURN response_value;
END;
$$ LANGUAGE plpgsql;
