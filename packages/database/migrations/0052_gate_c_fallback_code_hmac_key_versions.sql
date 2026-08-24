-- Gate C fallback-code HMAC lifecycle. This registry deliberately records
-- public versions and commitments only; secret material remains deployment
-- configuration and must never enter PostgreSQL or audit metadata.
CREATE TABLE scoring_fallback_code_hmac_key_versions (
  key_version text PRIMARY KEY CHECK (key_version ~ '^[a-z][a-z0-9_-]{0,63}$'),
  material_commitment bytea NOT NULL CHECK (octet_length(material_commitment)=32),
  status text NOT NULL CHECK (status IN ('primary','verification_only','retired')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  verification_only_since timestamptz,
  retired_at timestamptz,
  CHECK (
    (status='primary' AND verification_only_since IS NULL AND retired_at IS NULL)
    OR (status='verification_only' AND verification_only_since IS NOT NULL AND retired_at IS NULL)
    OR (status='retired' AND verification_only_since IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX scoring_fallback_code_hmac_key_versions_one_primary_idx
  ON scoring_fallback_code_hmac_key_versions((status)) WHERE status='primary';

-- Existing hmac_sha256_v1 fallback-code rows were deliberately retained by
-- 0051. The zero commitment is fail-closed at first reconciliation: only the
-- configured legacy v1 material can claim it, and it can never be changed
-- afterwards.
INSERT INTO scoring_fallback_code_hmac_key_versions(key_version, material_commitment, status)
VALUES ('v1', decode(repeat('00',32),'hex'), 'primary');

ALTER TABLE scoring_access_passes
  ADD COLUMN fallback_code_hmac_key_version text;

UPDATE scoring_access_passes
SET fallback_code_hmac_key_version='v1'
WHERE short_code_hash IS NOT NULL AND fallback_code_hash_version='hmac_sha256_v1';

ALTER TABLE scoring_access_passes
  ADD CONSTRAINT scoring_access_passes_fallback_code_hmac_key_version_fkey
  FOREIGN KEY (fallback_code_hmac_key_version)
  REFERENCES scoring_fallback_code_hmac_key_versions(key_version)
  ON DELETE RESTRICT,
  ADD CONSTRAINT scoring_access_passes_fallback_code_hmac_key_version_shape_check
  CHECK (
    (short_code_hash IS NULL AND fallback_code_hmac_key_version IS NULL)
    OR (short_code_hash IS NOT NULL AND fallback_code_hmac_key_version IS NOT NULL)
  );

CREATE INDEX scoring_access_passes_fallback_code_hmac_key_version_active_idx
  ON scoring_access_passes(fallback_code_hmac_key_version, expires_at)
  WHERE short_code_hash IS NOT NULL AND revoked_at IS NULL;

CREATE FUNCTION phase5_guard_scoring_fallback_code_hmac_key_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'fallback-code HMAC key versions are retained for access-pass provenance';
  END IF;
  IF NEW.key_version IS DISTINCT FROM OLD.key_version THEN
    RAISE EXCEPTION 'fallback-code HMAC key version identifiers are immutable';
  END IF;
  IF OLD.material_commitment<>decode(repeat('00',32),'hex')
    AND NEW.material_commitment IS DISTINCT FROM OLD.material_commitment THEN
    RAISE EXCEPTION 'fallback-code HMAC key material commitments are immutable';
  END IF;
  IF OLD.status='retired' THEN
    RAISE EXCEPTION 'retired fallback-code HMAC key versions cannot be reactivated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scoring_fallback_code_hmac_key_versions_transition_guard
BEFORE UPDATE OR DELETE ON scoring_fallback_code_hmac_key_versions
FOR EACH ROW EXECUTE FUNCTION phase5_guard_scoring_fallback_code_hmac_key_version();

CREATE FUNCTION phase5_validate_scoring_access_pass_fallback_hmac_key_version() RETURNS trigger AS $$
DECLARE version_status text;
BEGIN
  IF NEW.short_code_hash IS NULL THEN RETURN NEW; END IF;
  SELECT status INTO version_status
  FROM scoring_fallback_code_hmac_key_versions
  WHERE key_version=NEW.fallback_code_hmac_key_version;
  IF version_status IS NULL THEN RAISE EXCEPTION 'fallback-code HMAC key version is unknown'; END IF;
  IF version_status='retired' THEN RAISE EXCEPTION 'fallback-code HMAC key version is retired'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scoring_access_passes_fallback_hmac_key_version_guard
BEFORE INSERT OR UPDATE OF short_code_hash, fallback_code_hmac_key_version ON scoring_access_passes
FOR EACH ROW EXECUTE FUNCTION phase5_validate_scoring_access_pass_fallback_hmac_key_version();

COMMENT ON COLUMN scoring_access_passes.fallback_code_hmac_key_version IS
  'Public fallback-code HMAC key version that created short_code_hash; never secret material.';
