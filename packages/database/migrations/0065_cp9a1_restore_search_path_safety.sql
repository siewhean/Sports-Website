-- pg_restore executes generated-column expressions with a restricted search_path.
-- Keep the 0050 serializers unchanged except for schema-qualified self-lookups.
CREATE OR REPLACE FUNCTION public.phase3_canonical_jsonb(value jsonb) RETURNS text AS $$
DECLARE
  result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(to_jsonb(key)::text || ':' || public.phase3_canonical_jsonb(item), ',' ORDER BY key), '') || '}'
      INTO result FROM jsonb_each(value) AS fields(key,item);
      RETURN result;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(public.phase3_canonical_jsonb(item), ',' ORDER BY ordinal), '') || ']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item,ordinal);
      RETURN result;
    ELSE
      RETURN value::text;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.phase3_canonical_sport_pack_jsonb(value jsonb) RETURNS text AS $$
DECLARE
  result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        string_agg(
          to_jsonb(key)::text || ':' || public.phase3_canonical_sport_pack_jsonb(item),
          ',' ORDER BY key COLLATE "C"
        ),
        ''
      ) || '}'
      INTO result FROM jsonb_each(value) AS fields(key,item);
      RETURN result;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(public.phase3_canonical_sport_pack_jsonb(item), ',' ORDER BY ordinal), '') || ']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item,ordinal);
      RETURN result;
    ELSE
      RETURN value::text;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The recursive Phase 4 sanitization guard has the same restricted-path defect.
CREATE OR REPLACE FUNCTION public.phase4_json_object_without_forbidden_keys(value jsonb) RETURNS boolean AS $$
DECLARE key text; child jsonb;
BEGIN
  IF jsonb_typeof(value)='object' THEN
    FOR key,child IN SELECT * FROM jsonb_each(value) LOOP
      IF lower(key) ~ '(prompt|raw|source.?text|secret|token|credential|provider.?output)'
         OR NOT public.phase4_json_object_without_forbidden_keys(child) THEN RETURN false; END IF;
    END LOOP;
  ELSIF jsonb_typeof(value)='array' THEN
    FOR child IN SELECT item FROM jsonb_array_elements(value) item LOOP
      IF NOT public.phase4_json_object_without_forbidden_keys(child) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;
