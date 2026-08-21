-- Gate C audit remediation: make fallback-code hashes unique across retained history.
--
-- C1 originally enforced uniqueness only for currently active fallback codes.
-- Exchange lookup retains revoked/expired passes for audit and credential-state
-- reporting, so an active code must never be able to collide with a retained
-- historical row. Keep the existing index name because the runtime classifies
-- this PostgreSQL 23505 signal to perform bounded collision retries.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM scoring_access_passes
    WHERE short_code_hash IS NOT NULL
    GROUP BY short_code_hash
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate retained scoring fallback-code hashes exist; resolve them before applying 0046';
  END IF;
END;
$$;

DROP INDEX IF EXISTS scoring_access_pass_active_code_unique;

CREATE UNIQUE INDEX scoring_access_pass_active_code_unique
ON scoring_access_passes(short_code_hash)
WHERE short_code_hash IS NOT NULL;

COMMENT ON INDEX scoring_access_pass_active_code_unique IS
  'Fallback-code hashes are globally unique across active, expired, and revoked retained passes so credential lookup cannot be shadowed by historical rows.';
