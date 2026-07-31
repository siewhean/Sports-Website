-- Gate C4 requires every committed correction to own a private repair case in
-- the same transaction. Detailed affected-match analysis remains an immutable
-- child of this result-level intake so no public correction can be orphaned.

CREATE TABLE result_repair_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL,
  corrected_match_id uuid NOT NULL,
  correction_transaction_id uuid NOT NULL,
  source_result_version integer NOT NULL CHECK (source_result_version > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, competition_id),
  UNIQUE (correction_transaction_id),
  UNIQUE (competition_id, corrected_match_id, source_result_version),
  FOREIGN KEY (division_id, competition_id)
    REFERENCES divisions(id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (corrected_match_id, competition_id, division_id)
    REFERENCES matches(id, competition_id, division_id) ON DELETE RESTRICT,
  FOREIGN KEY (correction_transaction_id, competition_id, division_id, corrected_match_id)
    REFERENCES score_correction_transactions(id, competition_id, division_id, match_id) ON DELETE RESTRICT
);

CREATE TABLE result_repair_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_repair_case_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'analysis_ready', 'published', 'superseded')),
  schedule_repair_case_id uuid,
  repair_revision_id uuid,
  actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  UNIQUE NULLS NOT DISTINCT (
    result_repair_case_id,event_type,schedule_repair_case_id,repair_revision_id
  ),
  FOREIGN KEY (result_repair_case_id, competition_id)
    REFERENCES result_repair_cases(id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (schedule_repair_case_id, competition_id)
    REFERENCES schedule_repair_cases(id, competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (repair_revision_id, competition_id)
    REFERENCES schedule_repair_revisions(id, competition_id) ON DELETE RESTRICT,
  CHECK (
    (event_type='created' AND schedule_repair_case_id IS NULL AND repair_revision_id IS NULL)
    OR (event_type='analysis_ready' AND schedule_repair_case_id IS NOT NULL AND repair_revision_id IS NULL)
    OR (event_type='published' AND schedule_repair_case_id IS NOT NULL AND repair_revision_id IS NOT NULL)
    OR event_type='superseded'
  )
);

ALTER TABLE schedule_repair_cases
  ADD COLUMN result_repair_case_id uuid;

-- Backfill the result-level case for every historical correction before
-- enforcing the new non-null relationship.
INSERT INTO result_repair_cases(
  competition_id,division_id,corrected_match_id,correction_transaction_id,
  source_result_version,created_by_account_id,created_at
)
SELECT correction.competition_id,correction.division_id,correction.match_id,correction.id,
       correction.result_version,correction.actor_account_id,correction.created_at
FROM score_correction_transactions correction
ON CONFLICT(correction_transaction_id) DO NOTHING;

UPDATE schedule_repair_cases repair
SET result_repair_case_id=result_case.id
FROM result_repair_cases result_case
WHERE result_case.correction_transaction_id=repair.correction_transaction_id
  AND repair.result_repair_case_id IS NULL;

ALTER TABLE schedule_repair_cases
  ALTER COLUMN result_repair_case_id SET NOT NULL,
  ADD CONSTRAINT schedule_repair_cases_result_case_unique UNIQUE(result_repair_case_id),
  ADD CONSTRAINT schedule_repair_cases_result_case_fk
    FOREIGN KEY (result_repair_case_id,competition_id)
    REFERENCES result_repair_cases(id,competition_id) ON DELETE RESTRICT;

INSERT INTO result_repair_case_events(
  result_repair_case_id,competition_id,event_type,actor_account_id,occurred_at,metadata
)
SELECT result_case.id,result_case.competition_id,'created',result_case.created_by_account_id,
       result_case.created_at,
       jsonb_build_object(
         'correction_transaction_id',result_case.correction_transaction_id,
         'corrected_match_id',result_case.corrected_match_id,
         'source_result_version',result_case.source_result_version,
         'backfilled',true
       )
FROM result_repair_cases result_case
ON CONFLICT DO NOTHING;

INSERT INTO result_repair_case_events(
  result_repair_case_id,competition_id,event_type,schedule_repair_case_id,
  actor_account_id,occurred_at,metadata
)
SELECT repair.result_repair_case_id,repair.competition_id,'analysis_ready',repair.id,
       repair.created_by_account_id,repair.created_at,
       jsonb_build_object('analysis_fingerprint',repair.analysis_fingerprint,'backfilled',true)
FROM schedule_repair_cases repair
ON CONFLICT DO NOTHING;

INSERT INTO result_repair_case_events(
  result_repair_case_id,competition_id,event_type,schedule_repair_case_id,
  repair_revision_id,actor_account_id,occurred_at,metadata
)
SELECT repair.result_repair_case_id,receipt.competition_id,'published',repair.id,
       receipt.repair_revision_id,receipt.published_by_account_id,receipt.published_at,
       jsonb_build_object(
         'schedule_version',receipt.schedule_version,
         'result_version',receipt.result_version,
         'analysis_fingerprint',receipt.analysis_fingerprint,
         'backfilled',true
       )
FROM schedule_repair_publication_receipts receipt
JOIN schedule_repair_cases repair ON repair.id=receipt.repair_case_id
ON CONFLICT DO NOTHING;

CREATE FUNCTION gate_c_create_result_repair_case() RETURNS trigger AS $$
DECLARE
  result_case result_repair_cases%ROWTYPE;
  organisation_id_value uuid;
BEGIN
  INSERT INTO result_repair_cases(
    competition_id,division_id,corrected_match_id,correction_transaction_id,
    source_result_version,created_by_account_id,created_at
  ) VALUES(
    NEW.competition_id,NEW.division_id,NEW.match_id,NEW.id,
    NEW.result_version,NEW.actor_account_id,NEW.created_at
  )
  RETURNING * INTO result_case;

  INSERT INTO result_repair_case_events(
    result_repair_case_id,competition_id,event_type,actor_account_id,occurred_at,metadata
  ) VALUES(
    result_case.id,result_case.competition_id,'created',result_case.created_by_account_id,
    result_case.created_at,
    jsonb_build_object(
      'correction_transaction_id',result_case.correction_transaction_id,
      'corrected_match_id',result_case.corrected_match_id,
      'source_result_version',result_case.source_result_version
    )
  );

  SELECT organisation_id INTO STRICT organisation_id_value
  FROM competitions WHERE id=NEW.competition_id;

  INSERT INTO audit_events(
    occurred_at,request_id,actor_account_id,actor_type,organisation_id,
    action,target_type,target_id,after_state,metadata
  ) VALUES(
    result_case.created_at,
    'correction-repair-case:'||NEW.id::text,
    NEW.actor_account_id,'account',organisation_id_value,
    'result_repair_case.created','result_repair_case',result_case.id::text,
    jsonb_build_object(
      'correction_transaction_id',NEW.id,
      'corrected_match_id',NEW.match_id,
      'result_version',NEW.result_version
    ),
    jsonb_build_object('competition_id',NEW.competition_id,'division_id',NEW.division_id)
  );

  INSERT INTO outbox_events(
    aggregate_type,aggregate_id,event_type,payload,idempotency_key,created_at,available_at
  ) VALUES(
    'result_repair_case',result_case.id::text,'result_repair_case.created',
    jsonb_build_object(
      'competition_id',NEW.competition_id,
      'division_id',NEW.division_id,
      'corrected_match_id',NEW.match_id,
      'correction_transaction_id',NEW.id,
      'source_result_version',NEW.result_version
    ),
    'result_repair_case.created:'||result_case.id::text,
    result_case.created_at,result_case.created_at
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER score_correction_transactions_create_repair_case
AFTER INSERT ON score_correction_transactions
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION gate_c_create_result_repair_case();

CREATE FUNCTION gate_c_link_schedule_repair_analysis() RETURNS trigger AS $$
DECLARE
  result_case_id_value uuid;
BEGIN
  SELECT id INTO STRICT result_case_id_value
  FROM result_repair_cases
  WHERE correction_transaction_id=NEW.correction_transaction_id
  FOR KEY SHARE;

  IF NEW.result_repair_case_id<>result_case_id_value THEN
    RAISE EXCEPTION 'schedule repair case does not match its result repair case';
  END IF;

  INSERT INTO result_repair_case_events(
    result_repair_case_id,competition_id,event_type,schedule_repair_case_id,
    actor_account_id,occurred_at,metadata
  ) VALUES(
    result_case_id_value,NEW.competition_id,'analysis_ready',NEW.id,
    NEW.created_by_account_id,NEW.created_at,
    jsonb_build_object(
      'analysis_fingerprint',NEW.analysis_fingerprint,
      'source_schedule_version',NEW.source_schedule_version,
      'source_projection_version',NEW.source_projection_version
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_repair_cases_link_result_case
AFTER INSERT ON schedule_repair_cases
FOR EACH ROW EXECUTE FUNCTION gate_c_link_schedule_repair_analysis();

CREATE FUNCTION gate_c_record_repair_publication_event() RETURNS trigger AS $$
DECLARE
  result_case_id_value uuid;
BEGIN
  SELECT result_repair_case_id INTO STRICT result_case_id_value
  FROM schedule_repair_cases WHERE id=NEW.repair_case_id;

  INSERT INTO result_repair_case_events(
    result_repair_case_id,competition_id,event_type,schedule_repair_case_id,
    repair_revision_id,actor_account_id,occurred_at,metadata
  ) VALUES(
    result_case_id_value,NEW.competition_id,'published',NEW.repair_case_id,
    NEW.repair_revision_id,NEW.published_by_account_id,NEW.published_at,
    jsonb_build_object(
      'schedule_version',NEW.schedule_version,
      'result_version',NEW.result_version,
      'analysis_fingerprint',NEW.analysis_fingerprint
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_repair_publication_receipts_record_result_case_event
AFTER INSERT ON schedule_repair_publication_receipts
FOR EACH ROW EXECUTE FUNCTION gate_c_record_repair_publication_event();

CREATE FUNCTION gate_c_prevent_result_repair_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Gate C4 result repair facts are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER result_repair_cases_no_update_or_delete
BEFORE UPDATE OR DELETE ON result_repair_cases
FOR EACH ROW EXECUTE FUNCTION gate_c_prevent_result_repair_mutation();

CREATE TRIGGER result_repair_case_events_no_update_or_delete
BEFORE UPDATE OR DELETE ON result_repair_case_events
FOR EACH ROW EXECUTE FUNCTION gate_c_prevent_result_repair_mutation();
