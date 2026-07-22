-- Gate B Item 7: accepted schedule revisions are append-only aggregates.
-- Assignment rows were already protected; apply the same rule to the
-- multi-division format provenance attached to an accepted revision.
ALTER TABLE schedule_revisions DROP CONSTRAINT schedule_revisions_source_pair_check;
ALTER TABLE schedule_revisions ADD CONSTRAINT schedule_revisions_source_pair_check CHECK (
  (source_job_id IS NULL AND source_option_id IS NULL)
  OR (source_job_id IS NOT NULL AND source_option_id IS NOT NULL)
  OR (source_job_id IS NOT NULL AND source_option_id IS NULL AND parent_revision_id IS NOT NULL)
);

CREATE FUNCTION phase4_guard_schedule_revision_format_history() RETURNS trigger AS $$
DECLARE target_revision uuid; revision_status text; prior_status text;
BEGIN
  target_revision := CASE WHEN TG_OP='DELETE' THEN OLD.schedule_revision_id ELSE NEW.schedule_revision_id END;
  IF TG_OP='UPDATE' THEN
    SELECT status INTO prior_status FROM schedule_revisions WHERE id=OLD.schedule_revision_id;
    IF prior_status IN ('ready_for_review','published','superseded','expired') THEN
      RAISE EXCEPTION 'accepted schedule revision format provenance is immutable';
    END IF;
  END IF;
  SELECT status INTO revision_status FROM schedule_revisions WHERE id=target_revision;
  -- Competition deletion may have already removed the parent through cascade.
  IF revision_status IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF revision_status IN ('ready_for_review','published','superseded','expired') THEN
    RAISE EXCEPTION 'accepted schedule revision format provenance is immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_revision_formats_phase4_immutable
BEFORE INSERT OR UPDATE OR DELETE ON schedule_revision_formats
FOR EACH ROW EXECUTE FUNCTION phase4_guard_schedule_revision_format_history();
