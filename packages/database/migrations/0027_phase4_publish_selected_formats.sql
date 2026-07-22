-- Assisted Setup advances directly from recommendation selection to schedule
-- review. The exact selected format for every division must therefore be
-- materialised and selected in the same transaction as the setup mutation.

CREATE FUNCTION phase4_publish_setup_selected_formats() RETURNS trigger AS $$
DECLARE
  selection jsonb;
  selected_id text;
  selected_candidate jsonb;
  format_item jsonb;
  revision_id uuid;
  revision_row format_revisions%ROWTYPE;
  audit_request_id text;
BEGIN
  selection := NEW.steps->'format_recommendations';
  IF selection IS NULL OR jsonb_typeof(selection)<>'object' THEN RETURN NEW; END IF;
  selected_id := selection->>'selected_recommendation_id';
  IF selected_id IS NULL OR btrim(selected_id)='' THEN RETURN NEW; END IF;

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

  FOR format_item IN SELECT value FROM jsonb_array_elements(selected_candidate->'division_formats') item(value) LOOP
    IF jsonb_typeof(format_item)<>'object'
       OR format_item->'format_revision_id' IS NULL
       OR format_item->'format_revision_id'='null'::jsonb
       OR jsonb_typeof(format_item->'format_revision_id')<>'string' THEN
      RAISE EXCEPTION 'selected setup format must reference an applied revision';
    END IF;

    revision_id := (format_item->>'format_revision_id')::uuid;
    SELECT * INTO revision_row FROM format_revisions WHERE id=revision_id FOR UPDATE;
    IF revision_row.id IS NULL
       OR revision_row.competition_id<>NEW.competition_id
       OR revision_row.division_id<>(format_item->>'division_id')::uuid
       OR revision_row.definition_hash<>format_item->>'format_definition_hash' THEN
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
