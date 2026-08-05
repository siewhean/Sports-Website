-- Reconcile Assisted Setup evidence with legitimate format and schedule child
-- revisions. Resume remains the only mutating read path; ordinary GETs do not
-- call these derivation functions.

CREATE FUNCTION phase4_format_revision_descends_from(
  descendant_revision uuid,
  ancestor_revision uuid
) RETURNS boolean AS $$
  WITH RECURSIVE lineage(id,parent_revision_id) AS (
    SELECT id,parent_revision_id
    FROM format_revisions
    WHERE id=descendant_revision
    UNION ALL
    SELECT parent.id,parent.parent_revision_id
    FROM format_revisions parent
    JOIN lineage child ON child.parent_revision_id=parent.id
  )
  SELECT EXISTS (SELECT 1 FROM lineage WHERE id=ancestor_revision);
$$ LANGUAGE sql STABLE;

CREATE FUNCTION phase4_schedule_revision_accepted_ancestor(
  effective_revision uuid
) RETURNS uuid AS $$
  WITH RECURSIVE lineage(id,parent_revision_id,source_option_id,depth) AS (
    SELECT id,parent_revision_id,source_option_id,0
    FROM schedule_revisions
    WHERE id=effective_revision
    UNION ALL
    SELECT parent.id,parent.parent_revision_id,parent.source_option_id,child.depth+1
    FROM schedule_revisions parent
    JOIN lineage child ON child.parent_revision_id=parent.id
  )
  SELECT id
  FROM lineage
  WHERE source_option_id IS NOT NULL
  ORDER BY depth
  LIMIT 1;
$$ LANGUAGE sql STABLE;

CREATE FUNCTION phase4_setup_settings_reference_values(
  canonical_settings jsonb
) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'scope',item->>'scope',
      'division_id',item->'division_id',
      'settings_revision',item->'settings_revision',
      'pack_definition_hash',item->'pack_definition_hash'
    ) ORDER BY item->>'scope',item->>'division_id'
  ),'[]'::jsonb)
  FROM jsonb_array_elements(canonical_settings) item;
$$ LANGUAGE sql STABLE;

CREATE FUNCTION phase4_setup_capacity_inputs_changed(
  stored_capacity jsonb,
  canonical_capacity jsonb
) RETURNS boolean AS $$
  SELECT stored_capacity IS NULL
    OR canonical_capacity IS NULL
    OR jsonb_build_object(
      'kind',stored_capacity->'kind',
      'competition_id',stored_capacity->'competition_id',
      'revision',stored_capacity->'revision',
      'time_zone',stored_capacity->'time_zone',
      'area_ids',stored_capacity->'area_ids',
      'source_hash',stored_capacity->'source_hash',
      'slotMinutes',stored_capacity->'effective'->'slotMinutes',
      'rawTotalSlots',stored_capacity->'effective'->'rawTotalSlots',
      'fixedReserveSlots',stored_capacity->'effective'->'fixedReserveSlots',
      'availableMatchSlots',stored_capacity->'effective'->'availableMatchSlots'
    ) IS DISTINCT FROM jsonb_build_object(
      'kind',canonical_capacity->'kind',
      'competition_id',canonical_capacity->'competition_id',
      'revision',canonical_capacity->'revision',
      'time_zone',canonical_capacity->'time_zone',
      'area_ids',canonical_capacity->'area_ids',
      'source_hash',canonical_capacity->'source_hash',
      'slotMinutes',canonical_capacity->'effective'->'slotMinutes',
      'rawTotalSlots',canonical_capacity->'effective'->'rawTotalSlots',
      'fixedReserveSlots',canonical_capacity->'effective'->'fixedReserveSlots',
      'availableMatchSlots',canonical_capacity->'effective'->'availableMatchSlots'
    );
$$ LANGUAGE sql STABLE;

