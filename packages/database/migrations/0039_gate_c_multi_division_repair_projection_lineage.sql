-- Gate C4 repair cases can affect transitive descendants outside the corrected
-- match's division. Public projection lineage therefore permits the corrected
-- division and any additional division explicitly retained by an action in the
-- immutable repair revision. Unrelated divisions remain rejected.

CREATE OR REPLACE FUNCTION gate_c_guard_public_projection_repair_lineage() RETURNS trigger AS $$
DECLARE
  corrected_division_id uuid;
  affected boolean;
BEGIN
  IF NEW.source_repair_revision_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT repair_case.corrected_division_id INTO corrected_division_id
  FROM schedule_repair_revisions revision
  JOIN schedule_repair_cases repair_case ON repair_case.id=revision.repair_case_id
  WHERE revision.id=NEW.source_repair_revision_id
    AND revision.competition_id=NEW.competition_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'public projection repair source must belong to the same competition';
  END IF;

  SELECT EXISTS(
    SELECT 1
    FROM schedule_repair_actions action
    WHERE action.repair_revision_id=NEW.source_repair_revision_id
      AND action.competition_id=NEW.competition_id
      AND action.division_id=NEW.division_id
  ) INTO affected;

  IF NEW.division_id<>corrected_division_id AND NOT affected THEN
    RAISE EXCEPTION 'public projection repair source division is not affected by the retained repair revision';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
