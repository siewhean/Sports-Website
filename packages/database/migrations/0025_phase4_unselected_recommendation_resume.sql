-- Gate B production-readiness correction: generated recommendations are valid
-- evidence before the organiser selects one. Only the selected recommendation
-- is materialised into format_revisions; unselected candidates intentionally
-- keep null format_revision_id values.

CREATE OR REPLACE FUNCTION phase4_setup_format_evidence_stale(
  target_competition uuid,
  evidence jsonb
) RETURNS boolean AS $$
DECLARE
  recommendation_set_id uuid;
  candidate jsonb;
  division_format jsonb;
  selected_id text;
  candidate_found boolean:=false;
BEGIN
  IF evidence IS NULL OR evidence='null'::jsonb THEN RETURN false; END IF;
  IF jsonb_typeof(evidence)<>'object'
     OR jsonb_typeof(evidence->'recommendations')<>'array'
     OR jsonb_array_length(evidence->'recommendations') NOT BETWEEN 1 AND 3
     OR NOT evidence ? 'requires_changes'
     OR jsonb_typeof(evidence->'requires_changes') NOT IN ('object','null')
     OR NOT evidence ? 'selected_recommendation_id'
     OR jsonb_typeof(evidence->'selected_recommendation_id') NOT IN ('string','null')
     OR (jsonb_typeof(evidence->'selected_recommendation_id')='string'
       AND btrim(evidence->>'selected_recommendation_id')='')
     OR NOT evidence ? 'recommendation_set_hash'
     OR jsonb_typeof(evidence->'recommendation_set_hash')<>'string'
     OR evidence->>'recommendation_set_hash' !~ '^[0-9a-f]{64}$' THEN
    RETURN true;
  END IF;

  SELECT recommendation_set.id INTO recommendation_set_id
  FROM phase4_format_recommendation_sets recommendation_set
  WHERE recommendation_set.competition_id=target_competition
    AND recommendation_set.source_hash=evidence->>'recommendation_set_hash';
  IF recommendation_set_id IS NULL THEN RETURN true; END IF;

  selected_id:=evidence->>'selected_recommendation_id';
  FOR candidate IN
    SELECT value FROM jsonb_array_elements(evidence->'recommendations')
    UNION ALL
    SELECT evidence->'requires_changes'
    WHERE jsonb_typeof(evidence->'requires_changes')='object'
  LOOP
    IF jsonb_typeof(candidate)<>'object'
       OR NOT (candidate ?& ARRAY[
         'id','format_revision_id','format_definition_hash','name','structure','advantage',
         'match_count','minimum_matches_per_entry','guaranteed_matches','ranking_coverage',
         'available_match_slots','division_formats','capacity_status','scheduling_status','warning_codes'
       ])
       OR jsonb_typeof(candidate->'division_formats')<>'array'
       OR jsonb_array_length(candidate->'division_formats')<1
       OR NOT EXISTS (
         SELECT 1
         FROM phase4_format_recommendation_candidates stored_candidate
         WHERE stored_candidate.id=(candidate->>'id')::uuid
           AND stored_candidate.recommendation_set_id=recommendation_set_id
           AND stored_candidate.aggregate_metrics->>'name'=candidate->>'name'
           AND stored_candidate.aggregate_metrics->>'structure'=candidate->>'structure'
           AND stored_candidate.aggregate_metrics->>'advantage'=candidate->>'advantage'
           AND (stored_candidate.aggregate_metrics->>'match_count')::integer=(candidate->>'match_count')::integer
           AND (stored_candidate.aggregate_metrics->>'guaranteed_matches')::integer=(candidate->>'guaranteed_matches')::integer
           AND stored_candidate.aggregate_metrics->>'ranking_coverage'=candidate->>'ranking_coverage'
           AND (stored_candidate.aggregate_metrics->>'available_match_slots')::integer=(candidate->>'available_match_slots')::integer
           AND stored_candidate.aggregate_metrics->>'capacity_status'=candidate->>'capacity_status'
           AND stored_candidate.aggregate_metrics->>'scheduling_status'=candidate->>'scheduling_status'
           AND stored_candidate.aggregate_metrics->'warning_codes'=candidate->'warning_codes'
       ) THEN
      RETURN true;
    END IF;

    IF candidate->>'id'=selected_id THEN candidate_found:=true; END IF;

    FOR division_format IN SELECT value FROM jsonb_array_elements(candidate->'division_formats') LOOP
      IF jsonb_typeof(division_format)<>'object'
         OR NOT (division_format ?& ARRAY[
           'division_id','candidate_division_id','format_revision_id','format_definition_hash',
           'match_count','guaranteed_matches','ranking_coverage'
         ])
         OR NOT EXISTS (
           SELECT 1
           FROM phase4_format_recommendation_candidate_divisions stored_division
           WHERE stored_division.id=(division_format->>'candidate_division_id')::uuid
             AND stored_division.candidate_id=(candidate->>'id')::uuid
             AND stored_division.division_id=(division_format->>'division_id')::uuid
             AND stored_division.definition_hash=division_format->>'format_definition_hash'
             AND (stored_division.metrics->>'match_count')::integer=(division_format->>'match_count')::integer
             AND (stored_division.metrics->>'guaranteed_matches')::integer=(division_format->>'guaranteed_matches')::integer
             AND stored_division.metrics->>'ranking_coverage'=division_format->>'ranking_coverage'
         ) THEN
        RETURN true;
      END IF;

      IF division_format->'format_revision_id' IS NULL
         OR division_format->'format_revision_id'='null'::jsonb THEN
        -- Null is the expected state before selection. Once selected, every
        -- division must point to the exact applied immutable revision.
        IF candidate->>'id'=selected_id THEN RETURN true; END IF;
      ELSIF NOT EXISTS (
        SELECT 1
        FROM format_revisions revision
        WHERE revision.id=(division_format->>'format_revision_id')::uuid
          AND revision.competition_id=target_competition
          AND revision.division_id=(division_format->>'division_id')::uuid
          AND revision.definition_hash=division_format->>'format_definition_hash'
          AND revision.status<>'superseded'
      ) THEN
        RETURN true;
      END IF;
    END LOOP;

    IF candidate->>'id'=selected_id THEN
      IF candidate->'format_revision_id' IS NULL OR candidate->'format_revision_id'='null'::jsonb THEN RETURN true; END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(candidate->'division_formats') item
        WHERE item->>'format_revision_id'=candidate->>'format_revision_id'
      ) THEN RETURN true; END IF;
    ELSIF candidate->'format_revision_id' IS NOT NULL AND candidate->'format_revision_id'<>'null'::jsonb THEN
      RETURN true;
    END IF;
  END LOOP;

  IF selected_id IS NOT NULL AND NOT candidate_found THEN RETURN true; END IF;
  RETURN false;
EXCEPTION WHEN others THEN
  RETURN true;
END;
$$ LANGUAGE plpgsql STABLE;
