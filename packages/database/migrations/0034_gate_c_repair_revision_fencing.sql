-- Repair revisions are append-only and must form one contiguous chain per
-- repair case. The 0033 helper uses the same advisory lock; this trigger also
-- fences direct database writers so they cannot bypass that invariant.

CREATE FUNCTION gate_c_guard_schedule_repair_revision_insert() RETURNS trigger AS $$
DECLARE
  expected_revision integer;
  parent_revision schedule_repair_revisions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('gate-c:repair-case:' || NEW.repair_case_id::text, 0));
  SELECT COALESCE(max(revision), 0) + 1 INTO expected_revision
  FROM schedule_repair_revisions
  WHERE repair_case_id=NEW.repair_case_id;

  IF NEW.revision<>expected_revision THEN
    RAISE EXCEPTION 'repair revision must be contiguous';
  END IF;
  IF expected_revision=1 AND NEW.parent_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'first repair revision cannot have a parent';
  END IF;
  IF expected_revision>1 THEN
    SELECT * INTO parent_revision
    FROM schedule_repair_revisions
    WHERE id=NEW.parent_revision_id AND repair_case_id=NEW.repair_case_id;
    IF NOT FOUND OR parent_revision.revision<>expected_revision-1 THEN
      RAISE EXCEPTION 'repair revision parent must be the immediately preceding revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_repair_revisions_contiguous_insert
BEFORE INSERT ON schedule_repair_revisions
FOR EACH ROW EXECUTE FUNCTION gate_c_guard_schedule_repair_revision_insert();
