-- Gate C4 repair persistence is append-only. This migration deliberately
-- introduces a division-scoped public-truth ledger instead of changing the
-- historical competition-wide public_competition_projections table.

ALTER TABLE score_correction_transactions
  ADD CONSTRAINT score_correction_transactions_identity_key
  UNIQUE (id, competition_id, division_id, match_id);

CREATE TABLE schedule_repair_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  corrected_division_id uuid NOT NULL,
  corrected_match_id uuid NOT NULL,
  correction_transaction_id uuid NOT NULL,
  source_result_version integer NOT NULL CHECK (source_result_version > 0),
  source_schedule_version integer NOT NULL CHECK (source_schedule_version >= 0),
  source_projection_version integer NOT NULL CHECK (source_projection_version >= 0),
  analysis_fingerprint text NOT NULL CHECK (analysis_fingerprint ~ '^[0-9a-f]{64}$'),
  analysis_fingerprint_input text NOT NULL CHECK (length(btrim(analysis_fingerprint_input)) > 1),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, competition_id),
  UNIQUE (competition_id, corrected_match_id, source_result_version),
  FOREIGN KEY (corrected_division_id, competition_id)
    REFERENCES divisions(id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (corrected_match_id, competition_id, corrected_division_id)
    REFERENCES matches(id, competition_id, division_id) ON DELETE RESTRICT,
  FOREIGN KEY (correction_transaction_id, competition_id, corrected_division_id, corrected_match_id)
    REFERENCES score_correction_transactions(id, competition_id, division_id, match_id) ON DELETE RESTRICT
);

CREATE TABLE schedule_repair_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_case_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  parent_revision_id uuid,
  status text NOT NULL CHECK (status IN ('draft', 'ready', 'published', 'abandoned')),
  source_result_version integer NOT NULL CHECK (source_result_version > 0),
  source_schedule_version integer NOT NULL CHECK (source_schedule_version >= 0),
  source_projection_version integer NOT NULL CHECK (source_projection_version >= 0),
  analysis_fingerprint text NOT NULL CHECK (analysis_fingerprint ~ '^[0-9a-f]{64}$'),
  publication_fingerprint text CHECK (publication_fingerprint IS NULL OR publication_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repair_case_id, revision),
  UNIQUE (id, repair_case_id),
  UNIQUE (id, competition_id),
  UNIQUE (id, repair_case_id, competition_id),
  FOREIGN KEY (repair_case_id, competition_id)
    REFERENCES schedule_repair_cases(id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_revision_id, repair_case_id)
    REFERENCES schedule_repair_revisions(id, repair_case_id) ON DELETE RESTRICT,
  CHECK (
    (revision = 1 AND parent_revision_id IS NULL)
    OR (revision > 1 AND parent_revision_id IS NOT NULL)
  ),
  CHECK ((status = 'ready' AND publication_fingerprint IS NOT NULL) OR status <> 'ready')
);

CREATE TABLE schedule_repair_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_revision_id uuid NOT NULL,
  repair_case_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  match_id uuid NOT NULL,
  division_id uuid NOT NULL,
  slot text NOT NULL CHECK (slot IN ('home', 'away')),
  source_action text NOT NULL CHECK (
    source_action IN (
      'no_change', 'automatic_update', 'protected_started_match',
      'protected_finalised_match', 'protected_manual_slot',
      'requires_organiser_decision'
    )
  ),
  current_entry_id uuid,
  proposed_entry_id uuid,
  dependency_path jsonb NOT NULL CHECK (jsonb_typeof(dependency_path) = 'array'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repair_revision_id, ordinal),
  UNIQUE (id, repair_revision_id, repair_case_id, competition_id, match_id, division_id, slot),
  FOREIGN KEY (repair_revision_id, repair_case_id, competition_id)
    REFERENCES schedule_repair_revisions(id, repair_case_id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (match_id, competition_id, division_id)
    REFERENCES matches(id, competition_id, division_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_entry_id, division_id)
    REFERENCES division_entries(id, division_id) ON DELETE RESTRICT,
  FOREIGN KEY (proposed_entry_id, division_id)
    REFERENCES division_entries(id, division_id) ON DELETE RESTRICT
);

