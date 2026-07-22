-- Local schedule repairs are immutable descendants of an accepted solver
-- option. Preserve that exact option provenance automatically so repaired
-- revisions remain eligible for Assisted Setup review and publication.

CREATE FUNCTION phase4_inherit_schedule_option_provenance() RETURNS trigger AS $$
DECLARE parent schedule_revisions%ROWTYPE;
BEGIN
  IF NEW.parent_revision_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO parent FROM schedule_revisions WHERE id=NEW.parent_revision_id FOR SHARE;
  IF parent.id IS NULL OR parent.competition_id<>NEW.competition_id THEN
    RAISE EXCEPTION 'schedule parent revision does not exist in competition';
  END IF;

  IF NEW.source_job_id IS NULL THEN NEW.source_job_id:=parent.source_job_id; END IF;
  IF NEW.source_option_id IS NULL THEN NEW.source_option_id:=parent.source_option_id; END IF;

  IF NEW.source_job_id IS DISTINCT FROM parent.source_job_id
     OR NEW.source_option_id IS DISTINCT FROM parent.source_option_id THEN
    RAISE EXCEPTION 'repaired schedule must preserve parent solver provenance';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER aa_schedule_revisions_inherit_option_provenance
BEFORE INSERT ON schedule_revisions
FOR EACH ROW EXECUTE FUNCTION phase4_inherit_schedule_option_provenance();
