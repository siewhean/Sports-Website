CREATE TABLE identity_session_assurance (
  session_id uuid PRIMARY KEY REFERENCES identity_sessions(id) ON DELETE CASCADE,
  assurance_level text NOT NULL CHECK (assurance_level IN ('single_factor', 'multi_factor', 'phishing_resistant')),
  authentication_methods text[] NOT NULL DEFAULT '{}'::text[],
  acr text,
  authenticated_at timestamptz,
  mfa_performed boolean NOT NULL,
  phishing_resistant boolean NOT NULL,
  CHECK (cardinality(authentication_methods) <= 16),
  CHECK (acr IS NULL OR char_length(acr) <= 512),
  CHECK (
    (assurance_level = 'single_factor' AND NOT mfa_performed AND NOT phishing_resistant)
    OR (assurance_level = 'multi_factor' AND mfa_performed AND NOT phishing_resistant)
    OR (assurance_level = 'phishing_resistant' AND mfa_performed AND phishing_resistant)
  )
);

COMMENT ON TABLE identity_session_assurance IS
  'Normalized, server-verified authentication assurance bound to one opaque MATCHDAY session. Existing sessions without a row are treated as single-factor.';
