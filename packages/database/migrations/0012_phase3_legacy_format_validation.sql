-- Close the legacy Phase 2 format-revision escape hatch without rewriting
-- deployed migrations. New callers default to the strict Phase 3 contract;
-- the retained Phase 2 contract accepts only its exact, internally consistent
-- balanced Canoe Polo document and a database-recomputed canonical hash.

CREATE FUNCTION phase3_phase2_source_shape_valid(source jsonb) RETURNS boolean AS $$
BEGIN
  IF jsonb_typeof(source) <> 'object' OR jsonb_typeof(source->'type') <> 'string' THEN
    RETURN false;
  END IF;
  IF source->>'type' = 'entry' THEN
    RETURN (SELECT count(*) = 2 AND bool_and(key = ANY (ARRAY['type','entryId'])) FROM jsonb_object_keys(source) key)
      AND jsonb_typeof(source->'entryId') = 'string'
      AND (source->>'entryId')::uuid IS NOT NULL;
  ELSIF source->>'type' = 'group_rank' THEN
    RETURN (SELECT count(*) = 3 AND bool_and(key = ANY (ARRAY['type','groupId','rank'])) FROM jsonb_object_keys(source) key)
      AND jsonb_typeof(source->'groupId') = 'string' AND length(source->>'groupId') > 0
      AND phase3_json_positive_integer(source->'rank') AND (source->>'rank')::integer <= 2;
  ELSIF source->>'type' IN ('winner','loser') THEN
    RETURN (SELECT count(*) = 2 AND bool_and(key = ANY (ARRAY['type','matchId'])) FROM jsonb_object_keys(source) key)
      AND jsonb_typeof(source->'matchId') = 'string'
      AND (source->>'matchId')::uuid IS NOT NULL;
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase3_phase2_format_definition_db_valid(definition jsonb) RETURNS boolean AS $$
DECLARE
  entry_count integer;
  expected_groups integer;
  expected_matches integer;
  group_definition jsonb;
  match_definition jsonb;
  source jsonb;
  dependency text;
