ALTER TABLE identity_sessions
  ADD COLUMN provider_issuer text,
  ADD COLUMN provider_subject text;

-- Older application builds never persisted an issuer with provider_session_id. Revoke and clear
-- any manually populated unscoped values rather than treating a potentially colliding sid as trusted.
UPDATE identity_sessions
SET revoked_at = COALESCE(revoked_at, now()), provider_session_id = NULL
WHERE provider_session_id IS NOT NULL;

ALTER TABLE identity_sessions
  ADD CONSTRAINT identity_sessions_provider_binding_check CHECK (
    (provider_issuer IS NULL AND provider_subject IS NULL AND provider_session_id IS NULL)
    OR (provider_issuer IS NOT NULL AND provider_subject IS NOT NULL)
  );

CREATE INDEX identity_sessions_provider_subject_active_idx
ON identity_sessions(provider_issuer, provider_subject)
WHERE revoked_at IS NULL AND provider_issuer IS NOT NULL;

CREATE INDEX identity_sessions_provider_sid_active_idx
ON identity_sessions(provider_issuer, provider_session_id)
WHERE revoked_at IS NULL AND provider_session_id IS NOT NULL;

CREATE TABLE identity_provider_events (
  event_id uuid PRIMARY KEY,
  provider_issuer text NOT NULL,
  provider_subject text,
  provider_session_id text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider_subject IS NULL) <> (provider_session_id IS NULL))
);

CREATE INDEX identity_provider_events_received_idx
ON identity_provider_events(received_at DESC);
