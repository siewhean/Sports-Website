-- Phase 3 persistence safety is deliberately forward-only. Migration 0007 is
-- already deployable history, so these guards replace functions and add new
-- triggers without rewriting it.

CREATE FUNCTION phase3_json_positive_integer(value jsonb) RETURNS boolean AS $$
BEGIN
  RETURN jsonb_typeof(value) = 'number'
    AND value::text ~ '^[0-9]+$'
    AND (value::text)::numeric > 0;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase3_canonical_jsonb(value jsonb) RETURNS text AS $$
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

CREATE OR REPLACE FUNCTION phase3_enforce_free_entry_limit() RETURNS trigger AS $$
DECLARE
  target_competition uuid;
  tier text;
  active_count integer;
BEGIN
  IF NEW.status NOT IN ('confirmed','active') THEN RETURN NEW; END IF;
  SELECT competition_id INTO target_competition FROM divisions WHERE id = NEW.division_id;
  -- The competition row is the single lock for entry inserts in every division.
  -- Taking it first also matches plan-tier updates and prevents lock inversion.
  SELECT plan_tier INTO tier FROM competitions WHERE id = target_competition FOR UPDATE;
  IF tier <> 'free' THEN RETURN NEW; END IF;
  SELECT count(*) INTO active_count
  FROM division_entries e JOIN divisions d ON d.id = e.division_id
  WHERE d.competition_id = target_competition
    AND e.status IN ('confirmed','active') AND e.id <> NEW.id;
  IF active_count >= 16 THEN
    RAISE EXCEPTION 'free plan permits at most 16 active entries per competition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase3_guard_free_plan_downgrade() RETURNS trigger AS $$
BEGIN
  IF NEW.plan_tier = 'free' AND OLD.plan_tier <> 'free' AND (
    SELECT count(*) FROM division_entries e
    JOIN divisions d ON d.id = e.division_id
    WHERE d.competition_id = NEW.id AND e.status IN ('confirmed','active')
  ) > 16 THEN
    RAISE EXCEPTION 'cannot downgrade to free with more than 16 active entries';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER competitions_phase3_free_downgrade_guard
BEFORE UPDATE OF plan_tier ON competitions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_free_plan_downgrade();

CREATE FUNCTION phase3_format_source_shape_valid(source jsonb, entry_count integer) RETURNS boolean AS $$
DECLARE
  source_type text;
BEGIN
  IF jsonb_typeof(source) <> 'object' OR jsonb_typeof(source->'type') <> 'string' THEN
    RETURN false;
  END IF;
  source_type := source->>'type';
  IF source_type = 'entry_seed' THEN
    RETURN (SELECT count(*) = 2 AND bool_and(key = ANY (ARRAY['type','seed'])) FROM jsonb_object_keys(source) key)
      AND phase3_json_positive_integer(source->'seed')
      AND (source->>'seed')::numeric <= entry_count;
  ELSIF source_type = 'stage_rank' THEN
    RETURN (SELECT count(*) BETWEEN 3 AND 4 AND bool_and(key = ANY (ARRAY['type','stageId','groupId','rank'])) FROM jsonb_object_keys(source) key)
      AND jsonb_typeof(source->'stageId') = 'string' AND length(source->>'stageId') > 0
      AND (NOT source ? 'groupId' OR (jsonb_typeof(source->'groupId') = 'string' AND length(source->>'groupId') > 0))
      AND phase3_json_positive_integer(source->'rank');
  ELSIF source_type IN ('winner','loser') THEN
    RETURN (SELECT count(*) = 2 AND bool_and(key = ANY (ARRAY['type','matchId'])) FROM jsonb_object_keys(source) key)
      AND jsonb_typeof(source->'matchId') = 'string' AND length(source->>'matchId') > 0;
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION phase3_format_definition_db_valid(definition jsonb) RETURNS boolean AS $$
DECLARE
  entry_count integer;
  stage jsonb;
  match jsonb;
  source jsonb;
  stage_kind text;
  stage_id text;
  pool_id text;
  pool_size integer;
  expected_matches integer;
  actual_matches integer;
  distinct_pairs integer;
  distinct_seeds integer;
  minimum_seed_uses integer;
  maximum_seed_uses integer;
