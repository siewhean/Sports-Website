-- `ORDER BY key` depends on the database collation. The application hashes
-- object keys by deterministic code-point order, so pin PostgreSQL to the C
-- collation before verifying immutable sport-pack definitions.
CREATE OR REPLACE FUNCTION phase3_canonical_jsonb(value jsonb) RETURNS text AS $$
DECLARE
  result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        string_agg(
          to_jsonb(key)::text || ':' || phase3_canonical_jsonb(item),
          ',' ORDER BY key COLLATE "C"
        ),
        ''
      ) || '}'
      INTO result FROM jsonb_each(value) AS fields(key,item);
      RETURN result;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(phase3_canonical_jsonb(item), ',' ORDER BY ordinal), '') || ']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item,ordinal);
      RETURN result;
    ELSE
      RETURN value::text;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
