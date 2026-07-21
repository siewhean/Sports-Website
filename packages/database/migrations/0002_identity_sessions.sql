CREATE TABLE identity_sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  provider_session_id text,
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at > created_at),
  CHECK (absolute_expires_at >= idle_expires_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX identity_sessions_account_active_idx
ON identity_sessions(account_id, last_seen_at DESC)
WHERE revoked_at IS NULL;

CREATE TABLE identity_recovery_requests (
  id uuid PRIMARY KEY,
  identifier_hash text NOT NULL CHECK (identifier_hash ~ '^[0-9a-f]{64}$'),
  provider_issuer text NOT NULL,
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > requested_at),
  CHECK (consumed_at IS NULL OR consumed_at >= requested_at),
  CHECK (revoked_at IS NULL OR revoked_at >= requested_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX identity_recovery_identifier_time_idx
ON identity_recovery_requests(identifier_hash, requested_at DESC);

CREATE TABLE official_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (resource_type IN ('competition', 'match')),
  resource_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  granted_by uuid REFERENCES accounts(id),
  CHECK (expires_at IS NULL OR expires_at > granted_at),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE UNIQUE INDEX official_grants_active_unique
ON official_grants(account_id, organisation_id, resource_type, resource_id)
WHERE revoked_at IS NULL;

CREATE INDEX official_grants_account_active_idx
ON official_grants(account_id, organisation_id)
WHERE revoked_at IS NULL;

CREATE TABLE account_platform_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role = 'platform_admin'),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  granted_by uuid REFERENCES accounts(id),
  reason text NOT NULL,
  CHECK (expires_at IS NULL OR expires_at > granted_at),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE UNIQUE INDEX account_platform_roles_active_unique
ON account_platform_roles(account_id, role)
WHERE revoked_at IS NULL;

CREATE FUNCTION prevent_membership_identity_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'membership organisation and account are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organisation_memberships_identity_immutable
BEFORE UPDATE OF organisation_id, account_id ON organisation_memberships
FOR EACH ROW EXECUTE FUNCTION prevent_membership_identity_mutation();

CREATE FUNCTION serialize_organisation_owner_mutation() RETURNS trigger AS $$
DECLARE
  locked_organisation_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    locked_organisation_id := OLD.organisation_id;
  ELSE
    locked_organisation_id := NEW.organisation_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(locked_organisation_id::text, 684721));
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organisation_memberships_serialize_owner_mutation
BEFORE UPDATE OF role, status OR DELETE ON organisation_memberships
FOR EACH ROW EXECUTE FUNCTION serialize_organisation_owner_mutation();

CREATE FUNCTION enforce_organisation_has_active_owner() RETURNS trigger AS $$
DECLARE
  checked_organisation_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    checked_organisation_id := OLD.organisation_id;
  ELSE
    checked_organisation_id := NEW.organisation_id;
  END IF;
  IF EXISTS (SELECT 1 FROM organisations WHERE id = checked_organisation_id)
     AND NOT EXISTS (
       SELECT 1
       FROM organisation_memberships
       WHERE organisation_id = checked_organisation_id
         AND role = 'owner'
         AND status = 'active'
     ) THEN
    RAISE EXCEPTION 'organisation must retain an active owner';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER organisation_memberships_require_owner
AFTER UPDATE OF role, status OR DELETE ON organisation_memberships
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_organisation_has_active_owner();

CREATE FUNCTION enforce_new_organisation_has_active_owner() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organisations WHERE id = NEW.id)
     AND NOT EXISTS (
    SELECT 1
    FROM organisation_memberships
    WHERE organisation_id = NEW.id
      AND role = 'owner'
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'organisation must have an active owner';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER organisations_require_owner
AFTER INSERT ON organisations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_new_organisation_has_active_owner();