CREATE TABLE schedule_repair_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_action_id uuid NOT NULL,
  repair_revision_id uuid NOT NULL,
  repair_case_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  match_id uuid NOT NULL,
  division_id uuid NOT NULL,
  slot text NOT NULL CHECK (slot IN ('home', 'away')),
  decision text NOT NULL CHECK (decision IN ('accept_proposed', 'keep_current', 'set_manual_entry', 'leave_protected')),
  selected_entry_id uuid,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  client_event_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  decided_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repair_action_id),
  UNIQUE (competition_id, client_event_id),
  FOREIGN KEY (repair_action_id, repair_revision_id, repair_case_id, competition_id, match_id, division_id, slot)
    REFERENCES schedule_repair_actions(id, repair_revision_id, repair_case_id, competition_id, match_id, division_id, slot)
    ON DELETE RESTRICT,
  FOREIGN KEY (selected_entry_id, division_id)
    REFERENCES division_entries(id, division_id) ON DELETE RESTRICT,
  CHECK (
    (decision = 'set_manual_entry' AND selected_entry_id IS NOT NULL)
    OR (decision <> 'set_manual_entry' AND selected_entry_id IS NULL)
  )
);

CREATE TABLE public_projection_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL,
  schedule_version integer NOT NULL CHECK (schedule_version >= 0),
  result_version integer NOT NULL CHECK (result_version >= 0),
  projection_version integer NOT NULL CHECK (projection_version > 0),
  schedule_revision_id uuid,
  source_repair_revision_id uuid,
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  projection_fingerprint text NOT NULL CHECK (projection_fingerprint ~ '^[0-9a-f]{64}$'),
  etag text NOT NULL CHECK (length(btrim(etag)) BETWEEN 3 AND 300),
  generated_at timestamptz NOT NULL DEFAULT now(),
  source_updated_at timestamptz NOT NULL,
  UNIQUE (id, competition_id, division_id),
  UNIQUE (competition_id, division_id, projection_version),
  UNIQUE (competition_id, division_id, schedule_version, result_version, projection_fingerprint),
  FOREIGN KEY (division_id, competition_id)
    REFERENCES divisions(id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (schedule_revision_id, competition_id)
    REFERENCES schedule_revisions(id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_repair_revision_id, competition_id)
    REFERENCES schedule_repair_revisions(id, competition_id) ON DELETE RESTRICT,
  CHECK (generated_at >= source_updated_at)
);

