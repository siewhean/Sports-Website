-- C5 rate-limit HMAC rotation. The registry contains only public version names
-- and lifecycle timestamps; HMAC material remains configuration-only.
CREATE TABLE scoring_access_hmac_key_versions (
  key_version text PRIMARY KEY CHECK (key_version ~ '^[a-z][a-z0-9_-]{0,63}$'),
  material_commitment bytea NOT NULL CHECK (octet_length(material_commitment)=32),
  status text NOT NULL CHECK (status IN ('primary','verification_only','retired')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  verification_only_since timestamptz,
  retirement_not_before timestamptz,
  retired_at timestamptz,
  CHECK (
    (status='primary' AND verification_only_since IS NULL AND retirement_not_before IS NULL AND retired_at IS NULL)
    OR
    (status='verification_only' AND verification_only_since IS NOT NULL AND retirement_not_before IS NOT NULL AND retired_at IS NULL)
    OR
    (status='retired' AND verification_only_since IS NOT NULL AND retirement_not_before IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX scoring_access_hmac_key_versions_one_primary_idx
  ON scoring_access_hmac_key_versions((status))
  WHERE status='primary';

-- C1-C4 access-attempt hashes were generated with the original server key.
-- This immutable registry entry makes that historical version explicit before
-- the non-null foreign key is introduced below.
INSERT INTO scoring_access_hmac_key_versions(key_version,material_commitment,status)
  VALUES ('v1',decode(repeat('00',32),'hex'),'primary');

ALTER TABLE scoring_access_attempts
  ADD COLUMN hmac_key_version text NOT NULL DEFAULT 'v1'
  CHECK (hmac_key_version ~ '^[a-z][a-z0-9_-]{0,63}$');

ALTER TABLE scoring_access_attempts
  ADD COLUMN rate_limit_state_expires_at timestamptz;

UPDATE scoring_access_attempts
SET rate_limit_state_expires_at=GREATEST(
  attempted_at,
  COALESCE(cooldown_until,attempted_at + interval '15 minutes')
)
WHERE rate_limit_state_expires_at IS NULL;

ALTER TABLE scoring_access_attempts
  ALTER COLUMN rate_limit_state_expires_at SET NOT NULL,
  ADD CONSTRAINT scoring_access_attempts_rate_limit_state_expiry_check
  CHECK (rate_limit_state_expires_at>=attempted_at);

ALTER TABLE scoring_access_attempts
  ADD CONSTRAINT scoring_access_attempts_hmac_key_version_fkey
  FOREIGN KEY (hmac_key_version)
  REFERENCES scoring_access_hmac_key_versions(key_version)
  ON DELETE RESTRICT;

-- The default exists only for the safe historical backfill above. All C5
-- runtime writes must provide the configured primary version and the precise
-- time at which their rate-limit state can no longer depend on that version.
ALTER TABLE scoring_access_attempts
  ALTER COLUMN hmac_key_version DROP DEFAULT;

CREATE INDEX scoring_access_attempts_hmac_key_version_window_idx
  ON scoring_access_attempts(hmac_key_version, attempted_at DESC);

CREATE FUNCTION phase5_guard_scoring_access_hmac_key_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'scoring access HMAC key versions are retained for immutable access-attempt evidence';
  END IF;
  IF NEW.key_version IS DISTINCT FROM OLD.key_version THEN
    RAISE EXCEPTION 'scoring access HMAC key version identifiers are immutable';
  END IF;
  IF OLD.material_commitment<>decode(repeat('00',32),'hex')
    AND NEW.material_commitment IS DISTINCT FROM OLD.material_commitment THEN
    RAISE EXCEPTION 'scoring access HMAC key material commitments are immutable';
  END IF;
  IF OLD.status='retired' THEN
    RAISE EXCEPTION 'retired scoring access HMAC key versions cannot be reactivated';
  END IF;
  IF NEW.status='primary' AND (NEW.verification_only_since IS NOT NULL OR NEW.retirement_not_before IS NOT NULL OR NEW.retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'primary scoring access HMAC key versions cannot carry retirement metadata';
  END IF;
  IF NEW.status IN ('verification_only','retired')
    AND (NEW.verification_only_since IS NULL OR NEW.retirement_not_before IS NULL) THEN
    RAISE EXCEPTION 'verification-only scoring access HMAC key versions require retirement timing';
  END IF;
  IF NEW.status='retired' AND NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'retired scoring access HMAC key versions require a retirement timestamp';
  END IF;
  IF NEW.status<>'retired' AND NEW.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'only retired scoring access HMAC key versions may carry a retirement timestamp';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scoring_access_hmac_key_versions_transition_guard
BEFORE UPDATE OR DELETE ON scoring_access_hmac_key_versions
FOR EACH ROW EXECUTE FUNCTION phase5_guard_scoring_access_hmac_key_version();

CREATE FUNCTION phase5_validate_scoring_access_attempt_hmac_key_version() RETURNS trigger AS $$
DECLARE
  version_status text;
BEGIN
  SELECT status INTO version_status
  FROM scoring_access_hmac_key_versions
  WHERE key_version=NEW.hmac_key_version;
  IF version_status IS NULL THEN
    RAISE EXCEPTION 'scoring access HMAC key version is unknown';
  END IF;
  IF version_status='retired' THEN
    RAISE EXCEPTION 'scoring access HMAC key version is retired';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scoring_access_attempts_hmac_key_version_guard
BEFORE INSERT ON scoring_access_attempts
FOR EACH ROW EXECUTE FUNCTION phase5_validate_scoring_access_attempt_hmac_key_version();

COMMENT ON COLUMN scoring_access_attempts.hmac_key_version IS
  'Public registry version for the server-side HMAC key that created credential_hmac and ip_hmac; never key material.';

COMMENT ON COLUMN scoring_access_attempts.rate_limit_state_expires_at IS
  'Exact last possible Redis window or cooldown expiry for this attempt; used to fence HMAC key retirement.';
