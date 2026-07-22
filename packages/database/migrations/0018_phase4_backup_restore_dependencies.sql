-- Make the SQL-function dependency graph explicit so pg_dump can restore the
-- hash helpers before tables whose generated columns and checks invoke them.
-- SQL-standard function bodies are parsed when created and therefore record
-- referenced functions in pg_depend; quoted SQL bodies do not.

CREATE OR REPLACE FUNCTION phase4_sha256_json(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT
RETURN encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(phase3_canonical_jsonb(value), 'UTF8')
  ),
  'hex'
);

CREATE OR REPLACE FUNCTION phase4_schedule_problem_hash(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT
RETURN phase4_sha256_json(value - 'job_id');