-- Recommendation revisions are immutable ancestry anchors. A later published
-- manual child may supersede an anchor without making the recommendation
-- evidence stale.
CREATE OR REPLACE FUNCTION phase4_setup_format_evidence_stale(
  target_competition uuid,
  evidence jsonb
) RETURNS boolean AS $$
DECLARE
  candidate jsonb;
  division_format jsonb;
  selected_candidate boolean;
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
    SELECT evidence->'requires_changes'
    WHERE jsonb_typeof(evidence->'requires_changes')='object'
  LOOP
    selected_candidate:=jsonb_typeof(evidence->'selected_recommendation_id')='string'
      AND candidate->>'id'=evidence->>'selected_recommendation_id';
    IF jsonb_typeof(candidate)<>'object'
       OR jsonb_typeof(candidate->'division_formats')<>'array'
       OR jsonb_array_length(candidate->'division_formats')=0
       OR (selected_candidate AND candidate->>'format_revision_id' IS NULL)
       OR (candidate->>'format_revision_id' IS NOT NULL AND NOT EXISTS (
         SELECT 1
         FROM format_revisions revision
         WHERE revision.id=(candidate->>'format_revision_id')::uuid
           AND revision.competition_id=target_competition
           AND revision.definition_hash=candidate->>'format_definition_hash'
       ))
       OR (candidate->>'format_revision_id' IS NOT NULL AND NOT EXISTS (
         SELECT 1
         FROM jsonb_array_elements(candidate->'division_formats') division_reference
         WHERE division_reference->>'format_revision_id'=candidate->>'format_revision_id'
           AND division_reference->>'format_definition_hash'=candidate->>'format_definition_hash'
       )) THEN RETURN true; END IF;

    FOR division_format IN
      SELECT value FROM jsonb_array_elements(candidate->'division_formats')
    LOOP
      IF (selected_candidate AND division_format->>'format_revision_id' IS NULL)
         OR (division_format->>'format_revision_id' IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM format_revisions revision
        WHERE revision.id=(division_format->>'format_revision_id')::uuid
          AND revision.competition_id=target_competition
          AND revision.division_id=(division_format->>'division_id')::uuid
          AND revision.definition_hash=division_format->>'format_definition_hash'
      )) THEN RETURN true; END IF;
    END LOOP;
  END LOOP;

  IF jsonb_typeof(evidence->'selected_recommendation_id')='string' AND NOT EXISTS (
    SELECT 1
    FROM (
      SELECT value FROM jsonb_array_elements(evidence->'recommendations')
      UNION ALL
      SELECT evidence->'requires_changes'
      WHERE jsonb_typeof(evidence->'requires_changes')='object'
    ) candidates
    WHERE candidates.value->>'id'=evidence->>'selected_recommendation_id'
  ) THEN RETURN true; END IF;
  RETURN false;
EXCEPTION WHEN others THEN
  RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase4_schedule_formats_descend_from_recommendation(
  target_competition uuid,
  target_schedule_revision uuid,
  format_evidence jsonb
) RETURNS boolean AS $$
DECLARE
  candidate jsonb;
BEGIN
  SELECT candidate_value INTO candidate
  FROM (
    SELECT value candidate_value
    FROM jsonb_array_elements(format_evidence->'recommendations')
    UNION ALL
    SELECT format_evidence->'requires_changes'
    WHERE jsonb_typeof(format_evidence->'requires_changes')='object'
  ) candidates
  WHERE candidate_value->>'id'=format_evidence->>'selected_recommendation_id'
  LIMIT 1;

  IF candidate IS NULL
     OR jsonb_typeof(candidate->'division_formats')<>'array'
     OR jsonb_array_length(candidate->'division_formats')=0 THEN
    RETURN false;
  END IF;

  RETURN
    (SELECT count(*) FROM schedule_revision_formats
      WHERE schedule_revision_id=target_schedule_revision
        AND competition_id=target_competition)
      = jsonb_array_length(candidate->'division_formats')
    AND (
      SELECT count(DISTINCT division_format->>'division_id')
      FROM jsonb_array_elements(candidate->'division_formats') division_format
    )=jsonb_array_length(candidate->'division_formats')
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(candidate->'division_formats') division_format
      LEFT JOIN format_revisions recommended
        ON recommended.id=(division_format->>'format_revision_id')::uuid
       AND recommended.competition_id=target_competition
       AND recommended.division_id=(division_format->>'division_id')::uuid
       AND recommended.definition_hash=division_format->>'format_definition_hash'
      LEFT JOIN schedule_revision_formats applied
        ON applied.schedule_revision_id=target_schedule_revision
       AND applied.competition_id=target_competition
       AND applied.division_id=(division_format->>'division_id')::uuid
      WHERE recommended.id IS NULL
         OR applied.format_revision_id IS NULL
         OR NOT phase4_format_revision_descends_from(
           applied.format_revision_id,
           recommended.id
         )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM schedule_revision_formats applied
      WHERE applied.schedule_revision_id=target_schedule_revision
        AND applied.competition_id=target_competition
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(candidate->'division_formats') division_format
          WHERE (division_format->>'division_id')::uuid=applied.division_id
        )
    );
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION phase4_setup_schedule_evidence_stale(
  target_competition uuid,
  canonical_capacity jsonb,
  canonical_settings jsonb,
  format_evidence jsonb,
  evidence jsonb
) RETURNS boolean AS $$
DECLARE
  accepted_revision_id uuid;
