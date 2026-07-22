-- A caller must not publish an older review-ready schedule while a newer
-- editable revision exists. The organiser UI normally targets the latest
-- revision, but publication truth must also be enforced in PostgreSQL.

CREATE FUNCTION phase4_require_latest_schedule_publication() RETURNS trigger AS $$
BEGIN
  IF OLD.status='ready_for_review' AND NEW.status='published' AND EXISTS (
    SELECT 1
    FROM schedule_revisions newer
    WHERE newer.competition_id=OLD.competition_id
      AND newer.revision>OLD.revision
      AND newer.status IN ('draft','ready_for_review')
  ) THEN
    RAISE EXCEPTION 'schedule revision conflict: only the latest editable revision may be published';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ab_schedule_revisions_latest_publication_guard
BEFORE UPDATE OF status ON schedule_revisions
FOR EACH ROW EXECUTE FUNCTION phase4_require_latest_schedule_publication();
