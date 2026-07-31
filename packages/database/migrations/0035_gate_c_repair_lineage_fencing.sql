-- Close direct-write and public-lineage gaps in the C4 diagnostic ledger.

CREATE OR REPLACE FUNCTION gate_c_guard_schedule_repair_revision_insert() RETURNS trigger AS $$
DECLARE
  expected_revision integer;
  parent_revision schedule_repair_revisions%ROWTYPE;
  repair_case schedule_repair_cases%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('gate-c:repair-case:' || NEW.repair_case_id::text, 0));
  SELECT * INTO repair_case FROM schedule_repair_cases WHERE id=NEW.repair_case_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'repair case does not exist'; END IF;
  IF NEW.competition_id<>repair_case.competition_id
     OR NEW.source_result_version<>repair_case.source_result_version
     OR NEW.source_schedule_version<>repair_case.source_schedule_version
     OR NEW.source_projection_version<>repair_case.source_projection_version
     OR NEW.analysis_fingerprint<>repair_case.analysis_fingerprint THEN
    RAISE EXCEPTION 'repair revision source metadata must match its immutable repair case';
  END IF;
  SELECT COALESCE(max(revision), 0) + 1 INTO expected_revision
  FROM schedule_repair_revisions WHERE repair_case_id=NEW.repair_case_id;
  IF NEW.revision<>expected_revision THEN RAISE EXCEPTION 'repair revision must be contiguous'; END IF;
  IF expected_revision=1 AND NEW.parent_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'first repair revision cannot have a parent';
  END IF;
  IF expected_revision>1 THEN
    SELECT * INTO parent_revision FROM schedule_repair_revisions
    WHERE id=NEW.parent_revision_id AND repair_case_id=NEW.repair_case_id;
    IF NOT FOUND OR parent_revision.revision<>expected_revision-1 THEN
      RAISE EXCEPTION 'repair revision parent must be the immediately preceding revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION gate_c_guard_public_projection_repair_lineage() RETURNS trigger AS $$
DECLARE source_division_id uuid;
BEGIN
  IF NEW.source_repair_revision_id IS NULL THEN RETURN NEW; END IF;
  SELECT repair_case.corrected_division_id INTO source_division_id
  FROM schedule_repair_revisions revision
  JOIN schedule_repair_cases repair_case ON repair_case.id=revision.repair_case_id
  WHERE revision.id=NEW.source_repair_revision_id AND revision.competition_id=NEW.competition_id;
  IF NOT FOUND OR source_division_id<>NEW.division_id THEN
    RAISE EXCEPTION 'public projection repair source must belong to the same competition and division';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER public_projection_versions_repair_lineage_guard
BEFORE INSERT OR UPDATE ON public_projection_versions
FOR EACH ROW EXECUTE FUNCTION gate_c_guard_public_projection_repair_lineage();

CREATE FUNCTION gate_c_guard_repair_publication_projection_lineage() RETURNS trigger AS $$
DECLARE receipt_revision_id uuid; projection_revision_id uuid;
BEGIN
  SELECT repair_revision_id INTO receipt_revision_id
  FROM schedule_repair_publication_receipts
  WHERE id=NEW.publication_receipt_id AND competition_id=NEW.competition_id;
  SELECT source_repair_revision_id INTO projection_revision_id
  FROM public_projection_versions
  WHERE id=NEW.public_projection_version_id
    AND competition_id=NEW.competition_id
    AND division_id=NEW.division_id;
  IF NOT FOUND OR projection_revision_id IS NULL OR receipt_revision_id<>projection_revision_id THEN
    RAISE EXCEPTION 'publication projection must derive from the receipt repair revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_repair_publication_projection_lineage_guard
BEFORE INSERT OR UPDATE ON schedule_repair_publication_projection_versions
FOR EACH ROW EXECUTE FUNCTION gate_c_guard_repair_publication_projection_lineage();
