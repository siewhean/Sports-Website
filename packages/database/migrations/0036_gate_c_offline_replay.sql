-- Gate C3 durable offline scoring authority.
-- Resume verifiers are stored only as fixed-length hashes. An active authority
-- reserves its writer generation after the short writer lease has elapsed.
--
-- Historical audit and outbox values are intentionally left byte-for-byte
-- unchanged. Legacy JSONB strings are normalised only at read boundaries so
-- this migration never disables append-only guards or rewrites retained
-- evidence.

ALTER TABLE scoring_access_sessions
  ADD COLUMN reported_pending_local_sequence integer NOT NULL DEFAULT 0,
  ADD COLUMN reported_queue_fingerprint text;

ALTER TABLE scoring_access_sessions
  ADD CONSTRAINT scoring_access_sessions_offline_report_check CHECK (
    reported_pending_local_sequence >= 0
    AND (
      reported_queue_fingerprint IS NULL
      OR reported_queue_fingerprint ~ '^[0-9a-f]{64}$'
    )
  );

CREATE TABLE scoring_offline_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL,
  match_id uuid NOT NULL,
  access_pass_id uuid NOT NULL,
  access_session_id uuid NOT NULL,
  writer_generation integer NOT NULL CHECK (writer_generation > 0),
  resume_secret_hash bytea NOT NULL CHECK (octet_length(resume_secret_hash)=32),
  device_id_hash bytea NOT NULL CHECK (octet_length(device_id_hash)=32),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','revoked','transferred','completed')),
  indexeddb_schema_version integer NOT NULL DEFAULT 1
    CHECK (indexeddb_schema_version > 0),
  service_worker_version text NOT NULL DEFAULT 'gate-c-c3-v4'
    CHECK (length(btrim(service_worker_version)) BETWEEN 1 AND 100),
  issued_at timestamptz NOT NULL DEFAULT now(),
  last_authority_at timestamptz NOT NULL DEFAULT now(),
  recording_expires_at timestamptz NOT NULL,
  replay_expires_at timestamptz NOT NULL,
  last_reported_pending_count integer NOT NULL DEFAULT 0
    CHECK (last_reported_pending_count >= 0),
  last_reported_local_sequence integer NOT NULL DEFAULT 0
    CHECK (last_reported_local_sequence >= 0),
  last_reported_queue_fingerprint text
    CHECK (
      last_reported_queue_fingerprint IS NULL
      OR last_reported_queue_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  revoked_at timestamptz,
  transition_reason text,
  UNIQUE (id,match_id,competition_id),
  FOREIGN KEY (match_id,competition_id)
    REFERENCES matches(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (access_pass_id,match_id,competition_id)
    REFERENCES scoring_access_passes(id,match_id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (access_session_id,match_id,competition_id)
    REFERENCES scoring_access_sessions(id,match_id,competition_id) ON DELETE RESTRICT,
  CHECK (last_authority_at>=issued_at AND last_authority_at<=replay_expires_at),
  CHECK (recording_expires_at>issued_at),
  CHECK (recording_expires_at<=last_authority_at+interval '4 hours'),
  CHECK (replay_expires_at>=recording_expires_at),
  CHECK (replay_expires_at<=recording_expires_at+interval '15 minutes'),
  CHECK (
    (status='active' AND revoked_at IS NULL AND transition_reason IS NULL)
    OR
    (status<>'active' AND revoked_at IS NOT NULL
      AND length(btrim(transition_reason)) BETWEEN 3 AND 500)
  )
);

CREATE UNIQUE INDEX scoring_offline_authorizations_one_active_match
ON scoring_offline_authorizations(match_id)
WHERE status='active';

CREATE UNIQUE INDEX scoring_offline_authorizations_one_active_session
ON scoring_offline_authorizations(access_session_id)
WHERE status='active';

CREATE UNIQUE INDEX scoring_offline_authorizations_one_active_device
ON scoring_offline_authorizations(device_id_hash)
WHERE status='active';

CREATE INDEX scoring_offline_authorizations_expiry_idx
ON scoring_offline_authorizations(status,replay_expires_at);

CREATE FUNCTION phase5_validate_offline_authorization() RETURNS trigger AS $$
DECLARE
  session_row record;
BEGIN
  SELECT
    session.access_pass_id,
    session.competition_id,
    session.match_id,
    session.generation,
    session.mode,
    session.device_id_hash,
    access_pass.expires_at AS pass_expires_at,
    access_pass.revoked_at AS pass_revoked_at
  INTO session_row
  FROM scoring_access_sessions session
  JOIN scoring_access_passes access_pass ON access_pass.id=session.access_pass_id
  WHERE session.id=NEW.access_session_id;

  IF NOT FOUND
    OR session_row.access_pass_id<>NEW.access_pass_id
    OR session_row.competition_id<>NEW.competition_id
    OR session_row.match_id<>NEW.match_id
    OR session_row.generation IS DISTINCT FROM NEW.writer_generation
    OR session_row.device_id_hash<>NEW.device_id_hash
  THEN
    RAISE EXCEPTION 'offline authorization identity does not match its scoring session';
  END IF;

  IF NEW.status='active' AND (
    session_row.mode<>'writer'
    OR session_row.pass_revoked_at IS NOT NULL
    OR NEW.recording_expires_at>session_row.pass_expires_at
    OR NEW.replay_expires_at>session_row.pass_expires_at
  ) THEN
    RAISE EXCEPTION 'active offline authorization exceeds its writer or access-pass authority';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scoring_offline_authorizations_validation
BEFORE INSERT OR UPDATE ON scoring_offline_authorizations
FOR EACH ROW EXECUTE FUNCTION phase5_validate_offline_authorization();

CREATE FUNCTION phase5_guard_offline_authorization_transition() RETURNS trigger AS $$
BEGIN
  IF ROW(
    OLD.competition_id,OLD.match_id,OLD.access_pass_id,OLD.access_session_id,
    OLD.writer_generation,OLD.resume_secret_hash,OLD.device_id_hash,OLD.issued_at
  ) IS DISTINCT FROM ROW(
    NEW.competition_id,NEW.match_id,NEW.access_pass_id,NEW.access_session_id,
    NEW.writer_generation,NEW.resume_secret_hash,NEW.device_id_hash,NEW.issued_at
  ) THEN
    RAISE EXCEPTION 'offline authorization identity is immutable';
  END IF;

  IF OLD.status<>'active' THEN
    RAISE EXCEPTION 'terminal offline authorizations are immutable';
  END IF;

  IF NEW.status='active' AND (
    NEW.last_authority_at<OLD.last_authority_at
    OR NEW.recording_expires_at<OLD.recording_expires_at
    OR NEW.replay_expires_at<OLD.replay_expires_at
    OR NEW.last_reported_local_sequence<OLD.last_reported_local_sequence
  ) THEN
    RAISE EXCEPTION 'offline authorization renewal and queue progress are monotonic';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scoring_offline_authorizations_transition_guard
BEFORE UPDATE ON scoring_offline_authorizations
FOR EACH ROW EXECUTE FUNCTION phase5_guard_offline_authorization_transition();

CREATE TRIGGER scoring_offline_authorizations_phase3_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON scoring_offline_authorizations
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