BEGIN
  IF jsonb_typeof(definition) <> 'object'
     OR (SELECT count(*) <> 6 OR NOT bool_and(key = ANY (ARRAY['id','version','entryCount','groups','matches','knockoutMatchIds']))
         FROM jsonb_object_keys(definition) key)
     OR jsonb_typeof(definition->'id') <> 'string'
     OR (definition->>'id')::uuid IS NULL
     OR definition->'version' <> '1'::jsonb
     OR definition->'entryCount' NOT IN ('8'::jsonb, '16'::jsonb)
     OR jsonb_typeof(definition->'groups') <> 'array'
     OR jsonb_typeof(definition->'matches') <> 'array'
     OR jsonb_typeof(definition->'knockoutMatchIds') <> 'array' THEN
    RETURN false;
  END IF;

  entry_count := (definition->>'entryCount')::integer;
  expected_groups := entry_count / 4;
  expected_matches := CASE entry_count WHEN 8 THEN 16 ELSE 32 END;
  IF jsonb_array_length(definition->'groups') <> expected_groups
     OR jsonb_array_length(definition->'matches') <> expected_matches
     OR jsonb_array_length(definition->'knockoutMatchIds') <> expected_matches - expected_groups * 6 THEN
    RETURN false;
  END IF;

  FOR group_definition IN SELECT value FROM jsonb_array_elements(definition->'groups') LOOP
    IF jsonb_typeof(group_definition) <> 'object'
       OR (SELECT count(*) <> 3 OR NOT bool_and(key = ANY (ARRAY['id','entryIds','matchIds']))
           FROM jsonb_object_keys(group_definition) key)
       OR jsonb_typeof(group_definition->'id') <> 'string' OR length(group_definition->>'id') = 0
       OR jsonb_typeof(group_definition->'entryIds') <> 'array'
       OR jsonb_typeof(group_definition->'matchIds') <> 'array'
       OR jsonb_array_length(group_definition->'entryIds') <> 4
       OR jsonb_array_length(group_definition->'matchIds') <> 6
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(group_definition->'entryIds') item WHERE item::uuid IS NULL)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(group_definition->'matchIds') item WHERE item::uuid IS NULL)
       OR (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements_text(group_definition->'entryIds'))
       OR (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements_text(group_definition->'matchIds')) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF (SELECT count(*) <> count(DISTINCT item.value->>'id') FROM jsonb_array_elements(definition->'groups') item)
     OR (SELECT count(*) <> count(DISTINCT entry_id) FROM jsonb_array_elements(definition->'groups') group_item
         CROSS JOIN LATERAL jsonb_array_elements_text(group_item.value->'entryIds') entry_id)
     OR (SELECT count(*) FROM jsonb_array_elements(definition->'groups') group_item
         CROSS JOIN LATERAL jsonb_array_elements_text(group_item.value->'entryIds')) <> entry_count
     OR (SELECT count(*) <> count(DISTINCT match_id) FROM jsonb_array_elements(definition->'groups') group_item
         CROSS JOIN LATERAL jsonb_array_elements_text(group_item.value->'matchIds') match_id) THEN
    RETURN false;
  END IF;

  FOR match_definition IN SELECT value FROM jsonb_array_elements(definition->'matches') LOOP
    IF jsonb_typeof(match_definition) <> 'object'
       OR (SELECT count(*) <> 7 OR NOT bool_and(key = ANY (ARRAY['id','stage','round','order','home','away','dependencyMatchIds']))
           FROM jsonb_object_keys(match_definition) key)
       OR jsonb_typeof(match_definition->'id') <> 'string' OR (match_definition->>'id')::uuid IS NULL
       OR jsonb_typeof(match_definition->'stage') <> 'string'
       OR match_definition->>'stage' NOT IN ('group','quarterfinal','semifinal','bronze','final')
       OR NOT phase3_json_positive_integer(match_definition->'round')
       OR NOT phase3_json_positive_integer(match_definition->'order')
       OR NOT phase3_phase2_source_shape_valid(match_definition->'home')
       OR NOT phase3_phase2_source_shape_valid(match_definition->'away')
       OR match_definition->'home' = match_definition->'away'
       OR jsonb_typeof(match_definition->'dependencyMatchIds') <> 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(match_definition->'dependencyMatchIds') item WHERE item::uuid IS NULL)
       OR (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements_text(match_definition->'dependencyMatchIds')) THEN
      RETURN false;
    END IF;
  END LOOP;

  IF (SELECT count(*) <> count(DISTINCT item.value->>'id') FROM jsonb_array_elements(definition->'matches') item)
     OR (SELECT count(*) <> count(DISTINCT (item.value->>'order')::integer) FROM jsonb_array_elements(definition->'matches') item)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(definition->'groups') group_item
       CROSS JOIN LATERAL jsonb_array_elements_text(group_item.value->'matchIds') group_match_id
       WHERE NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(definition->'matches') match_item
         WHERE match_item.value->>'id' = group_match_id AND match_item.value->>'stage' = 'group'
       )
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(definition->'matches') match_item
       WHERE (match_item.value->>'stage' = 'group') IS DISTINCT FROM EXISTS (
         SELECT 1 FROM jsonb_array_elements(definition->'groups') group_item
         WHERE group_item.value->'matchIds' ? (match_item.value->>'id')
       )
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(definition->'matches') match_item
       WHERE (match_item.value->>'stage' <> 'group') IS DISTINCT FROM (definition->'knockoutMatchIds' ? (match_item.value->>'id'))
     )
     OR (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements_text(definition->'knockoutMatchIds')) THEN
    RETURN false;
  END IF;

  FOR match_definition IN SELECT value FROM jsonb_array_elements(definition->'matches') LOOP
    IF match_definition->>'stage' = 'group' THEN
      IF jsonb_array_length(match_definition->'dependencyMatchIds') <> 0
         OR match_definition->'home'->>'type' <> 'entry'
         OR match_definition->'away'->>'type' <> 'entry'
         OR NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(definition->'groups') group_item
           WHERE group_item.value->'matchIds' ? (match_definition->>'id')
             AND group_item.value->'entryIds' ? (match_definition->'home'->>'entryId')
             AND group_item.value->'entryIds' ? (match_definition->'away'->>'entryId')
         ) THEN
        RETURN false;
      END IF;
    END IF;

    FOR dependency IN SELECT value FROM jsonb_array_elements_text(match_definition->'dependencyMatchIds') LOOP
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(definition->'matches') parent
        WHERE parent.value->>'id' = dependency
          AND (parent.value->>'order')::integer < (match_definition->>'order')::integer
      ) THEN RETURN false; END IF;
    END LOOP;

    FOR source IN SELECT value FROM jsonb_array_elements(jsonb_build_array(match_definition->'home', match_definition->'away')) LOOP
      IF source->>'type' = 'entry' THEN
        IF NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(definition->'groups') group_item
          WHERE group_item.value->'entryIds' ? (source->>'entryId')
        ) THEN RETURN false; END IF;
      ELSIF source->>'type' = 'group_rank' THEN
        IF NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(definition->'groups') group_item
          WHERE group_item.value->>'id' = source->>'groupId'
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(group_item.value->'matchIds') required_id
              WHERE NOT (match_definition->'dependencyMatchIds' ? required_id)
            )
        ) THEN RETURN false; END IF;
      ELSE
        IF NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(definition->'matches') parent
          WHERE parent.value->>'id' = source->>'matchId'
            AND (parent.value->>'order')::integer < (match_definition->>'order')::integer
            AND match_definition->'dependencyMatchIds' ? (source->>'matchId')
        ) THEN RETURN false; END IF;
      END IF;
    END LOOP;
  END LOOP;

  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The Phase 3 structural validator previously bounded every direct seed but did
-- not prove that every entrant entered the graph. Keep the original validator
-- as the shape/dependency check and make complete entrant coverage part of the
-- canonical validation contract. Pool seeds may repeat; knockout bye seeds may
-- first appear in a later round.
ALTER FUNCTION phase3_format_definition_db_valid(jsonb)
  RENAME TO phase3_format_definition_structure_db_valid;

CREATE FUNCTION phase3_format_definition_db_valid(definition jsonb) RETURNS boolean AS $$
DECLARE
  entry_count integer;
  covered_seed_count integer;
  normalized_definition jsonb := definition;
  match_index integer;
  slot_name text;
  source jsonb;
  source_stage jsonb;
  first_group_id text;
