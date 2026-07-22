-- Organisers may deliberately publish a stable review-ready revision while a
-- newer repair remains private, then publish that repair later. Prevent only a
-- true rollback over a newer revision that is already public.

CREATE FUNCTION phase4_require_latest_schedule_publication() RETURNS trigger AS $$
BEGIN
  IF OLD.status='ready_for_review' AND NEW.status='published' AND EXISTS (
    SELECT 1
    FROM schedule_revisions newer
    WHERE newer.competition_id=OLD.competition_id
      AND newer.revision>OLD.revision
      AND newer.status='published'
  ) THEN
    RAISE EXCEPTION 'schedule revision conflict: cannot replace a newer published revision with an older revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ab_schedule_revisions_latest_publication_guard
BEFORE UPDATE OF status ON schedule_revisions
FOR EACH ROW EXECUTE FUNCTION phase4_require_latest_schedule_publication();
