-- Assisted Setup advances directly from recommendation selection to schedule
-- review. The exact selected format for every division must therefore be
-- materialised and selected in the same transaction as the setup mutation.

CREATE FUNCTION phase4_publish_setup_selected_formats() RETURNS trigger AS $$
DECLARE
  selection jsonb;
  selected_id text;
  selected_candidate jsonb;
  format_item jsonb;
  selected_candidate_uuid uuid;
  selected_candidate_division_uuid uuid;
  selected_revision_uuid uuid;
  evidence_division_uuid uuid;
  evidence_definition_hash text;
  revision_row format_revisions%ROWTYPE;
  audit_request_id text;
BEGIN
  selection := NEW.steps->'format_recommendations';
  IF selection IS NULL OR jsonb_typeof(selection)<>'object' THEN RETURN NEW; END IF;
  selected_id := selection->>'selected_recommendation_id';
  IF selected_id IS NULL OR btrim(selected_id)='' THEN RETURN NEW; END IF;
  IF jsonb_typeof(selection->'recommendation_set_hash')<>'string'
     OR selection->>'recommendation_set_hash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'selected setup recommendation has invalid set evidence';
  END IF;
  selected_candidate_uuid := selected_id::uuid;

  SELECT candidate.value INTO selected_candidate
  FROM jsonb_array_elements(COALESCE(selection->'recommendations','[]'::jsonb)) candidate(value)
  WHERE candidate.value->>'id'=selected_id
  LIMIT 1;

  IF selected_candidate IS NULL
     AND selection->'requires_changes' IS NOT NULL
     AND selection->'requires_changes'<>'null'::jsonb
     AND selection->'requires_changes'->>'id'=selected_id THEN
    selected_candidate := selection->'requires_changes';
  END IF;

  IF selected_candidate IS NULL THEN
    RAISE EXCEPTION 'selected setup recommendation is not present in canonical evidence';
  END IF;
  IF jsonb_typeof(selected_candidate->'division_formats')<>'array'
     OR jsonb_array_length(selected_candidate->'division_formats')=0 THEN
    RAISE EXCEPTION 'selected setup recommendation has no division formats';
  END IF;
  IF (SELECT count(*)<>count(DISTINCT item.value->>'division_id')
      FROM jsonb_array_elements(selected_candidate->'division_formats') item(value))
     OR jsonb_array_length(selected_candidate->'division_formats')<>
        (SELECT count(*) FROM divisions WHERE competition_id=NEW.competition_id) THEN
    RAISE EXCEPTION 'selected setup recommendation must cover each division exactly once';
  END IF;

  FOR format_item IN SELECT value FROM jsonb_array_elements(selected_candidate->'division_formats') item(value) LOOP
    IF jsonb_typeof(format_item)<>'object'
       OR jsonb_typeof(format_item->'division_id')<>'string'
       OR jsonb_typeof(format_item->'candidate_division_id')<>'string'
       OR format_item->'format_revision_id' IS NULL
       OR format_item->'format_revision_id'='null'::jsonb
       OR jsonb_typeof(format_item->'format_revision_id')<>'string'
       OR jsonb_typeof(format_item->'format_definition_hash')<>'string'
       OR format_item->>'format_definition_hash' !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'selected setup format must contain complete canonical evidence';
    END IF;

    selected_candidate_division_uuid := (format_item->>'candidate_division_id')::uuid;
    selected_revision_uuid := (format_item->>'format_revision_id')::uuid;
    SELECT division.division_id,division.definition_hash
      INTO evidence_division_uuid,evidence_definition_hash
    FROM phase4_format_recommendation_candidate_divisions division
    JOIN phase4_format_recommendation_candidates candidate ON candidate.id=division.candidate_id
    JOIN phase4_format_recommendation_sets recommendation_set
      ON recommendation_set.id=candidate.recommendation_set_id
    WHERE candidate.id=selected_candidate_uuid
      AND division.id=selected_candidate_division_uuid
      AND recommendation_set.setup_draft_id=NEW.id
      AND recommendation_set.competition_id=NEW.competition_id
      AND recommendation_set.source_hash=selection->>'recommendation_set_hash';
    IF evidence_division_uuid IS NULL
       OR evidence_division_uuid<>(format_item->>'division_id')::uuid
       OR evidence_definition_hash<>format_item->>'format_definition_hash' THEN
      RAISE EXCEPTION 'selected setup format does not match immutable recommendation evidence';
    END IF;

    SELECT * INTO revision_row FROM format_revisions WHERE id=selected_revision_uuid FOR UPDATE;
    IF revision_row.id IS NULL
       OR revision_row.competition_id<>NEW.competition_id
       OR revision_row.division_id<>evidence_division_uuid
       OR revision_row.definition_hash<>evidence_definition_hash THEN
      RAISE EXCEPTION 'selected setup format does not match canonical revision evidence';
    END IF;

    IF revision_row.status='draft' THEN
      audit_request_id := concat(
        'setup-format-selection:',NEW.id::text,':',NEW.revision::text,':',revision_row.id::text
      );
      PERFORM phase4_materialize_and_publish_format_revision(revision_row.id,NEW.updated_by,audit_request_id);
    ELSIF revision_row.status<>'published' THEN
      RAISE EXCEPTION 'selected setup format revision is no longer selectable';
    END IF;
  END LOOP;

  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'selected setup format contains an invalid identifier';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER zz_setup_drafts_publish_selected_formats
BEFORE INSERT OR UPDATE OF steps ON setup_drafts
FOR EACH ROW EXECUTE FUNCTION phase4_publish_setup_selected_formats();