BEGIN
  IF evidence IS NULL OR evidence='null'::jsonb THEN RETURN false; END IF;
  accepted_revision_id:=phase4_schedule_revision_accepted_ancestor(
    (evidence->>'schedule_revision_id')::uuid
  );
  IF canonical_capacity IS NULL OR canonical_capacity='null'::jsonb
     OR canonical_settings IS NULL OR canonical_settings='null'::jsonb
     OR jsonb_typeof(evidence)<>'object'
     OR evidence->>'selected_recommendation_id' IS DISTINCT FROM format_evidence->>'selected_recommendation_id'
     OR (evidence->>'capacity_revision')::integer<>(canonical_capacity->>'revision')::integer
     OR evidence->'settings_references' IS DISTINCT FROM
       phase4_setup_settings_reference_values(canonical_settings)
     OR accepted_revision_id IS NULL
     OR NOT phase4_schedule_formats_descend_from_recommendation(
       target_competition,
       (evidence->>'schedule_revision_id')::uuid,
       format_evidence
     )
     OR NOT EXISTS (
       SELECT 1
       FROM schedule_revisions effective
       JOIN schedule_revisions accepted ON accepted.id=accepted_revision_id
       JOIN schedule_generation_options option ON option.id=accepted.source_option_id
       JOIN schedule_generation_jobs job ON job.id=option.job_id
       JOIN schedule_revision_formats applied
         ON applied.schedule_revision_id=effective.id
        AND applied.format_revision_id=(evidence->>'format_revision_id')::uuid
       JOIN format_revisions format ON format.id=applied.format_revision_id
       WHERE effective.id=(evidence->>'schedule_revision_id')::uuid
         AND effective.competition_id=target_competition
         AND effective.status IN ('ready_for_review','published')
         AND effective.assignment_hash=evidence->>'selected_result_hash'
         AND accepted.competition_id=target_competition
         AND accepted.source_job_id=job.id
         AND job.id=(evidence->>'schedule_job_id')::uuid
         AND job.competition_id=target_competition
         AND job.objective=evidence->>'objective'
         AND (job.input_snapshot->>'source_revision')::integer=(evidence->>'source_revision')::integer
         AND option.result_revision=(evidence->>'selected_result_revision')::integer
         AND format.competition_id=target_competition
         AND format.definition_hash=evidence->>'format_definition_hash'
     ) THEN RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN
  RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION phase4_setup_publication_evidence_stale(
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
     OR schedule_evidence IS NULL OR schedule_evidence='null'::jsonb
     OR jsonb_typeof(evidence)<>'object'
     OR evidence->>'selected_format_revision_id' IS DISTINCT FROM schedule_evidence->>'format_revision_id'
     OR evidence->>'selected_schedule_result_hash' IS DISTINCT FROM schedule_evidence->>'selected_result_hash'
     OR (evidence->>'capacity_revision')::integer<>(canonical_capacity->>'revision')::integer
     OR evidence->'settings_references' IS DISTINCT FROM
       phase4_setup_settings_reference_values(canonical_settings)
     OR (
       evidence->>'publication_status'='published'
       AND (
         evidence->>'published_schedule_revision_id' IS DISTINCT FROM schedule_evidence->>'schedule_revision_id'
         OR NOT EXISTS (
           SELECT 1
           FROM schedule_revisions revision
           JOIN competition_publications publication
             ON publication.competition_id=revision.competition_id
            AND publication.published_schedule_revision_id=revision.id
           WHERE revision.id=(evidence->>'published_schedule_revision_id')::uuid
             AND revision.competition_id=target_competition
             AND revision.status='published'
             AND revision.assignment_hash=evidence->>'selected_schedule_result_hash'
         )
       )
     )
  THEN RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN
  RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase4_derive_setup_schedule_reference(
  target_competition uuid,
  canonical_capacity jsonb,
  canonical_settings jsonb,
  format_evidence jsonb
) RETURNS jsonb AS $$
DECLARE
  effective schedule_revisions%ROWTYPE;
  candidate_revision schedule_revisions%ROWTYPE;
  accepted schedule_revisions%ROWTYPE;
  option_row schedule_generation_options%ROWTYPE;
  job schedule_generation_jobs%ROWTYPE;
  applied_format record;
BEGIN
  IF canonical_capacity IS NULL OR canonical_capacity='null'::jsonb
     OR canonical_settings IS NULL OR canonical_settings='null'::jsonb
     OR format_evidence IS NULL OR format_evidence='null'::jsonb
     OR phase4_setup_format_evidence_stale(target_competition,format_evidence)
     OR jsonb_typeof(format_evidence->'selected_recommendation_id')<>'string' THEN
    RETURN NULL;
  END IF;

  FOR candidate_revision IN
    SELECT revision.*
    FROM schedule_revisions revision
    LEFT JOIN competition_publications publication
      ON publication.competition_id=revision.competition_id
    WHERE revision.competition_id=target_competition
      AND revision.status IN ('ready_for_review','published')
    ORDER BY
      (revision.id=publication.published_schedule_revision_id) DESC,
      revision.revision DESC,
      revision.id
  LOOP
    IF phase4_schedule_revision_accepted_ancestor(candidate_revision.id) IS NOT NULL
       AND phase4_schedule_formats_descend_from_recommendation(
         target_competition,candidate_revision.id,format_evidence
       ) THEN
      effective:=candidate_revision;
      EXIT;
    END IF;
  END LOOP;
  IF effective.id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO accepted
  FROM schedule_revisions
  WHERE id=phase4_schedule_revision_accepted_ancestor(effective.id);
  SELECT * INTO option_row FROM schedule_generation_options WHERE id=accepted.source_option_id;
  SELECT * INTO job FROM schedule_generation_jobs WHERE id=option_row.job_id;
  SELECT applied.format_revision_id,format.definition_hash
  INTO applied_format
  FROM schedule_revision_formats applied
  JOIN format_revisions format ON format.id=applied.format_revision_id
  WHERE applied.schedule_revision_id=effective.id
  ORDER BY applied.division_id
  LIMIT 1;

  IF job.id IS NULL OR option_row.id IS NULL OR applied_format.format_revision_id IS NULL
     OR effective.assignment_hash IS NULL THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'schedule_job_id',job.id,
    'source_revision',(job.input_snapshot->>'source_revision')::integer,
    'selected_recommendation_id',format_evidence->>'selected_recommendation_id',
    'format_revision_id',applied_format.format_revision_id,
    'format_definition_hash',applied_format.definition_hash,
    'capacity_revision',(canonical_capacity->>'revision')::integer,
    'settings_references',phase4_setup_settings_reference_values(canonical_settings),
    'selected_result_revision',option_row.result_revision,
    'selected_result_hash',effective.assignment_hash,
    'objective',job.objective,
    'schedule_revision_id',effective.id,
    'feasibility','valid'
  );
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase4_derive_setup_publication_reference(
  target_competition uuid,
  canonical_capacity jsonb,
  canonical_settings jsonb,
  schedule_evidence jsonb
) RETURNS jsonb AS $$
BEGIN
  IF schedule_evidence IS NULL OR schedule_evidence='null'::jsonb
     OR NOT EXISTS (
       SELECT 1
       FROM schedule_revisions revision
       JOIN competition_publications publication
         ON publication.competition_id=revision.competition_id
        AND publication.published_schedule_revision_id=revision.id
       WHERE revision.id=(schedule_evidence->>'schedule_revision_id')::uuid
         AND revision.competition_id=target_competition
         AND revision.status='published'
         AND revision.assignment_hash=schedule_evidence->>'selected_result_hash'
     ) THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'selected_format_revision_id',schedule_evidence->>'format_revision_id',
    'selected_schedule_result_hash',schedule_evidence->>'selected_result_hash',
    'capacity_revision',(canonical_capacity->>'revision')::integer,
    'settings_references',phase4_setup_settings_reference_values(canonical_settings),
    'acknowledged_warning_codes','[]'::jsonb,
    'publication_status','published',
    'published_schedule_revision_id',schedule_evidence->>'schedule_revision_id'
  );
