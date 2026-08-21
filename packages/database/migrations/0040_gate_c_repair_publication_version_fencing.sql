-- Gate C4 repair publication version fencing.
--
-- A projection linked to a repair publication must not merely reference the
-- same repair revision. It must also carry the exact schedule and result
-- versions acknowledged by that immutable publication receipt.
--
-- The conditional wrapper keeps historical staged-upgrade fixtures valid when
-- they deliberately remove 0033-0035 before replaying those migrations one by
-- one. Real migration chains always reach this file after the C4 tables exist.

DO $gate_c4_publication_version_fencing$
BEGIN
  IF to_regclass('schedule_repair_publication_receipts') IS NULL
     OR to_regclass('public_projection_versions') IS NULL
     OR to_regclass('schedule_repair_publication_projection_versions') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $function$
    CREATE FUNCTION gate_c_guard_repair_publication_projection_versions() RETURNS trigger AS $body$
    DECLARE
      receipt schedule_repair_publication_receipts%ROWTYPE;
      projection public_projection_versions%ROWTYPE;
    BEGIN
      SELECT * INTO receipt
      FROM schedule_repair_publication_receipts
      WHERE id=NEW.publication_receipt_id
        AND competition_id=NEW.competition_id
      FOR KEY SHARE;

      SELECT * INTO projection
      FROM public_projection_versions
      WHERE id=NEW.public_projection_version_id
        AND competition_id=NEW.competition_id
        AND division_id=NEW.division_id
      FOR KEY SHARE;

      IF receipt.id IS NULL OR projection.id IS NULL THEN
        RAISE EXCEPTION 'repair publication projection lineage is incomplete';
      END IF;

      IF projection.source_repair_revision_id IS DISTINCT FROM receipt.repair_revision_id THEN
        RAISE EXCEPTION 'repair publication projection must derive from the receipt repair revision';
      END IF;

      IF projection.schedule_version<>receipt.schedule_version
         OR projection.result_version<>receipt.result_version THEN
        RAISE EXCEPTION 'repair publication projection versions must match the receipt';
      END IF;

      RETURN NEW;
    END;
    $body$ LANGUAGE plpgsql
  $function$;

  EXECUTE $trigger$
    CREATE TRIGGER schedule_repair_publication_projection_version_guard
    BEFORE INSERT OR UPDATE ON schedule_repair_publication_projection_versions
    FOR EACH ROW EXECUTE FUNCTION gate_c_guard_repair_publication_projection_versions()
  $trigger$;
END;
$gate_c4_publication_version_fencing$;