CREATE TABLE schedule_repair_publication_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  repair_case_id uuid NOT NULL,
  repair_revision_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,200}$'),
  schedule_revision_id uuid NOT NULL,
  schedule_version integer NOT NULL CHECK (schedule_version > 0),
  result_version integer NOT NULL CHECK (result_version > 0),
  analysis_fingerprint text NOT NULL CHECK (analysis_fingerprint ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  published_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_id, idempotency_key),
  UNIQUE (repair_revision_id),
  UNIQUE (id, competition_id),
  FOREIGN KEY (repair_case_id, competition_id)
    REFERENCES schedule_repair_cases(id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (repair_revision_id, repair_case_id, competition_id)
    REFERENCES schedule_repair_revisions(id, repair_case_id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (schedule_revision_id, competition_id)
    REFERENCES schedule_revisions(id, competition_id) ON DELETE RESTRICT
);

CREATE TABLE schedule_repair_publication_projection_versions (
  publication_receipt_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  division_id uuid NOT NULL,
  public_projection_version_id uuid NOT NULL,
  PRIMARY KEY (publication_receipt_id, division_id),
  FOREIGN KEY (publication_receipt_id, competition_id)
    REFERENCES schedule_repair_publication_receipts(id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (public_projection_version_id, competition_id, division_id)
    REFERENCES public_projection_versions(id, competition_id, division_id) ON DELETE RESTRICT
);

CREATE TABLE competition_export_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid,
  export_kind text NOT NULL CHECK (
    export_kind IN (
      'schedule_a4', 'canoe_polo_score_sheet', 'badminton_score_sheet',
      'table_tennis_score_sheet', 'volleyball_score_sheet', 'basketball_score_sheet'
    )
  ),
  schedule_version integer NOT NULL CHECK (schedule_version >= 0),
  result_version integer NOT NULL CHECK (result_version >= 0),
  projection_fingerprint text NOT NULL CHECK (projection_fingerprint ~ '^[0-9a-f]{64}$'),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  safe_filename text NOT NULL CHECK (safe_filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.pdf$'),
  created_by_account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (division_id, competition_id)
    REFERENCES divisions(id, competition_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX competition_export_manifests_schedule_unique
ON competition_export_manifests(competition_id, export_kind, source_fingerprint)
WHERE division_id IS NULL;

CREATE UNIQUE INDEX competition_export_manifests_division_unique
ON competition_export_manifests(competition_id, division_id, export_kind, source_fingerprint)
WHERE division_id IS NOT NULL;

CREATE FUNCTION gate_c_append_schedule_repair_revision(
  target_repair_case_id uuid,
  expected_source_result_version integer,
  expected_source_schedule_version integer,
  expected_analysis_fingerprint text,
  parent_repair_revision_id uuid,
  next_status text,
  next_publication_fingerprint text,
  actor_account_id uuid
) RETURNS schedule_repair_revisions AS $$
DECLARE
  repair_case schedule_repair_cases%ROWTYPE;
  parent_revision schedule_repair_revisions%ROWTYPE;
  next_revision integer;
  inserted_revision schedule_repair_revisions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('gate-c:repair-case:' || target_repair_case_id::text, 0));
  SELECT * INTO repair_case FROM schedule_repair_cases WHERE id=target_repair_case_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'repair case does not exist'; END IF;
  IF repair_case.source_result_version<>expected_source_result_version
     OR repair_case.source_schedule_version<>expected_source_schedule_version
     OR repair_case.analysis_fingerprint<>expected_analysis_fingerprint THEN
    RAISE EXCEPTION 'repair case source versions or analysis fingerprint are stale';
  END IF;
  SELECT COALESCE(max(revision),0)+1 INTO next_revision
  FROM schedule_repair_revisions WHERE repair_case_id=target_repair_case_id;
  IF next_revision=1 AND parent_repair_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'first repair revision cannot have a parent';
  END IF;
  IF next_revision>1 THEN
    SELECT * INTO parent_revision FROM schedule_repair_revisions
    WHERE id=parent_repair_revision_id AND repair_case_id=target_repair_case_id;
    IF NOT FOUND OR parent_revision.revision<>next_revision-1 THEN
      RAISE EXCEPTION 'repair revision parent must be the immediately preceding revision';
    END IF;
  END IF;
  INSERT INTO schedule_repair_revisions(
    repair_case_id,competition_id,revision,parent_revision_id,status,
    source_result_version,source_schedule_version,source_projection_version,
    analysis_fingerprint,publication_fingerprint,created_by_account_id
  ) VALUES(
    repair_case.id,repair_case.competition_id,next_revision,parent_repair_revision_id,next_status,
    repair_case.source_result_version,repair_case.source_schedule_version,repair_case.source_projection_version,
    repair_case.analysis_fingerprint,next_publication_fingerprint,actor_account_id
  ) RETURNING * INTO inserted_revision;
  RETURN inserted_revision;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_repair_cases_competition_guard
BEFORE INSERT OR UPDATE OR DELETE ON schedule_repair_cases
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_repair_revisions_competition_guard
BEFORE INSERT OR UPDATE OR DELETE ON schedule_repair_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_repair_actions_competition_guard
BEFORE INSERT OR UPDATE OR DELETE ON schedule_repair_actions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_repair_decisions_competition_guard
BEFORE INSERT OR UPDATE OR DELETE ON schedule_repair_decisions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER public_projection_versions_competition_guard
BEFORE INSERT OR UPDATE OR DELETE ON public_projection_versions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_repair_publication_receipts_competition_guard
BEFORE INSERT OR UPDATE OR DELETE ON schedule_repair_publication_receipts
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_repair_publication_projection_versions_competition_guard
BEFORE INSERT OR UPDATE OR DELETE ON schedule_repair_publication_projection_versions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER competition_export_manifests_competition_guard
BEFORE INSERT OR UPDATE OR DELETE ON competition_export_manifests
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();

CREATE TRIGGER schedule_repair_cases_immutable
BEFORE UPDATE OR DELETE ON schedule_repair_cases
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
CREATE TRIGGER schedule_repair_revisions_immutable
BEFORE UPDATE OR DELETE ON schedule_repair_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
CREATE TRIGGER schedule_repair_actions_immutable
BEFORE UPDATE OR DELETE ON schedule_repair_actions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
CREATE TRIGGER schedule_repair_decisions_immutable
BEFORE UPDATE OR DELETE ON schedule_repair_decisions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
CREATE TRIGGER public_projection_versions_immutable
BEFORE UPDATE OR DELETE ON public_projection_versions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
CREATE TRIGGER schedule_repair_publication_receipts_immutable
BEFORE UPDATE OR DELETE ON schedule_repair_publication_receipts
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
CREATE TRIGGER schedule_repair_publication_projection_versions_immutable
BEFORE UPDATE OR DELETE ON schedule_repair_publication_projection_versions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
CREATE TRIGGER competition_export_manifests_immutable
BEFORE UPDATE OR DELETE ON competition_export_manifests
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();