BEGIN
  IF jsonb_typeof(definition) <> 'object'
     OR (SELECT count(*) <> 6 OR NOT bool_and(key = ANY (ARRAY['id','schemaVersion','entryCount','stages','matches','terminalMatchIds'])) FROM jsonb_object_keys(definition) key)
     OR jsonb_typeof(definition->'id') <> 'string' OR length(definition->>'id') = 0
     OR definition->'schemaVersion' <> '1'::jsonb
     OR NOT phase3_json_positive_integer(definition->'entryCount')
     OR (definition->>'entryCount')::numeric < 2 OR (definition->>'entryCount')::numeric > 48
     OR jsonb_typeof(definition->'stages') <> 'array'
     OR jsonb_typeof(definition->'matches') <> 'array'
     OR jsonb_typeof(definition->'terminalMatchIds') <> 'array'
     OR jsonb_array_length(definition->'stages') = 0
     OR jsonb_array_length(definition->'matches') = 0
     OR jsonb_array_length(definition->'stages') > 64
     OR jsonb_array_length(definition->'matches') > 1128 THEN
    RETURN false;
  END IF;
  entry_count := (definition->>'entryCount')::integer;

  -- Stage structure, exact keys, and stage-local invariants.
  FOR stage IN SELECT value FROM jsonb_array_elements(definition->'stages') LOOP
    IF jsonb_typeof(stage) <> 'object'
       OR (SELECT count(*) <> 8 OR NOT bool_and(key = ANY (ARRAY['id','label','kind','order','groupIds','groupSize','outputRanks','matchIds'])) FROM jsonb_object_keys(stage) key)
       OR jsonb_typeof(stage->'id') <> 'string' OR length(stage->>'id') = 0
       OR jsonb_typeof(stage->'label') <> 'string' OR length(stage->>'label') = 0
       OR jsonb_typeof(stage->'kind') <> 'string'
       OR stage->>'kind' NOT IN ('round_robin','group','single_elimination','placement','consolation','classification','bronze')
       OR NOT phase3_json_positive_integer(stage->'order')
       OR jsonb_typeof(stage->'groupIds') <> 'array'
       OR jsonb_typeof(stage->'matchIds') <> 'array'
       OR jsonb_array_length(stage->'matchIds') = 0
       OR NOT phase3_json_positive_integer(stage->'outputRanks')
       OR (stage->>'outputRanks')::numeric > entry_count
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(stage->'groupIds') item WHERE jsonb_typeof(item) <> 'string' OR length(item #>> '{}') = 0)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(stage->'matchIds') item WHERE jsonb_typeof(item) <> 'string' OR length(item #>> '{}') = 0)
       OR (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements_text(stage->'groupIds'))
       OR (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements_text(stage->'matchIds')) THEN
      RETURN false;
    END IF;
    stage_kind := stage->>'kind';
    IF stage_kind = 'group' THEN
      IF jsonb_array_length(stage->'groupIds') = 0
         OR NOT phase3_json_positive_integer(stage->'groupSize')
         OR (stage->>'groupSize')::numeric < 2
         OR (stage->>'groupSize')::numeric * jsonb_array_length(stage->'groupIds') <> entry_count
         OR (stage->>'outputRanks')::numeric > (stage->>'groupSize')::numeric THEN
        RETURN false;
      END IF;
    ELSIF stage_kind = 'round_robin' THEN
      IF jsonb_array_length(stage->'groupIds') <> 0 OR stage->'groupSize' <> 'null'::jsonb
         OR (stage->>'outputRanks')::integer <> entry_count THEN
        RETURN false;
      END IF;
    ELSIF jsonb_array_length(stage->'groupIds') <> 0 OR stage->'groupSize' <> 'null'::jsonb THEN
      RETURN false;
    END IF;
  END LOOP;

  IF (SELECT count(*) <> count(DISTINCT item.value->>'id') FROM jsonb_array_elements(definition->'stages') AS item(value))
     OR (SELECT count(*) <> count(DISTINCT (item.value->>'order')::numeric) FROM jsonb_array_elements(definition->'stages') AS item(value)) THEN
    RETURN false;
  END IF;

  -- Match structure and exact participant-source discriminators.
  FOR match IN SELECT value FROM jsonb_array_elements(definition->'matches') LOOP
    IF jsonb_typeof(match) <> 'object'
       OR (SELECT count(*) NOT IN (7,8) OR NOT bool_and(key = ANY (ARRAY['id','stageId','poolId','round','order','purpose','home','away'])) FROM jsonb_object_keys(match) key)
       OR NOT (match ?& ARRAY['id','stageId','round','order','purpose','home','away'])
       OR jsonb_typeof(match->'id') <> 'string' OR length(match->>'id') = 0
       OR jsonb_typeof(match->'stageId') <> 'string' OR length(match->>'stageId') = 0
       OR (match ? 'poolId' AND (jsonb_typeof(match->'poolId') <> 'string' OR length(match->>'poolId') = 0))
       OR NOT phase3_json_positive_integer(match->'round')
       OR NOT phase3_json_positive_integer(match->'order')
       OR jsonb_typeof(match->'purpose') <> 'string'
       OR match->>'purpose' NOT IN ('pool','progression','championship','placement','classification')
       OR NOT phase3_format_source_shape_valid(match->'home', entry_count)
       OR NOT phase3_format_source_shape_valid(match->'away', entry_count)
       OR match->'home' = match->'away' THEN
      RETURN false;
    END IF;
  END LOOP;

  IF (SELECT count(*) <> count(DISTINCT item.value->>'id') FROM jsonb_array_elements(definition->'matches') AS item(value))
     OR (SELECT count(*) <> count(DISTINCT (item.value->>'order')::numeric) FROM jsonb_array_elements(definition->'matches') AS item(value)) THEN
    RETURN false;
  END IF;

  -- Every match belongs to exactly one declared stage and every declaration
  -- points back to the same stage.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(definition->'matches') AS graph_match(value)
    WHERE (SELECT count(*) FROM jsonb_array_elements(definition->'stages') AS graph_stage(value)
           CROSS JOIN LATERAL jsonb_array_elements_text(graph_stage.value->'matchIds') AS member(value)
           WHERE member.value = graph_match.value->>'id'
             AND graph_stage.value->>'id' = graph_match.value->>'stageId') <> 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(definition->'stages') AS graph_stage(value)
    CROSS JOIN LATERAL jsonb_array_elements_text(graph_stage.value->'matchIds') AS member(value)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'matches') AS graph_match(value)
                      WHERE graph_match.value->>'id' = member.value
                        AND graph_match.value->>'stageId' = graph_stage.value->>'id')
  ) THEN
    RETURN false;
  END IF;

  -- Validate source references and strict forward ordering. Forward-only
  -- dependencies are themselves an acyclicity proof.
  FOR match IN SELECT value FROM jsonb_array_elements(definition->'matches') LOOP
    SELECT value INTO stage FROM jsonb_array_elements(definition->'stages') value WHERE value->>'id' = match->>'stageId';
    stage_kind := stage->>'kind';
    IF stage_kind = 'group' THEN
      IF NOT match ? 'poolId' OR NOT (stage->'groupIds' ? (match->>'poolId')) THEN RETURN false; END IF;
    ELSIF match ? 'poolId' THEN
      RETURN false;
    END IF;
    FOR source IN SELECT value FROM jsonb_array_elements(jsonb_build_array(match->'home', match->'away')) LOOP
      IF source->>'type' = 'stage_rank' THEN
        SELECT value INTO stage FROM jsonb_array_elements(definition->'stages') value WHERE value->>'id' = source->>'stageId';
        IF stage IS NULL OR stage->>'kind' NOT IN ('group','round_robin')
           OR (stage->>'order')::integer >= (SELECT (value->>'order')::integer FROM jsonb_array_elements(definition->'stages') value WHERE value->>'id' = match->>'stageId')
           OR (source->>'rank')::integer > (stage->>'outputRanks')::integer
           OR (stage->>'kind' = 'group' AND (NOT source ? 'groupId' OR NOT (stage->'groupIds' ? (source->>'groupId'))))
           OR (stage->>'kind' = 'round_robin' AND source ? 'groupId') THEN
          RETURN false;
        END IF;
      ELSIF source->>'type' IN ('winner','loser') THEN
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'matches') AS parent(value)
                       WHERE parent.value->>'id' = source->>'matchId'
                         AND (parent.value->>'order')::integer < (match->>'order')::integer) THEN
          RETURN false;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  -- Non-pool advancement slots are single-consumer; pool seeds intentionally
  -- recur for complete round-robin pairings.
  IF EXISTS (
    SELECT source_value
    FROM (
      SELECT source_item.value AS source_value
      FROM jsonb_array_elements(definition->'matches') AS graph_match(value)
      JOIN jsonb_array_elements(definition->'stages') AS graph_stage(value)
        ON graph_stage.value->>'id' = graph_match.value->>'stageId'
      CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(graph_match.value->'home', graph_match.value->'away')) AS source_item(value)
      WHERE graph_stage.value->>'kind' NOT IN ('group','round_robin')
    ) sources
    GROUP BY source_value HAVING count(*) > 1
  ) THEN
    RETURN false;
  END IF;

  -- Recompute complete group/round-robin pairing counts. This makes the stored
  -- match count deterministic instead of accepting a caller's evidence flag.
  FOR stage IN SELECT value FROM jsonb_array_elements(definition->'stages') WHERE value->>'kind' IN ('group','round_robin') LOOP
    stage_id := stage->>'id';
    stage_kind := stage->>'kind';
    FOR pool_id IN
      SELECT value FROM jsonb_array_elements_text(
        CASE WHEN stage_kind = 'group' THEN stage->'groupIds' ELSE jsonb_build_array('') END
      )
    LOOP
      pool_size := CASE WHEN stage_kind = 'group' THEN (stage->>'groupSize')::integer ELSE entry_count END;
      expected_matches := pool_size * (pool_size - 1) / 2;
      WITH pool_matches AS (
        SELECT graph_match.value AS match_definition
        FROM jsonb_array_elements(definition->'matches') AS graph_match(value)
        WHERE graph_match.value->>'stageId' = stage_id
          AND (CASE WHEN stage_kind = 'group' THEN graph_match.value->>'poolId' = pool_id ELSE NOT graph_match.value ? 'poolId' END)
      ), pairs AS (
        SELECT LEAST((match_definition->'home'->>'seed')::integer,(match_definition->'away'->>'seed')::integer) low_seed,
               GREATEST((match_definition->'home'->>'seed')::integer,(match_definition->'away'->>'seed')::integer) high_seed
        FROM pool_matches
        WHERE match_definition->'home'->>'type' = 'entry_seed' AND match_definition->'away'->>'type' = 'entry_seed'
      ), seed_uses AS (
        SELECT seed, count(*) uses FROM (
          SELECT (match_definition->'home'->>'seed')::integer seed FROM pool_matches WHERE match_definition->'home'->>'type' = 'entry_seed'
          UNION ALL
          SELECT (match_definition->'away'->>'seed')::integer seed FROM pool_matches WHERE match_definition->'away'->>'type' = 'entry_seed'
        ) slots GROUP BY seed
      )
      SELECT (SELECT count(*) FROM pool_matches),
             (SELECT count(DISTINCT (low_seed,high_seed)) FROM pairs),
             (SELECT count(*) FROM seed_uses),
             (SELECT min(uses) FROM seed_uses),
             (SELECT max(uses) FROM seed_uses)
      INTO actual_matches, distinct_pairs, distinct_seeds, minimum_seed_uses, maximum_seed_uses;
      IF actual_matches <> expected_matches OR distinct_pairs <> expected_matches
         OR distinct_seeds <> pool_size OR minimum_seed_uses <> pool_size - 1 OR maximum_seed_uses <> pool_size - 1 THEN
        RETURN false;
      END IF;
    END LOOP;
    IF stage_kind = 'group' AND (
      SELECT count(DISTINCT seed) <> entry_count FROM (
        SELECT (graph_match.value->'home'->>'seed')::integer seed
        FROM jsonb_array_elements(definition->'matches') AS graph_match(value)
        WHERE graph_match.value->>'stageId' = stage_id
        UNION ALL
        SELECT (graph_match.value->'away'->>'seed')::integer seed
        FROM jsonb_array_elements(definition->'matches') AS graph_match(value)
        WHERE graph_match.value->>'stageId' = stage_id
      ) group_seeds
    ) THEN
      RETURN false;
    END IF;
  END LOOP;

  -- Terminal IDs are exact sinks. With forward-only references, requiring
  -- every non-pool sink to be terminal proves reachability to a terminal.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'terminalMatchIds') terminal WHERE jsonb_typeof(terminal) <> 'string' OR length(terminal #>> '{}') = 0)
     OR (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements_text(definition->'terminalMatchIds'))
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(definition->'terminalMatchIds') terminal
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'matches') AS graph_match(value)
                         WHERE graph_match.value->>'id' = terminal)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'matches') AS consumer(value)
                     WHERE (consumer.value->'home'->>'type' IN ('winner','loser') AND consumer.value->'home'->>'matchId' = terminal)
                        OR (consumer.value->'away'->>'type' IN ('winner','loser') AND consumer.value->'away'->>'matchId' = terminal))
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(definition->'matches') AS graph_match(value)
       JOIN jsonb_array_elements(definition->'stages') AS graph_stage(value)
         ON graph_stage.value->>'id' = graph_match.value->>'stageId'
       WHERE graph_stage.value->>'kind' NOT IN ('group','round_robin')
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'matches') AS consumer(value)
                         WHERE (consumer.value->'home'->>'type' IN ('winner','loser') AND consumer.value->'home'->>'matchId' = graph_match.value->>'id')
                            OR (consumer.value->'away'->>'type' IN ('winner','loser') AND consumer.value->'away'->>'matchId' = graph_match.value->>'id'))
         AND NOT (definition->'terminalMatchIds' ? (graph_match.value->>'id'))
     ) THEN
    RETURN false;
  END IF;

  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase3_reject_invalid_format_revision() RETURNS trigger AS $$