BEGIN
  -- A group-stage stage_rank without groupId is the explicit persisted form
  -- of "rank N across all groups". The legacy structural validator predates
  -- that discriminator and required a concrete group, so validate a temporary
  -- representative group while retaining the original immutable document.
  IF jsonb_typeof(definition->'matches')='array' AND jsonb_typeof(definition->'stages')='array' THEN
    FOR match_index IN 0..jsonb_array_length(definition->'matches')-1 LOOP
      FOREACH slot_name IN ARRAY ARRAY['home','away'] LOOP
        source := definition->'matches'->match_index->slot_name;
        IF source->>'type'='stage_rank' AND NOT source ? 'groupId' THEN
          SELECT value INTO source_stage
          FROM jsonb_array_elements(definition->'stages') item(value)
          WHERE item.value->>'id'=source->>'stageId';
          IF source_stage->>'kind'='group' THEN
            first_group_id := source_stage->'groupIds'->>0;
            IF first_group_id IS NULL THEN RETURN false; END IF;
            normalized_definition := jsonb_set(
              normalized_definition,
              ARRAY['matches',match_index::text,slot_name],
              source || jsonb_build_object('groupId',first_group_id),
              false
            );
          END IF;
        END IF;
      END LOOP;
    END LOOP;
  END IF;
  IF NOT phase3_format_definition_structure_db_valid(normalized_definition) THEN
    RETURN false;
  END IF;
  entry_count := (definition->>'entryCount')::integer;
  SELECT count(DISTINCT (source_item.value->>'seed')::integer)
  INTO covered_seed_count
  FROM jsonb_array_elements(definition->'matches') graph_match(value)
  CROSS JOIN LATERAL jsonb_array_elements(
    jsonb_build_array(graph_match.value->'home', graph_match.value->'away')
  ) source_item(value)
  WHERE source_item.value->>'type' = 'entry_seed';
  RETURN covered_seed_count = entry_count;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Drafts may be designed before registration. Once eligible entries exist,
-- however, the graph must describe exactly that confirmed/active population,
-- and it may never exceed the division's configured limit.
CREATE FUNCTION phase3_format_entry_count_matches_division(definition jsonb, target_division_id uuid)
RETURNS boolean AS $$
DECLARE
  definition_entry_count integer;
  division_team_limit integer;
  eligible_entry_count integer;
BEGIN
  definition_entry_count := (definition->>'entryCount')::integer;
  SELECT team_limit INTO division_team_limit FROM divisions WHERE id=target_division_id;
  IF division_team_limit IS NULL OR definition_entry_count > division_team_limit THEN
    RETURN false;
  END IF;
  SELECT count(*) INTO eligible_entry_count
  FROM division_entries
  WHERE division_id=target_division_id AND status IN ('confirmed','active');
  RETURN eligible_entry_count = 0 OR eligible_entry_count = definition_entry_count;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

ALTER TABLE format_revisions ALTER COLUMN validation_contract SET DEFAULT 'phase3';

