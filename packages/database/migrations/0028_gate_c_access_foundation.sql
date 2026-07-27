-- Gate C access, lease, and organiser-approved transfer foundation.
-- Existing Phase 2 scorekeeper sessions remain valid writer sessions while
-- new viewer/candidate modes can exist without receiving a fencing generation.

ALTER TABLE scoring_access_passes
  ADD COLUMN competition_id uuid,
  ADD COLUMN issuance_idempotency_key text,
  ADD COLUMN fallback_code_rotated_at timestamptz,
  ADD COLUMN revocation_reason text;

UPDATE scoring_access_passes access_pass
SET competition_id=match.competition_id,
    scope=CASE access_pass.role
      WHEN 'viewer' THEN '["score:read"]'::jsonb
      ELSE '["score:read","score:write","score:reverse","score:finalise"]'::jsonb
    END
FROM matches match
WHERE match.id=access_pass.match_id;

ALTER TABLE scoring_access_passes
  ALTER COLUMN competition_id SET NOT NULL,
  ALTER COLUMN scope SET DEFAULT '["score:read","score:write","score:reverse","score:finalise"]'::jsonb,
  ADD CONSTRAINT scoring_access_passes_match_competition_fkey
    FOREIGN KEY (match_id,competition_id) REFERENCES matches(id,competition_id) ON DELETE CASCADE,
  ADD CONSTRAINT scoring_access_passes_role_scope_check CHECK (
    (role='viewer' AND scope='["score:read"]'::jsonb)
    OR
    (role='scorekeeper'
      AND scope='["score:read","score:write","score:reverse","score:finalise"]'::jsonb)
  ),
  ADD CONSTRAINT scoring_access_passes_id_match_competition_key
    UNIQUE (id,match_id,competition_id),
  ADD CONSTRAINT scoring_access_passes_idempotency_shape_check CHECK (
    issuance_idempotency_key IS NULL OR length(btrim(issuance_idempotency_key)) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT scoring_access_passes_rotation_shape_check CHECK (
    fallback_code_rotated_at IS NULL OR short_code_hash IS NOT NULL
  ),
  ADD CONSTRAINT scoring_access_passes_revocation_reason_shape_check CHECK (
    revocation_reason IS NULL OR length(btrim(revocation_reason)) BETWEEN 3 AND 500
  );

CREATE UNIQUE INDEX scoring_access_passes_issue_idempotency_unique
ON scoring_access_passes(competition_id,issuance_idempotency_key)
WHERE issuance_idempotency_key IS NOT NULL;

ALTER TABLE scoring_access_sessions
  ADD COLUMN competition_id uuid,
  ADD COLUMN mode text NOT NULL DEFAULT 'writer',
  ADD COLUMN device_id_hash bytea,
  ADD COLUMN device_label text,
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN last_acknowledged_sequence integer NOT NULL DEFAULT 0,
  ADD COLUMN reported_pending_event_count integer NOT NULL DEFAULT 0,
  ADD COLUMN reported_pending_through_sequence integer NOT NULL DEFAULT 0;

UPDATE scoring_access_sessions access_session
SET competition_id=match.competition_id,
    mode=CASE
      WHEN access_session.transferred_to_session_id IS NOT NULL THEN 'transferred'
      ELSE 'writer'
    END,
    device_id_hash=digest('legacy-scoring-session:' || access_session.id::text,'sha256'),
    last_heartbeat_at=access_session.issued_at
FROM matches match
WHERE match.id=access_session.match_id;

ALTER TABLE scoring_access_sessions
  ALTER COLUMN competition_id SET NOT NULL,
  ALTER COLUMN device_id_hash SET NOT NULL,
  ALTER COLUMN generation DROP NOT NULL,
  ADD CONSTRAINT scoring_access_sessions_match_competition_fkey
    FOREIGN KEY (match_id,competition_id) REFERENCES matches(id,competition_id) ON DELETE CASCADE,
  ADD CONSTRAINT scoring_access_sessions_pass_match_competition_fkey
    FOREIGN KEY (access_pass_id,match_id,competition_id)
    REFERENCES scoring_access_passes(id,match_id,competition_id) ON DELETE CASCADE,
  ADD CONSTRAINT scoring_access_sessions_id_match_competition_key
    UNIQUE (id,match_id,competition_id),
  ADD CONSTRAINT scoring_access_sessions_writer_reference_key
    UNIQUE (id,match_id,competition_id,generation,mode),
  ADD CONSTRAINT scoring_access_sessions_mode_check
    CHECK (mode IN ('writer','candidate','viewer','transferred')),
  ADD CONSTRAINT scoring_access_sessions_mode_generation_check CHECK (
    (mode IN ('writer','transferred') AND generation IS NOT NULL AND generation > 0)
    OR
    (mode IN ('candidate','viewer') AND generation IS NULL)
  ),
  ADD CONSTRAINT scoring_access_sessions_device_hash_check
    CHECK (octet_length(device_id_hash)=32),
  ADD CONSTRAINT scoring_access_sessions_device_label_check
    CHECK (device_label IS NULL OR length(btrim(device_label)) BETWEEN 1 AND 80),
  ADD CONSTRAINT scoring_access_sessions_heartbeat_check CHECK (
    last_heartbeat_at IS NULL OR last_heartbeat_at >= issued_at
  ),
  ADD CONSTRAINT scoring_access_sessions_sequence_check CHECK (
    last_acknowledged_sequence >= 0
    AND reported_pending_event_count >= 0
    AND reported_pending_through_sequence >= last_acknowledged_sequence
  );

CREATE INDEX scoring_access_sessions_match_mode_idx
ON scoring_access_sessions(match_id,mode,expires_at DESC);

ALTER TABLE match_writer_leases
  ADD COLUMN competition_id uuid,
  ADD COLUMN session_mode text NOT NULL DEFAULT 'writer';

UPDATE match_writer_leases lease
SET competition_id=match.competition_id
FROM matches match
WHERE match.id=lease.match_id;

ALTER TABLE match_writer_leases
  ALTER COLUMN competition_id SET NOT NULL,
  ADD CONSTRAINT match_writer_leases_match_competition_fkey
    FOREIGN KEY (match_id,competition_id) REFERENCES matches(id,competition_id) ON DELETE CASCADE,
  ADD CONSTRAINT match_writer_leases_session_mode_check CHECK (session_mode='writer');

ALTER TABLE match_writer_leases
  DROP CONSTRAINT match_writer_leases_access_session_id_match_id_generation_fkey,
  ADD CONSTRAINT match_writer_leases_writer_session_fkey
    FOREIGN KEY (access_session_id,match_id,competition_id,generation,session_mode)
    REFERENCES scoring_access_sessions(id,match_id,competition_id,generation,mode)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE scoring_takeover_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL,
  match_id uuid NOT NULL,
  requesting_session_id uuid NOT NULL,
  incumbent_session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','cancelled','expired')),
  requester_pending_event_count integer NOT NULL DEFAULT 0
    CHECK (requester_pending_event_count >= 0),
  incumbent_pending_state text NOT NULL
    CHECK (incumbent_pending_state IN ('unknown','none','present')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '5 minutes'),
  resolved_at timestamptz,
  resolved_by_account_id uuid REFERENCES accounts(id),
  resolution_reason text,
  override_acknowledged boolean NOT NULL DEFAULT false,
  UNIQUE (id,match_id,competition_id),
  FOREIGN KEY (match_id,competition_id)
    REFERENCES matches(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (requesting_session_id,match_id,competition_id)
    REFERENCES scoring_access_sessions(id,match_id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (incumbent_session_id,match_id,competition_id)
    REFERENCES scoring_access_sessions(id,match_id,competition_id) ON DELETE RESTRICT,
  CHECK (requesting_session_id<>incumbent_session_id),
  CHECK (expires_at>requested_at),
  CHECK (
    (status='pending'
      AND resolved_at IS NULL
      AND resolved_by_account_id IS NULL
      AND resolution_reason IS NULL
      AND NOT override_acknowledged)
    OR
    (status IN ('approved','denied')
      AND resolved_at IS NOT NULL
      AND resolved_by_account_id IS NOT NULL
      AND length(btrim(resolution_reason)) BETWEEN 3 AND 1000
      AND (status='approved' OR NOT override_acknowledged))
    OR
    (status IN ('cancelled','expired')
      AND resolved_at IS NOT NULL
      AND length(btrim(resolution_reason)) BETWEEN 3 AND 1000
      AND NOT override_acknowledged)
  ),
  CHECK (
    status<>'approved'
    OR incumbent_pending_state='none'
    OR override_acknowledged
  )
);

CREATE UNIQUE INDEX scoring_takeover_requests_one_pending_candidate
ON scoring_takeover_requests(match_id,requesting_session_id)
WHERE status='pending';

CREATE INDEX scoring_takeover_requests_organiser_queue_idx
ON scoring_takeover_requests(competition_id,status,requested_at);

CREATE TABLE scoring_transfer_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL,
  match_id uuid NOT NULL,
  takeover_request_id uuid NOT NULL,
  stale_session_id uuid NOT NULL,
  replacement_session_id uuid NOT NULL,
  stale_generation integer NOT NULL CHECK (stale_generation > 0),
  pending_event_count integer NOT NULL CHECK (pending_event_count >= 0),
  pending_through_sequence integer NOT NULL CHECK (pending_through_sequence >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','discarded','converted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_account_id uuid REFERENCES accounts(id),
  resolution_reason text,
  FOREIGN KEY (match_id,competition_id)
    REFERENCES matches(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (takeover_request_id,match_id,competition_id)
    REFERENCES scoring_takeover_requests(id,match_id,competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (stale_session_id,match_id,competition_id)
    REFERENCES scoring_access_sessions(id,match_id,competition_id) ON DELETE RESTRICT,
  FOREIGN KEY (replacement_session_id,match_id,competition_id)
    REFERENCES scoring_access_sessions(id,match_id,competition_id) ON DELETE RESTRICT,
  CHECK (stale_session_id<>replacement_session_id),
  CHECK (
    (status='open'
      AND resolved_at IS NULL
      AND resolved_by_account_id IS NULL
      AND resolution_reason IS NULL)
    OR
    (status IN ('discarded','converted')
      AND resolved_at IS NOT NULL
      AND resolved_by_account_id IS NOT NULL
      AND length(btrim(resolution_reason)) BETWEEN 3 AND 1000)
  ),
  UNIQUE (takeover_request_id)
);

CREATE INDEX scoring_transfer_conflicts_open_idx
ON scoring_transfer_conflicts(competition_id,created_at)
WHERE status='open';

CREATE TABLE scoring_access_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid,
  match_id uuid,
  access_pass_id uuid,
  credential_kind text NOT NULL CHECK (credential_kind IN ('token','fallback_code')),
  outcome text NOT NULL CHECK (outcome IN (
    'accepted','invalid','expired','revoked','wrong_match','rate_limited'
  )),
  credential_hmac bytea NOT NULL CHECK (octet_length(credential_hmac)=32),
  ip_hmac bytea NOT NULL CHECK (octet_length(ip_hmac)=32),
  request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz,
  -- These identifiers are immutable audit snapshots rather than ownership
  -- references. Foreign keys would either delete the evidence with its parent
  -- or require mutating an append-only row during aggregate cleanup.
  CHECK (
    (competition_id IS NULL AND match_id IS NULL AND access_pass_id IS NULL)
    OR
    (competition_id IS NOT NULL AND match_id IS NOT NULL)
  ),
  CHECK (cooldown_until IS NULL OR cooldown_until>attempted_at),
  UNIQUE (request_id)
);

CREATE INDEX scoring_access_attempts_credential_window_idx
ON scoring_access_attempts(credential_hmac,ip_hmac,attempted_at DESC);

CREATE INDEX scoring_access_attempts_ip_window_idx
ON scoring_access_attempts(ip_hmac,attempted_at DESC);

CREATE FUNCTION phase5_validate_access_attempt_snapshot() RETURNS trigger AS $$
BEGIN
  IF NEW.match_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM matches
    WHERE id=NEW.match_id AND competition_id=NEW.competition_id
  ) THEN
    RAISE EXCEPTION 'access attempt match and competition do not agree';
  END IF;
  IF NEW.access_pass_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM scoring_access_passes
    WHERE id=NEW.access_pass_id
      AND match_id=NEW.match_id
      AND competition_id=NEW.competition_id
  ) THEN
    RAISE EXCEPTION 'access attempt pass, match, and competition do not agree';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scoring_access_attempts_snapshot_guard
BEFORE INSERT ON scoring_access_attempts
FOR EACH ROW EXECUTE FUNCTION phase5_validate_access_attempt_snapshot();

CREATE TRIGGER scoring_access_attempts_append_only
BEFORE UPDATE OR DELETE ON scoring_access_attempts
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();

CREATE FUNCTION phase5_guard_access_transition_immutability() RETURNS trigger AS $$
BEGIN
  IF ROW(
    OLD.competition_id,OLD.match_id,OLD.requesting_session_id,OLD.incumbent_session_id,
    OLD.requester_pending_event_count,OLD.incumbent_pending_state,OLD.requested_at,OLD.expires_at
  ) IS DISTINCT FROM ROW(
    NEW.competition_id,NEW.match_id,NEW.requesting_session_id,NEW.incumbent_session_id,
    NEW.requester_pending_event_count,NEW.incumbent_pending_state,NEW.requested_at,NEW.expires_at
  ) THEN
    RAISE EXCEPTION 'takeover request identity and pending-state evidence are immutable';
  END IF;
  IF OLD.status<>'pending' THEN
    RAISE EXCEPTION 'resolved takeover requests are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scoring_takeover_requests_transition_guard
BEFORE UPDATE ON scoring_takeover_requests
FOR EACH ROW EXECUTE FUNCTION phase5_guard_access_transition_immutability();

CREATE FUNCTION phase5_guard_transfer_conflict_immutability() RETURNS trigger AS $$
BEGIN
  IF ROW(
    OLD.competition_id,OLD.match_id,OLD.takeover_request_id,OLD.stale_session_id,
    OLD.replacement_session_id,OLD.stale_generation,OLD.pending_event_count,
    OLD.pending_through_sequence,OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.competition_id,NEW.match_id,NEW.takeover_request_id,NEW.stale_session_id,
    NEW.replacement_session_id,NEW.stale_generation,NEW.pending_event_count,
    NEW.pending_through_sequence,NEW.created_at
  ) THEN
    RAISE EXCEPTION 'transfer conflict evidence is immutable';
  END IF;
  IF OLD.status<>'open' THEN
    RAISE EXCEPTION 'resolved transfer conflicts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scoring_transfer_conflicts_transition_guard
BEFORE UPDATE ON scoring_transfer_conflicts
FOR EACH ROW EXECUTE FUNCTION phase5_guard_transfer_conflict_immutability();

CREATE TRIGGER scoring_takeover_requests_phase3_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON scoring_takeover_requests
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();

CREATE TRIGGER scoring_transfer_conflicts_phase3_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON scoring_transfer_conflicts
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
