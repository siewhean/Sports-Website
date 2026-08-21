-- Reassert the Phase 3 canonical serializer used by immutable sport-pack
-- hashes. A staging database may have received an older/manual function body;
-- do not weaken the hash guard or rewrite existing sport-pack records.
CREATE OR REPLACE FUNCTION phase3_canonical_jsonb(value jsonb) RETURNS text AS $$
DECLARE
  result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(to_jsonb(key)::text || ':' || phase3_canonical_jsonb(item), ',' ORDER BY key), '') || '}'
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

CREATE OR REPLACE FUNCTION phase3_verify_sport_pack_hash() RETURNS trigger AS $$
BEGIN
  IF jsonb_typeof(NEW.definition)='string' THEN
    NEW.definition := (NEW.definition #>> '{}')::jsonb;
  END IF;
  IF NEW.definition_hash<>encode(pg_catalog.sha256(
    convert_to(phase3_canonical_jsonb(NEW.definition),'UTF8')),'hex') THEN
    RAISE EXCEPTION 'sport pack definition hash does not match definition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