CREATE OR REPLACE FUNCTION phase3_reject_invalid_format_revision() RETURNS trigger AS $$
DECLARE expected_hash text;
BEGIN
  IF jsonb_typeof(NEW.definition) = 'string' THEN
    NEW.definition := (NEW.definition #>> '{}')::jsonb;
  END IF;
  IF NOT phase3_format_entry_count_matches_division(NEW.definition,NEW.division_id) THEN
    RAISE EXCEPTION 'format revision entry count does not match division eligibility and limit';
  END IF;
  expected_hash := encode(pg_catalog.sha256(convert_to(phase3_canonical_jsonb(NEW.definition), 'UTF8')), 'hex');
  IF NEW.validation_contract = 'phase2' THEN
    IF NOT phase3_phase2_format_definition_db_valid(NEW.definition) THEN
      RAISE EXCEPTION 'phase2 format revision definition is structurally invalid';
    END IF;
  ELSIF NEW.validation_contract = 'phase3' THEN
    IF NOT phase3_format_definition_db_valid(NEW.definition) THEN
      RAISE EXCEPTION 'format revision definition is structurally invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'format revision validation contract is invalid';
  END IF;
  IF NEW.definition_hash <> expected_hash THEN
    RAISE EXCEPTION 'format revision definition hash does not match definition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Sport-pack activation is an explicit, serialized lifecycle. Inserts are
-- drafts by default; at most one version per sport can be current.
ALTER TABLE sport_pack_versions
  DROP CONSTRAINT sport_pack_versions_status_check,
  DROP CONSTRAINT sport_pack_versions_activation_shape,
  ALTER COLUMN status SET DEFAULT 'draft',
  ALTER COLUMN activated_at DROP DEFAULT,
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN superseded_by uuid REFERENCES accounts(id),
  ADD COLUMN superseded_by_version text;

ALTER TABLE sport_pack_versions
  ADD CONSTRAINT sport_pack_versions_status_check CHECK (status IN ('draft','active','superseded')),
  ADD CONSTRAINT sport_pack_versions_activation_shape CHECK (
    (status='draft' AND activated_at IS NULL AND activated_by IS NULL
      AND superseded_at IS NULL AND superseded_by IS NULL AND superseded_by_version IS NULL)
    OR (status='active' AND activated_at IS NOT NULL
      AND superseded_at IS NULL AND superseded_by IS NULL AND superseded_by_version IS NULL)
    OR (status='superseded' AND activated_at IS NOT NULL
      AND superseded_at IS NOT NULL AND superseded_by IS NOT NULL
      AND btrim(superseded_by_version)<>'' AND superseded_by_version<>version)
  ),
  ADD CONSTRAINT sport_pack_versions_successor_fk
    FOREIGN KEY (sport_code,superseded_by_version)
    REFERENCES sport_pack_versions(sport_code,version) DEFERRABLE INITIALLY DEFERRED;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sport_pack_versions WHERE status='active'
    GROUP BY sport_code HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'multiple active sport pack versions require reconciliation'; END IF;
END;
$$;

CREATE UNIQUE INDEX sport_pack_versions_one_active_per_sport
ON sport_pack_versions(sport_code) WHERE status='active';

CREATE FUNCTION phase3_verify_sport_pack_hash() RETURNS trigger AS $$
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

CREATE TRIGGER sport_pack_versions_z_hash_guard
BEFORE INSERT OR UPDATE OF definition,definition_hash ON sport_pack_versions
FOR EACH ROW EXECUTE FUNCTION phase3_verify_sport_pack_hash();

CREATE OR REPLACE FUNCTION phase3_guard_sport_pack_lifecycle() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'sport pack versions are append-only'; END IF;
  IF OLD.status='superseded' THEN RAISE EXCEPTION 'superseded sport pack versions are immutable'; END IF;
  IF NEW.sport_code IS DISTINCT FROM OLD.sport_code
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sport pack version content is immutable';
  END IF;
  IF OLD.status='draft' AND NEW.status='active'
     AND NEW.revision=OLD.revision+1
     AND NEW.activated_at IS NOT NULL AND NEW.activated_by IS NOT NULL
     AND NEW.superseded_at IS NULL AND NEW.superseded_by IS NULL AND NEW.superseded_by_version IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status='active' AND NEW.status='superseded'
     AND NEW.revision=OLD.revision+1
     AND NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at
     AND NEW.activated_by IS NOT DISTINCT FROM OLD.activated_by
     AND NEW.superseded_at IS NOT NULL AND NEW.superseded_by IS NOT NULL
     AND btrim(NEW.superseded_by_version)<>'' AND NEW.superseded_by_version<>OLD.version THEN
    RETURN NEW;
  END IF;
  IF OLD.status='active' THEN RAISE EXCEPTION 'active sport pack lifecycle transition is invalid'; END IF;
  IF OLD.status='superseded' THEN RAISE EXCEPTION 'superseded sport pack versions are immutable'; END IF;
  RAISE EXCEPTION 'sport pack lifecycle transition is invalid';
END;
$$ LANGUAGE plpgsql;

-- Resolve every competition-owned row to its aggregate root. Direct
-- competition_id columns are preferred; the remaining scoring and graph rows
-- resolve through their owning match/revision.
CREATE FUNCTION phase3_nested_row_competition(target_table text, row_value jsonb) RETURNS uuid AS $$
DECLARE target_competition uuid;
BEGIN
  IF row_value IS NULL THEN RETURN NULL; END IF;
  IF row_value ? 'competition_id' THEN
    RETURN (row_value->>'competition_id')::uuid;
  END IF;

  CASE target_table
    WHEN 'division_entries' THEN
      SELECT competition_id INTO target_competition
      FROM divisions WHERE id=(row_value->>'division_id')::uuid;
    WHEN 'format_validation_evidence' THEN
      SELECT competition_id INTO target_competition
      FROM format_revisions WHERE id=(row_value->>'format_revision_id')::uuid;
    WHEN 'match_dependencies' THEN
      SELECT competition_id INTO target_competition
      FROM matches
      WHERE id=COALESCE((row_value->>'match_id')::uuid,(row_value->>'source_match_id')::uuid);
      IF target_competition IS NULL THEN
        SELECT competition_id INTO target_competition
        FROM matches WHERE id=(row_value->>'source_match_id')::uuid;
      END IF;
    WHEN 'scoring_access_passes', 'scoring_access_sessions', 'match_writer_leases',
         'score_events', 'match_result_snapshots' THEN
      SELECT competition_id INTO target_competition
      FROM matches WHERE id=(row_value->>'match_id')::uuid;
    ELSE
      target_competition := NULL;
  END CASE;
  RETURN target_competition;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase3_guard_nested_competition_mutation() RETURNS trigger AS $$
DECLARE
  old_value jsonb := CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_value jsonb := CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  old_competition uuid := phase3_nested_row_competition(TG_TABLE_NAME,old_value);
  new_competition uuid := phase3_nested_row_competition(TG_TABLE_NAME,new_value);
BEGIN
  -- A missing root is permitted only while PostgreSQL is executing the root's
  -- ON DELETE CASCADE. All ordinary writes lock and validate the aggregate.
  IF old_competition IS NOT NULL AND (
    TG_OP<>'DELETE' OR EXISTS (SELECT 1 FROM competitions WHERE id=old_competition)
  ) THEN
    PERFORM phase3_assert_competition_mutable(old_competition);
  END IF;
  IF new_competition IS NOT NULL AND new_competition IS DISTINCT FROM old_competition THEN
    PERFORM phase3_assert_competition_mutable(new_competition);
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER aa_matches_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON matches
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_match_dependencies_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON match_dependencies
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_schedule_revisions_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_scheduled_matches_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON scheduled_matches
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_competition_publications_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON competition_publications
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_scoring_access_passes_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON scoring_access_passes
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_scoring_access_sessions_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON scoring_access_sessions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_match_writer_leases_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON match_writer_leases
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_score_events_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON score_events
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_match_result_snapshots_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON match_result_snapshots
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_bracket_snapshots_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON bracket_snapshots
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER aa_public_competition_projections_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON public_competition_projections
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();

-- Internal RESTRICT edges make a root cascade order-dependent. Preserve their
-- direct-delete protection while deferring NO ACTION checks until the root's
-- complete competition graph has been removed.
ALTER TABLE matches
  DROP CONSTRAINT matches_format_revision_id_fkey,
  ADD CONSTRAINT matches_format_revision_id_fkey FOREIGN KEY (format_revision_id)
    REFERENCES format_revisions(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE match_dependencies
  DROP CONSTRAINT match_dependencies_source_match_id_fkey,
  DROP CONSTRAINT match_dependencies_source_match_id_format_revision_id_fkey,
  ADD CONSTRAINT match_dependencies_source_match_id_fkey FOREIGN KEY (source_match_id)
    REFERENCES matches(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT match_dependencies_source_match_id_format_revision_id_fkey
    FOREIGN KEY (source_match_id,format_revision_id)
    REFERENCES matches(id,format_revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE schedule_revisions
  DROP CONSTRAINT schedule_revisions_format_revision_id_fkey,
  ADD CONSTRAINT schedule_revisions_format_revision_id_fkey FOREIGN KEY (format_revision_id)
    REFERENCES format_revisions(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE scheduled_matches
  DROP CONSTRAINT scheduled_matches_playing_area_id_fkey,
  DROP CONSTRAINT scheduled_matches_playing_area_id_competition_id_fkey,
  ADD CONSTRAINT scheduled_matches_playing_area_id_fkey FOREIGN KEY (playing_area_id)
    REFERENCES playing_areas(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT scheduled_matches_playing_area_id_competition_id_fkey
    FOREIGN KEY (playing_area_id,competition_id)
    REFERENCES playing_areas(id,competition_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE competition_publications
  DROP CONSTRAINT competition_publications_published_schedule_revision_id_fkey,
  DROP CONSTRAINT competition_publications_published_schedule_revision_id_co_fkey,
  ADD CONSTRAINT competition_publications_published_schedule_revision_id_fkey
    FOREIGN KEY (published_schedule_revision_id) REFERENCES schedule_revisions(id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT competition_publications_published_schedule_revision_id_co_fkey
    FOREIGN KEY (published_schedule_revision_id,competition_id)
    REFERENCES schedule_revisions(id,competition_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE advancement_slots
  DROP CONSTRAINT advancement_slots_source_snapshot_id_fkey,
  ADD CONSTRAINT advancement_slots_source_snapshot_id_fkey FOREIGN KEY (source_snapshot_id)
    REFERENCES standings_snapshots(id) DEFERRABLE INITIALLY DEFERRED;

-- Append-only/history guards must not turn an aggregate root's declared
-- ON DELETE CASCADE into an undeletable graph.
CREATE FUNCTION phase3_prevent_aggregate_history_mutation() RETURNS trigger AS $$
DECLARE target_competition uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    target_competition := phase3_nested_row_competition(TG_TABLE_NAME,to_jsonb(OLD));
    IF target_competition IS NULL OR NOT EXISTS (
      SELECT 1 FROM competitions WHERE id=target_competition
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '%', TG_ARGV[0];
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER score_events_no_update ON score_events;
CREATE TRIGGER score_events_no_update BEFORE UPDATE OR DELETE ON score_events
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_aggregate_history_mutation('score_events are append-only');

DROP TRIGGER format_validation_evidence_phase3_immutable ON format_validation_evidence;
CREATE TRIGGER format_validation_evidence_phase3_immutable BEFORE UPDATE OR DELETE ON format_validation_evidence
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_aggregate_history_mutation('format validation evidence is append-only');

DROP TRIGGER format_revisions_phase3_immutable_delete ON format_revisions;
CREATE TRIGGER format_revisions_phase3_immutable_delete BEFORE DELETE ON format_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_aggregate_history_mutation('format_revisions is append-only');

DROP TRIGGER standings_snapshots_phase3_immutable ON standings_snapshots;
CREATE TRIGGER standings_snapshots_phase3_immutable BEFORE UPDATE OR DELETE ON standings_snapshots
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_aggregate_history_mutation('standings snapshots are append-only');

DROP TRIGGER advancement_conflicts_phase3_immutable ON advancement_conflicts;
CREATE TRIGGER advancement_conflicts_phase3_immutable BEFORE UPDATE OR DELETE ON advancement_conflicts
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_aggregate_history_mutation('advancement conflict history is append-only');

CREATE OR REPLACE FUNCTION phase3_guard_entry_import_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM competitions WHERE id=OLD.competition_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'entry import records are append-only';
  END IF;
  IF OLD.rolled_back_at IS NOT NULL THEN RAISE EXCEPTION 'rolled-back entry imports are immutable'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.competition_id IS DISTINCT FROM OLD.competition_id
     OR NEW.division_id IS DISTINCT FROM OLD.division_id OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.mapping IS DISTINCT FROM OLD.mapping OR NEW.row_count IS DISTINCT FROM OLD.row_count
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'entry import source records are immutable';
  END IF;
  IF NEW.rolled_back_at IS NULL OR NEW.rolled_back_by IS NULL OR btrim(NEW.rollback_request_id)='' THEN
    RAISE EXCEPTION 'entry import rollback requires complete provenance';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_published_revision_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM competitions WHERE id=OLD.competition_id) THEN RETURN OLD; END IF;
  IF OLD.status='superseded'
     OR (OLD.status='published' AND (
       TG_OP='DELETE' OR NEW.status<>'superseded'
       OR (to_jsonb(NEW)-'status')<>(to_jsonb(OLD)-'status')
     )) THEN
    RAISE EXCEPTION 'published revisions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_published_match_graph() RETURNS trigger AS $$
DECLARE revision_id uuid; revision_status text;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM competitions WHERE id=OLD.competition_id) THEN RETURN OLD; END IF;
  revision_id := CASE WHEN TG_OP='DELETE' THEN OLD.format_revision_id ELSE NEW.format_revision_id END;
  SELECT status INTO revision_status FROM format_revisions WHERE id=revision_id;
  IF revision_status IN ('published','superseded') AND (
    TG_OP<>'UPDATE' OR NEW.format_revision_id<>OLD.format_revision_id OR NEW.code<>OLD.code
    OR NEW.stage<>OLD.stage OR NEW.round_number<>OLD.round_number OR NEW.ordinal<>OLD.ordinal
  ) THEN
    RAISE EXCEPTION 'published match graphs are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_published_match_dependency() RETURNS trigger AS $$
DECLARE revision_id uuid; revision_status text; target_competition uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    target_competition := phase3_nested_row_competition(TG_TABLE_NAME,to_jsonb(OLD));
    IF target_competition IS NULL OR NOT EXISTS (SELECT 1 FROM competitions WHERE id=target_competition) THEN RETURN OLD; END IF;
  END IF;
  revision_id := CASE WHEN TG_OP='DELETE' THEN OLD.format_revision_id ELSE NEW.format_revision_id END;
  SELECT status INTO revision_status FROM format_revisions WHERE id=revision_id;
  IF revision_status IN ('published','superseded') THEN
    RAISE EXCEPTION 'published match dependencies are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_published_schedule_assignment() RETURNS trigger AS $$
DECLARE revision_id uuid; revision_status text;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM competitions WHERE id=OLD.competition_id) THEN RETURN OLD; END IF;
  revision_id := CASE WHEN TG_OP='DELETE' THEN OLD.schedule_revision_id ELSE NEW.schedule_revision_id END;
  SELECT status INTO revision_status FROM schedule_revisions WHERE id=revision_id;
  IF revision_status IN ('published','superseded') THEN
    RAISE EXCEPTION 'published schedule assignments are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase3_require_validated_format_publish() RETURNS trigger AS $$
DECLARE expected_hash text;
BEGIN
  IF NEW.status <> 'published' OR (TG_OP = 'UPDATE' AND OLD.status = 'published') THEN
    RETURN NEW;
  END IF;
  IF NOT phase3_format_entry_count_matches_division(NEW.definition,NEW.division_id) THEN
    RAISE EXCEPTION 'format publish entry count does not match division eligibility and limit';
  END IF;
  expected_hash := encode(pg_catalog.sha256(convert_to(phase3_canonical_jsonb(NEW.definition), 'UTF8')), 'hex');
  IF NEW.definition_hash <> expected_hash THEN
    RAISE EXCEPTION 'format publish requires a database-verified definition hash';
  END IF;
  IF NEW.validation_contract = 'phase2' THEN
    IF NOT phase3_phase2_format_definition_db_valid(NEW.definition) THEN
      RAISE EXCEPTION 'format publish requires a validated phase2 definition';
    END IF;
  ELSIF NEW.validation_contract = 'phase3' THEN
    IF NOT EXISTS (
      SELECT 1 FROM format_validation_evidence e
      WHERE e.format_revision_id=NEW.id
        AND e.definition_hash=NEW.definition_hash
        AND e.valid AND e.graph_acyclic AND e.graph_reachable
        AND e.slots_unambiguous AND e.recommendation_fits_capacity
        AND e.available_match_slots=phase3_available_match_slots(NEW.competition_id)
        AND phase3_format_definition_db_valid(NEW.definition)
    ) THEN
      RAISE EXCEPTION 'format publish requires matching structural validation evidence';
    END IF;
  ELSE
    RAISE EXCEPTION 'format publish requires a recognised validation contract';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Standings provenance covers fixture participants and their graph identity,
-- not only completed score rows. Reassigning a participant before a result
-- therefore changes the source hash; after a result it is rejected outright.
CREATE OR REPLACE FUNCTION phase3_standings_source_hash(
  target_competition uuid,
  target_division uuid,
  target_result_version integer
) RETURNS text AS $$
DECLARE material text;
BEGIN
  SELECT concat_ws('|',
    target_competition::text,
    target_division::text,
    target_result_version::text,
    COALESCE((
      SELECT string_agg(concat_ws(':',e.id::text,e.status,COALESCE(e.seed::text,''),e.updated_at::text),',' ORDER BY e.id)
      FROM division_entries e WHERE e.division_id=target_division
    ),''),
    COALESCE((
      SELECT string_agg(concat_ws(':',m.id::text,m.format_revision_id::text,m.code,m.stage,
        COALESCE(m.home_entry_id::text,''),COALESCE(m.away_entry_id::text,''),fr.definition_hash),',' ORDER BY m.id)
      FROM matches m JOIN format_revisions fr ON fr.id=m.format_revision_id
      WHERE m.competition_id=target_competition AND m.division_id=target_division
    ),''),
    COALESCE((
      SELECT string_agg(concat_ws(':',latest.match_id::text,latest.result_version::text,
        latest.through_sequence::text,latest.home_score::text,latest.away_score::text,
        latest.state,pg_catalog.md5(latest.snapshot::text)),',' ORDER BY latest.match_id)
      FROM (
        SELECT DISTINCT ON (m.id) s.match_id,s.result_version,s.through_sequence,
          s.home_score,s.away_score,s.state,s.snapshot
        FROM matches m JOIN match_result_snapshots s ON s.match_id=m.id
        WHERE m.competition_id=target_competition AND m.division_id=target_division
          AND s.result_version<=target_result_version
        ORDER BY m.id,s.result_version DESC
      ) latest
    ),''),
    COALESCE((
      SELECT concat_ws(':',sport_code,pack_version,pack_schema_version::text,
        pg_catalog.md5(recommended_snapshot::text),pg_catalog.md5(settings_override::text))
      FROM competition_sport_settings WHERE competition_id=target_competition
    ),''),
    COALESCE((
      SELECT concat_ws(':',pack_version,pg_catalog.md5(settings_override::text))
      FROM division_sport_settings WHERE division_id=target_division
    ),'')
  ) INTO material;
  RETURN pg_catalog.md5(material)||pg_catalog.md5('phase3:'||material);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase3_guard_result_participant_mutation() RETURNS trigger AS $$
BEGIN
  IF (NEW.home_entry_id IS DISTINCT FROM OLD.home_entry_id
      OR NEW.away_entry_id IS DISTINCT FROM OLD.away_entry_id)
     AND EXISTS (SELECT 1 FROM match_result_snapshots WHERE match_id=OLD.id) THEN
    RAISE EXCEPTION 'match participants are immutable after a result is recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER matches_phase3_result_participant_guard
BEFORE UPDATE OF home_entry_id,away_entry_id ON matches
FOR EACH ROW EXECUTE FUNCTION phase3_guard_result_participant_mutation();

-- Capacity is shared by all divisions. Reserves apply to the latest local
-- slots on each area and may not consume another area's usable slots.
CREATE OR REPLACE FUNCTION phase3_available_match_slots(target_competition uuid) RETURNS integer AS $$
DECLARE result integer;
BEGIN
  SELECT COALESCE(sum(GREATEST(0, area_capacity.raw_slots-a.fixed_reserve_slots)),0)::integer
  INTO result
  FROM playing_areas a
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(floor(extract(epoch FROM (upper(usable.slot)-lower(usable.slot)))/60/COALESCE(a.slot_minutes,30))),0)::integer AS raw_slots
    FROM unnest(
      COALESCE((SELECT range_agg(tstzrange(w.starts_at,w.ends_at,'[)')) FROM competition_availability_windows w WHERE w.playing_area_id=a.id),'{}'::tstzmultirange)
      - COALESCE((SELECT range_agg(tstzrange(u.starts_at,u.ends_at,'[)')) FROM playing_area_unavailable_intervals u WHERE u.playing_area_id=a.id),'{}'::tstzmultirange)
    ) AS usable(slot)
  ) area_capacity
  WHERE a.competition_id=target_competition;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase3_selected_format_required_slots(
  target_competition uuid,
  excluded_division uuid DEFAULT NULL
) RETURNS integer AS $$
DECLARE result integer;
BEGIN
  SELECT COALESCE(sum(jsonb_array_length(selected.definition->'matches')),0)::integer
  INTO result
  FROM divisions d
  CROSS JOIN LATERAL (
    SELECT fr.definition
    FROM format_revisions fr
    LEFT JOIN format_validation_evidence e ON e.format_revision_id=fr.id
    WHERE fr.competition_id=d.competition_id AND fr.division_id=d.id
      AND (fr.status='published' OR (fr.validation_contract='phase3' AND e.valid))
    ORDER BY (fr.status='published') DESC,
             CASE WHEN fr.status='published' THEN fr.published_at END DESC NULLS LAST,
             fr.revision DESC,fr.id DESC
    LIMIT 1
  ) selected
  WHERE d.competition_id=target_competition
    AND (excluded_division IS NULL OR d.id<>excluded_division);
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION phase3_validate_format_evidence() RETURNS trigger AS $$
DECLARE
  revision format_revisions%ROWTYPE;
  actual_slots integer;
  candidate_slots integer;
  aggregate_slots integer;
BEGIN
  SELECT * INTO revision FROM format_revisions WHERE id=NEW.format_revision_id;
  IF revision.id IS NULL OR NEW.definition_hash<>revision.definition_hash
     OR NOT phase3_format_definition_db_valid(revision.definition) THEN
    RAISE EXCEPTION 'format validation evidence does not match immutable definition';
  END IF;
  -- Serialise shared-capacity claims across divisions.
  PERFORM 1 FROM competitions WHERE id=revision.competition_id FOR UPDATE;
  actual_slots := phase3_available_match_slots(revision.competition_id);
  candidate_slots := jsonb_array_length(revision.definition->'matches');
  aggregate_slots := candidate_slots
    + phase3_selected_format_required_slots(revision.competition_id,revision.division_id);
  NEW.valid := true;
  NEW.graph_acyclic := true;
  NEW.graph_reachable := true;
  NEW.slots_unambiguous := true;
  NEW.deterministic_match_count := candidate_slots;
  NEW.available_match_slots := actual_slots;
  NEW.required_match_slots := aggregate_slots;
  NEW.recommendation_fits_capacity := actual_slots>=aggregate_slots;
  NEW.issues := '[]'::jsonb;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase3_phase2_format_storage_db_valid(target_revision uuid) RETURNS boolean AS $$
DECLARE revision_row format_revisions%ROWTYPE;
DECLARE expected_count integer;
BEGIN
  SELECT * INTO revision_row FROM format_revisions WHERE id=target_revision;
  IF revision_row.id IS NULL
     OR NOT phase3_phase2_format_definition_db_valid(revision_row.definition)
     OR revision_row.definition_hash<>encode(pg_catalog.sha256(
       convert_to(phase3_canonical_jsonb(revision_row.definition),'UTF8')),'hex') THEN
    RETURN false;
  END IF;
  expected_count := jsonb_array_length(revision_row.definition->'matches');
  IF (SELECT count(*) FROM matches WHERE format_revision_id=target_revision)<>expected_count
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(revision_row.definition->'matches') item(value)
       WHERE NOT EXISTS (
         SELECT 1 FROM matches m
         WHERE m.format_revision_id=target_revision
           AND m.id=(item.value->>'id')::uuid
           AND m.stage=item.value->>'stage'
           AND m.round_number=(item.value->>'round')::integer
           AND m.ordinal=(item.value->>'order')::integer
           AND m.home_entry_id IS NOT DISTINCT FROM CASE WHEN item.value->'home'->>'type'='entry'
             THEN (item.value->'home'->>'entryId')::uuid ELSE NULL END
           AND m.away_entry_id IS NOT DISTINCT FROM CASE WHEN item.value->'away'->>'type'='entry'
             THEN (item.value->'away'->>'entryId')::uuid ELSE NULL END
       )
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(revision_row.definition->'matches') item(value)
       WHERE (SELECT count(*) FROM match_dependencies d
              WHERE d.match_id=(item.value->>'id')::uuid)
             <> jsonb_array_length(item.value->'dependencyMatchIds')
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(item.value->'dependencyMatchIds') dependency(value)
            WHERE NOT EXISTS (
              SELECT 1 FROM match_dependencies d
              WHERE d.match_id=(item.value->>'id')::uuid
                AND d.source_match_id=dependency.value::uuid
                AND (
                  (item.value->'home'->>'type' IN ('winner','loser')
                    AND item.value->'home'->>'matchId'=dependency.value
                    AND d.slot='home' AND d.outcome=item.value->'home'->>'type')
                  OR (item.value->'away'->>'type' IN ('winner','loser')
                    AND item.value->'away'->>'matchId'=dependency.value
                    AND d.slot='away' AND d.outcome=item.value->'away'->>'type')
                  OR (d.slot IS NULL AND d.outcome IS NULL)
                )
            )
          )
     )
     OR NOT EXISTS (
       SELECT 1 FROM schedule_revisions sr
       WHERE sr.format_revision_id=target_revision AND sr.status IN ('draft','published')
         AND (SELECT count(*) FROM scheduled_matches sm WHERE sm.schedule_revision_id=sr.id)=expected_count
         AND NOT EXISTS (
           SELECT 1 FROM matches m WHERE m.format_revision_id=target_revision
             AND NOT EXISTS (SELECT 1 FROM scheduled_matches sm
               WHERE sm.schedule_revision_id=sr.id AND sm.match_id=m.id)
         )
     ) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION phase3_require_validated_format_publish() RETURNS trigger AS $$
DECLARE
  expected_hash text;
  aggregate_slots integer;
BEGIN
  IF NEW.status<>'published' OR (TG_OP='UPDATE' AND OLD.status='published') THEN RETURN NEW; END IF;
  IF NOT phase3_format_entry_count_matches_division(NEW.definition,NEW.division_id) THEN
    RAISE EXCEPTION 'format publish entry count does not match division eligibility and limit';
  END IF;
  expected_hash := encode(pg_catalog.sha256(convert_to(phase3_canonical_jsonb(NEW.definition),'UTF8')),'hex');
  IF NEW.definition_hash<>expected_hash THEN
    RAISE EXCEPTION 'format publish requires a database-verified definition hash';
  END IF;
  IF NEW.validation_contract='phase2' THEN
    PERFORM 1 FROM competitions WHERE id=NEW.competition_id FOR UPDATE;
    aggregate_slots := jsonb_array_length(NEW.definition->'matches')
      + phase3_selected_format_required_slots(NEW.competition_id,NEW.division_id);
    IF NOT phase3_phase2_format_storage_db_valid(NEW.id)
       OR aggregate_slots>phase3_available_match_slots(NEW.competition_id) THEN
      RAISE EXCEPTION 'format publish requires validated phase2 storage, complete schedule, and current aggregate capacity';
    END IF;
  ELSIF NEW.validation_contract='phase3' THEN
    PERFORM 1 FROM competitions WHERE id=NEW.competition_id FOR UPDATE;
    aggregate_slots := jsonb_array_length(NEW.definition->'matches')
      + phase3_selected_format_required_slots(NEW.competition_id,NEW.division_id);
    IF NOT EXISTS (
      SELECT 1 FROM format_validation_evidence e
      WHERE e.format_revision_id=NEW.id AND e.definition_hash=NEW.definition_hash
        AND e.valid AND e.graph_acyclic AND e.graph_reachable AND e.slots_unambiguous
        AND e.available_match_slots=phase3_available_match_slots(NEW.competition_id)
        AND e.required_match_slots=aggregate_slots
        AND e.recommendation_fits_capacity
        AND e.recommendation_fits_capacity=(e.available_match_slots>=aggregate_slots)
        AND phase3_format_definition_db_valid(NEW.definition)
    ) THEN
      RAISE EXCEPTION 'format publish requires current aggregate capacity evidence';
    END IF;
  ELSE
    RAISE EXCEPTION 'format publish requires a recognised validation contract';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