EXCEPTION WHEN others THEN
  RETURN NULL;
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
  derived_schedule jsonb;
  derived_publication jsonb;
  capacity_changed boolean;
  capacity_inputs_changed boolean;
  settings_changed boolean;
  entries_changed boolean;
  format_stale boolean;
  schedule_changed boolean;
  publication_changed boolean;
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
  capacity_inputs_changed:=phase4_setup_capacity_inputs_changed(
    draft.steps->'capacity',seeded->'capacity'
  );
  settings_changed:=draft.steps->'settings' IS DISTINCT FROM seeded->'settings';
  entries_changed:=draft.steps->'entries' IS DISTINCT FROM seeded->'entries';
  format_stale:=capacity_inputs_changed OR settings_changed OR entries_changed
    OR phase4_setup_format_evidence_stale(target_competition,draft.steps->'format_recommendations');

  IF NOT format_stale THEN
    derived_schedule:=phase4_derive_setup_schedule_reference(
      target_competition,seeded->'capacity',seeded->'settings',
      draft.steps->'format_recommendations'
    );
    derived_publication:=phase4_derive_setup_publication_reference(
      target_competition,seeded->'capacity',seeded->'settings',derived_schedule
    );
  END IF;
  schedule_changed:=draft.steps->'schedule_review'
    IS DISTINCT FROM COALESCE(derived_schedule,'null'::jsonb);
  publication_changed:=draft.steps->'review_publish'
    IS DISTINCT FROM COALESCE(derived_publication,'null'::jsonb);

  IF NOT capacity_changed AND NOT settings_changed AND NOT entries_changed
     AND NOT format_stale AND NOT schedule_changed AND NOT publication_changed THEN
    RETURN to_jsonb(draft);
  END IF;

  next_steps:=draft.steps;
  IF capacity_changed THEN next_steps:=jsonb_set(next_steps,'{capacity}',seeded->'capacity',true); END IF;
  IF settings_changed THEN next_steps:=jsonb_set(next_steps,'{settings}',seeded->'settings',true); END IF;
  IF entries_changed THEN next_steps:=jsonb_set(next_steps,'{entries}',seeded->'entries',true); END IF;
  IF format_stale THEN next_steps:=jsonb_set(next_steps,'{format_recommendations}','null'::jsonb,true); END IF;
  IF schedule_changed THEN
    next_steps:=jsonb_set(next_steps,'{schedule_review}',COALESCE(derived_schedule,'null'::jsonb),true);
  END IF;
  IF publication_changed THEN
    next_steps:=jsonb_set(next_steps,'{review_publish}',COALESCE(derived_publication,'null'::jsonb),true);
  END IF;

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
    WHEN 'schedule_review' THEN derived_schedule IS NOT NULL
    WHEN 'review_publish' THEN derived_publication IS NOT NULL
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
    WHEN derived_schedule IS NULL AND draft.current_step IN ('schedule_review','review_publish') THEN 'schedule_review'
    WHEN derived_publication IS NULL AND draft.current_step='review_publish' THEN 'review_publish'
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
      'capacity_changed',capacity_changed,'capacity_inputs_changed',capacity_inputs_changed,
      'settings_changed',settings_changed,'entries_changed',entries_changed,
      'format_invalidated',format_stale,'schedule_changed',schedule_changed,'publication_changed',publication_changed
    ));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('setup_draft',draft.id::text,'setup.references.refreshed',
    jsonb_build_object('competition_id',target_competition,'revision',draft.revision,'current_step',draft.current_step),
    'phase4:setup-reference-refresh:'||draft.id::text||':'||draft.revision::text)
  ON CONFLICT(idempotency_key) DO NOTHING;
  RETURN to_jsonb(draft);
END;
$$ LANGUAGE plpgsql;
