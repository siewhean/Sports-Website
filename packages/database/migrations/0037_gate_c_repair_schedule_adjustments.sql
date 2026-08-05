-- Gate C4 immutable time and playing-area adjustments for private repair
-- revisions. These rows remain private until their parent repair revision is
-- published through the version-fenced publication transaction.

CREATE TABLE schedule_repair_match_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_revision_id uuid NOT NULL,
  repair_case_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  match_id uuid NOT NULL,
  division_id uuid NOT NULL,
  playing_area_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  decided_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repair_revision_id, match_id),
  UNIQUE (id, repair_revision_id, repair_case_id, competition_id, match_id, division_id),
  FOREIGN KEY (repair_revision_id, repair_case_id, competition_id)
    REFERENCES schedule_repair_revisions(id, repair_case_id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (match_id, competition_id, division_id)
    REFERENCES matches(id, competition_id, division_id) ON DELETE RESTRICT,
  FOREIGN KEY (playing_area_id, competition_id)
    REFERENCES playing_areas(id, competition_id) ON DELETE RESTRICT,
  CHECK (playing_area_id IS NOT NULL OR starts_at IS NOT NULL OR ends_at IS NOT NULL),
  CHECK ((starts_at IS NULL) = (ends_at IS NULL)),
  CHECK (starts_at IS NULL OR ends_at > starts_at)
);

CREATE TRIGGER schedule_repair_match_adjustments_competition_guard
BEFORE INSERT OR UPDATE OR DELETE ON schedule_repair_match_adjustments
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();

CREATE TRIGGER schedule_repair_match_adjustments_immutable
BEFORE UPDATE OR DELETE ON schedule_repair_match_adjustments
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
