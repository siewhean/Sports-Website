-- Gate B production-readiness correction: the solver option result hash and the
-- accepted schedule revision assignment hash identify different objects. The
-- Assisted Setup contract pins the accepted assignment hash, so resume must
-- validate it against schedule_revisions rather than schedule_generation_options.

CREATE OR REPLACE FUNCTION phase4_setup_schedule_evidence_stale(
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
     OR format_evidence IS NULL OR format_evidence='null'::jsonb
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
       JOIN schedule_revisions revision
         ON revision.id=(evidence->>'schedule_revision_id')::uuid
        AND revision.source_job_id=job.id
        AND revision.source_option_id=option.id
        AND revision.status IN ('ready_for_review','published')
        AND revision.assignment_hash=evidence->>'selected_result_hash'
       JOIN format_revisions format
         ON format.id=(evidence->>'format_revision_id')::uuid
        AND format.competition_id=target_competition
        AND format.definition_hash=evidence->>'format_definition_hash'
       WHERE job.id=(evidence->>'schedule_job_id')::uuid
         AND job.competition_id=target_competition
         AND (job.input_snapshot->>'source_revision')::integer=(evidence->>'source_revision')::integer
     ) THEN
    RETURN true;
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
       JOIN format_revisions format
         ON format.id=(evidence->>'selected_format_revision_id')::uuid
        AND format.competition_id=target_competition
        AND format.definition_hash=schedule_evidence->>'format_definition_hash'
       WHERE revision.competition_id=target_competition
         AND revision.id=(schedule_evidence->>'schedule_revision_id')::uuid
         AND revision.assignment_hash=evidence->>'selected_schedule_result_hash'
         AND revision.status IN ('ready_for_review','published')
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
     ) THEN
    RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN
  RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;