BEGIN
  -- postgres.js serialises values supplied to unsafe jsonb parameters once
  -- more than tagged sql.json values. Canonicalise that bounded transport
  -- representation before validating and storing the graph.
  IF jsonb_typeof(NEW.definition) = 'string' THEN
    NEW.definition := (NEW.definition #>> '{}')::jsonb;
  END IF;
  IF NOT phase3_format_definition_db_valid(NEW.definition) THEN
    RAISE EXCEPTION 'format revision definition is structurally invalid';
  END IF;
  IF NEW.definition_hash <> encode(pg_catalog.sha256(convert_to(phase3_canonical_jsonb(NEW.definition), 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'format revision definition hash does not match definition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER format_revisions_phase3_definition_guard
BEFORE INSERT OR UPDATE OF definition, definition_hash ON format_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_reject_invalid_format_revision();

CREATE OR REPLACE FUNCTION phase3_validate_format_evidence() RETURNS trigger AS $$
DECLARE
  revision format_revisions%ROWTYPE;
  actual_slots integer;
  required_slots integer;
BEGIN
  SELECT * INTO revision FROM format_revisions WHERE id = NEW.format_revision_id;
  IF revision.id IS NULL OR NEW.definition_hash <> revision.definition_hash
     OR NOT phase3_format_definition_db_valid(revision.definition) THEN
    RAISE EXCEPTION 'format validation evidence does not match immutable definition';
  END IF;
  actual_slots := phase3_available_match_slots(revision.competition_id);
  required_slots := jsonb_array_length(revision.definition->'matches');
  -- These values are database-owned recomputations, not caller attestations.
  NEW.valid := true;
  NEW.graph_acyclic := true;
  NEW.graph_reachable := true;
  NEW.slots_unambiguous := true;
  NEW.deterministic_match_count := required_slots;
  NEW.available_match_slots := actual_slots;
  NEW.required_match_slots := required_slots;
  NEW.recommendation_fits_capacity := actual_slots >= required_slots;
  NEW.issues := '[]'::jsonb;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase3_prevent_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Migration 0006 returned NEW from a DELETE trigger. NEW is null for DELETE,
-- which silently cancelled draft deletes before later guards could reject
-- them. Preserve schedule draft deletion while returning the correct row.
CREATE OR REPLACE FUNCTION prevent_published_revision_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'superseded'
     OR (OLD.status = 'published' AND (
       TG_OP = 'DELETE'
       OR NEW.status <> 'superseded'
       OR (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status')
     )) THEN
    RAISE EXCEPTION 'published revisions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER format_revisions_phase3_immutable_delete
BEFORE DELETE ON format_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();

CREATE TRIGGER sport_pack_versions_phase3_immutable
BEFORE UPDATE OR DELETE ON sport_pack_versions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();

CREATE TRIGGER standings_snapshots_phase3_immutable
BEFORE UPDATE OR DELETE ON standings_snapshots
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_append_only_mutation();

-- Current snapshot payloads are still accepted from the API. Record that fact
-- explicitly, while providing a generated source-version anchor for a later
-- privileged, server-calculated insertion path. No row can falsely claim
-- server ownership in this migration.
ALTER TABLE standings_snapshots
  ADD COLUMN source_result_version integer GENERATED ALWAYS AS (result_version) STORED,
  ADD COLUMN calculation_provenance text NOT NULL DEFAULT 'client_supplied_unverified',
  ADD CONSTRAINT standings_snapshots_calculation_provenance_check
    CHECK (calculation_provenance = 'client_supplied_unverified'),
  ADD CONSTRAINT standings_snapshots_source_version_check
    CHECK (source_result_version > 0);
