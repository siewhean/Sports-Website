-- Phase 4 / Gate B organiser-alpha persistence. This migration is additive and
-- keeps the Phase 2/3 match, results, and publication pipeline authoritative.

-- Shared helpers ------------------------------------------------------------

CREATE FUNCTION phase4_sha256_json(value jsonb) RETURNS text AS $$
  SELECT encode(pg_catalog.sha256(convert_to(phase3_canonical_jsonb(value), 'UTF8')), 'hex')
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE FUNCTION phase4_deterministic_uuid(namespace_value uuid, stable_key text) RETURNS uuid AS $$
DECLARE digest_value text;
BEGIN
  digest_value := encode(pg_catalog.sha256(convert_to(namespace_value::text || ':' || stable_key, 'UTF8')), 'hex');
  RETURN (
    substr(digest_value,1,8) || '-' || substr(digest_value,9,4) || '-4' || substr(digest_value,14,3) ||
    '-a' || substr(digest_value,18,3) || '-' || substr(digest_value,21,12)
  )::uuid;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION phase4_json_object_without_forbidden_keys(value jsonb) RETURNS boolean AS $$
DECLARE key text; child jsonb;
BEGIN
  IF jsonb_typeof(value)='object' THEN
    FOR key,child IN SELECT * FROM jsonb_each(value) LOOP
      IF lower(key) ~ '(prompt|raw|source.?text|secret|token|credential|provider.?output)'
         OR NOT phase4_json_object_without_forbidden_keys(child) THEN RETURN false; END IF;
    END LOOP;
  ELSIF jsonb_typeof(value)='array' THEN
    FOR child IN SELECT item FROM jsonb_array_elements(value) item LOOP
      IF NOT phase4_json_object_without_forbidden_keys(child) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION phase4_ai_result_valid(action_value text,result_value jsonb) RETURNS boolean AS $$
DECLARE allowed_missing text[]:=ARRAY['sport','entry_count','division_count','divisions','location','dates.start','dates.end',
  'playing_areas','daily_availability','time_slot_minutes','minimum_matches_per_entry','knockout_required','rank_all_entries',
  'placement_required','cross_group_qualification_allowed','organiser_priority'];
BEGIN
  IF jsonb_typeof(result_value)<>'object' THEN RETURN false; END IF;
  IF action_value='text_to_brief' THEN
    IF (SELECT count(*)<>18 OR NOT bool_and(key=ANY(ARRAY['schema_version','name','sport','entry_count','division_count','divisions',
      'location','dates','playing_areas','daily_availability','time_slot_minutes','minimum_matches_per_entry','knockout_required',
      'rank_all_entries','placement_required','cross_group_qualification_allowed','organiser_priority','missing_fields']))
      FROM jsonb_object_keys(result_value) key) OR result_value->>'schema_version'<>'1.0'
      OR (result_value->'sport'<>'null'::jsonb AND result_value->>'sport' NOT IN ('canoe_polo','badminton','table_tennis','volleyball','basketball'))
      OR (result_value->'entry_count'<>'null'::jsonb AND (NOT phase3_json_positive_integer(result_value->'entry_count') OR (result_value->>'entry_count')::integer>48))
      OR (result_value->'division_count'<>'null'::jsonb AND NOT phase3_json_positive_integer(result_value->'division_count'))
      OR jsonb_typeof(result_value->'dates')<>'object' OR jsonb_typeof(result_value->'missing_fields')<>'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(result_value->'missing_fields') item WHERE NOT item=ANY(allowed_missing))
      OR (SELECT count(*)<>count(DISTINCT item) FROM jsonb_array_elements_text(result_value->'missing_fields') item)
      OR (result_value->'organiser_priority'<>'null'::jsonb AND result_value->>'organiser_priority' NOT IN ('speed','simplicity','participation')) THEN RETURN false; END IF;
    RETURN true;
  ELSIF action_value='format_recommendations' THEN
    RETURN (SELECT count(*)=10 AND bool_and(key=ANY(ARRAY['sport','entryCount','divisionCount','availableMatchSlots',
      'minimumMatchesPerEntry','rankAllEntries','knockoutRequired','placementRequired','crossGroupQualificationAllowed','organiserPriority']))
      FROM jsonb_object_keys(result_value) key)
      AND result_value->>'sport' IN ('canoe_polo','badminton','table_tennis','volleyball','basketball')
      AND phase3_json_positive_integer(result_value->'entryCount') AND (result_value->>'entryCount')::integer BETWEEN 2 AND 48
      AND phase3_json_positive_integer(result_value->'divisionCount') AND (result_value->>'divisionCount')::integer BETWEEN 1 AND 16
      AND (result_value->>'divisionCount')::integer<=(result_value->>'entryCount')::integer
      AND jsonb_typeof(result_value->'availableMatchSlots')='number' AND (result_value->>'availableMatchSlots')::numeric>=0
      AND phase3_json_positive_integer(result_value->'minimumMatchesPerEntry')
      AND (result_value->>'minimumMatchesPerEntry')::integer<(result_value->>'entryCount')::integer
      AND jsonb_typeof(result_value->'rankAllEntries')='boolean' AND jsonb_typeof(result_value->'knockoutRequired')='boolean'
      AND jsonb_typeof(result_value->'placementRequired')='boolean' AND jsonb_typeof(result_value->'crossGroupQualificationAllowed')='boolean'
      AND result_value->>'organiserPriority' IN ('speed','simplicity','participation');
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE competitions ADD CONSTRAINT competitions_id_organisation_unique UNIQUE(id,organisation_id);

-- Phase 4 adds optional manual-builder fields to stages while retaining the
-- exact Phase 3 graph root and source/match representation. Normalise only the
-- additive stage fields for the proven Phase 3 graph validator, then validate
-- those fields independently. Existing Phase 2/3 documents remain unchanged.
ALTER FUNCTION phase3_format_definition_db_valid(jsonb)
  RENAME TO phase4_phase3_base_format_definition_db_valid;

CREATE OR REPLACE FUNCTION phase3_format_source_shape_valid(source jsonb, entry_count integer) RETURNS boolean AS $$
BEGIN
  IF jsonb_typeof(source)<>'object' OR jsonb_typeof(source->'type')<>'string' THEN RETURN false; END IF;
  IF source->>'type'='entry_seed' THEN
    RETURN (SELECT count(*)=2 AND bool_and(key=ANY(ARRAY['type','seed'])) FROM jsonb_object_keys(source) key)
      AND phase3_json_positive_integer(source->'seed') AND (source->>'seed')::integer<=entry_count;
  ELSIF source->>'type'='stage_rank' THEN
    RETURN (SELECT count(*) BETWEEN 3 AND 4 AND bool_and(key=ANY(ARRAY['type','stageId','groupId','rank'])) FROM jsonb_object_keys(source) key)
      AND jsonb_typeof(source->'stageId')='string' AND btrim(source->>'stageId')<>''
      AND (NOT source ? 'groupId' OR (jsonb_typeof(source->'groupId')='string' AND btrim(source->>'groupId')<>''))
      AND phase3_json_positive_integer(source->'rank');
  ELSIF source->>'type' IN ('winner','loser') THEN
    RETURN (SELECT count(*)=2 AND bool_and(key=ANY(ARRAY['type','matchId'])) FROM jsonb_object_keys(source) key)
      AND jsonb_typeof(source->'matchId')='string' AND btrim(source->>'matchId')<>'';
  ELSIF source->>'type'='manual_qualifier' THEN
    RETURN (SELECT count(*)=3 AND bool_and(key=ANY(ARRAY['type','qualifierId','stageId'])) FROM jsonb_object_keys(source) key)
      AND jsonb_typeof(source->'qualifierId')='string' AND btrim(source->>'qualifierId')<>''
      AND jsonb_typeof(source->'stageId')='string' AND btrim(source->>'stageId')<>'';
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase3_format_definition_db_valid(definition jsonb) RETURNS boolean AS $$
DECLARE normalized jsonb:=definition; stage_index integer; match_index integer; stage jsonb; qualifier jsonb; position jsonb;
DECLARE source jsonb; source_stage jsonb; slot_name text;
DECLARE optional_keys text[]:=ARRAY['repetitions','qualificationPositions','additionalQualifiers','destinationStageIds','seeding','placementRule','carriedResults'];
BEGIN
  IF jsonb_typeof(definition->'stages')<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(definition->'stages')>0 THEN
    FOR stage_index IN 0..jsonb_array_length(definition->'stages')-1 LOOP
      stage:=definition->'stages'->stage_index;
      IF stage ? 'repetitions' AND (NOT phase3_json_positive_integer(stage->'repetitions')) THEN RETURN false; END IF;
      IF stage ? 'seeding' AND (jsonb_typeof(stage->'seeding')<>'string' OR stage->>'seeding' NOT IN ('seeded','snake','random','manual')) THEN RETURN false; END IF;
      IF stage ? 'carriedResults' AND (jsonb_typeof(stage->'carriedResults')<>'string' OR stage->>'carriedResults' NOT IN ('none','head_to_head','all')) THEN RETURN false; END IF;
      IF stage ? 'qualificationPositions' THEN
        IF jsonb_typeof(stage->'qualificationPositions')<>'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(stage->'qualificationPositions') value WHERE NOT phase3_json_positive_integer(value))
           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(stage->'qualificationPositions') value WHERE value::integer>(stage->>'outputRanks')::integer)
           OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements_text(stage->'qualificationPositions')) THEN RETURN false; END IF;
      END IF;
      IF stage ? 'destinationStageIds' THEN
        IF jsonb_typeof(stage->'destinationStageIds')<>'array'
           OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements_text(stage->'destinationStageIds'))
           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(stage->'destinationStageIds') destination
             WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'stages') candidate
               WHERE candidate->>'id'=destination AND (candidate->>'order')::integer>(stage->>'order')::integer)) THEN RETURN false; END IF;
      END IF;
      IF stage ? 'additionalQualifiers' THEN
        IF jsonb_typeof(stage->'additionalQualifiers')<>'array' THEN RETURN false; END IF;
        IF (SELECT count(*)<>count(DISTINCT concat_ws(':',value->>'method',value->>'destinationStageId'))
          FROM jsonb_array_elements(stage->'additionalQualifiers')) THEN RETURN false; END IF;
        FOR qualifier IN SELECT value FROM jsonb_array_elements(stage->'additionalQualifiers') LOOP
          IF jsonb_typeof(qualifier)<>'object'
             OR (SELECT count(*)<>3 OR NOT bool_and(key=ANY(ARRAY['method','count','destinationStageId'])) FROM jsonb_object_keys(qualifier) key)
             OR qualifier->>'method' NOT IN ('best_across_groups','bottom_from_each_group','manual')
             OR NOT phase3_json_positive_integer(qualifier->'count') OR jsonb_typeof(qualifier->'destinationStageId')<>'string'
             OR (qualifier->>'count')::integer>(definition->>'entryCount')::integer
             OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'stages') candidate
               WHERE candidate->>'id'=qualifier->>'destinationStageId' AND (candidate->>'order')::integer>(stage->>'order')::integer) THEN RETURN false; END IF;
        END LOOP;
      END IF;
      IF stage ? 'qualificationPositions' OR stage ? 'additionalQualifiers' OR stage ? 'destinationStageIds' THEN
        IF NOT stage ? 'destinationStageIds' THEN RETURN false; END IF;
        IF EXISTS (
          WITH actual(destination) AS (
            SELECT DISTINCT consumer.value->>'stageId'
            FROM jsonb_array_elements(definition->'matches') consumer(value)
            CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(consumer.value->'home',consumer.value->'away')) source(value)
            WHERE source.value->>'stageId'=stage->>'id'
               OR (source.value->>'type' IN ('winner','loser') AND EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'matches') parent(value)
                 WHERE parent.value->>'id'=source.value->>'matchId' AND parent.value->>'stageId'=stage->>'id'))
          ), declared(destination) AS (SELECT value FROM jsonb_array_elements_text(stage->'destinationStageIds'))
          (SELECT destination FROM actual EXCEPT SELECT destination FROM declared)
          UNION ALL (SELECT destination FROM declared EXCEPT SELECT destination FROM actual)
        ) THEN RETURN false; END IF;
        IF stage ? 'qualificationPositions' AND EXISTS (
          SELECT rank FROM jsonb_array_elements_text(stage->'qualificationPositions') rank
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(definition->'matches') consumer(value)
            CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(consumer.value->'home',consumer.value->'away')) source(value)
            WHERE source.value->>'type'='stage_rank' AND source.value->>'stageId'=stage->>'id' AND source.value ? 'groupId'
              AND (source.value->>'rank')::integer=rank::integer
          )
        ) THEN RETURN false; END IF;
        IF EXISTS (
          WITH actual AS (
            SELECT CASE WHEN source.value->>'type'='manual_qualifier' THEN 'manual'
                        WHEN source.value ? 'groupId' THEN 'bottom_from_each_group' ELSE 'best_across_groups' END method,
                   consumer.value->>'stageId' destination,count(*)::integer count
            FROM jsonb_array_elements(definition->'matches') consumer(value)
            CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(consumer.value->'home',consumer.value->'away')) source(value)
            WHERE source.value->>'stageId'=stage->>'id'
              AND (source.value->>'type'='manual_qualifier' OR (source.value->>'type'='stage_rank' AND (
                NOT source.value ? 'groupId' OR NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(COALESCE(stage->'qualificationPositions','[]'::jsonb)) qualified(value)
                  WHERE qualified.value=source.value->>'rank'))))
            GROUP BY 1,2
          ), declared AS (
            SELECT value->>'method' method,value->>'destinationStageId' destination,(value->>'count')::integer count
            FROM jsonb_array_elements(COALESCE(stage->'additionalQualifiers','[]'::jsonb))
          )
          (SELECT * FROM actual EXCEPT SELECT * FROM declared)
          UNION ALL (SELECT * FROM declared EXCEPT SELECT * FROM actual)
        ) THEN RETURN false; END IF;
      END IF;
      IF jsonb_typeof(stage->'label')<>'string' OR btrim(stage->>'label')='' THEN RETURN false; END IF;
      IF stage ? 'placementRule' THEN
        IF jsonb_typeof(stage->'placementRule')<>'object'
           OR (SELECT count(*)<>2 OR NOT bool_and(key=ANY(ARRAY['coverage','positions'])) FROM jsonb_object_keys(stage->'placementRule') key)
           OR stage->'placementRule'->>'coverage' NOT IN ('champion_only','podium','full','custom')
           OR jsonb_typeof(stage->'placementRule'->'positions')<>'array'
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(stage->'placementRule'->'positions') value WHERE NOT phase3_json_positive_integer(value))
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(stage->'placementRule'->'positions') value
             WHERE NOT phase3_json_positive_integer(value) OR (value#>>'{}')::integer>(definition->>'entryCount')::integer)
           OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements_text(stage->'placementRule'->'positions'))
           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(stage->'placementRule'->'positions') WITH ORDINALITY AS item(value,ordinality)
             WHERE ordinality>1 AND value::integer<=(stage->'placementRule'->'positions'->>((ordinality-2)::integer))::integer) THEN RETURN false; END IF;
        IF stage->'placementRule'->>'coverage'='champion_only' AND stage->'placementRule'->'positions'<>'[1]'::jsonb THEN RETURN false; END IF;
        IF stage->'placementRule'->>'coverage'='podium' AND stage->'placementRule'->'positions'<>'[1,2,3]'::jsonb THEN RETURN false; END IF;
        IF stage->'placementRule'->>'coverage'='full' AND (
          SELECT count(*)<>(definition->>'entryCount')::integer OR min(value::integer)<>1 OR max(value::integer)<>(definition->>'entryCount')::integer
          FROM jsonb_array_elements_text(stage->'placementRule'->'positions') value) THEN RETURN false; END IF;
        IF stage->'placementRule'->>'coverage'='custom' AND jsonb_array_length(stage->'placementRule'->'positions')=0 THEN RETURN false; END IF;
      END IF;
      normalized:=jsonb_set(normalized,ARRAY['stages',stage_index::text],stage-optional_keys,false);
    END LOOP;
  END IF;
  -- The Phase 3 validator required groupId for every group-stage rank source.
  -- Phase 4 best-across-groups deliberately omits it, so supply a harmless
  -- valid group only to the legacy structural validator; parity below still
  -- evaluates the original authored source.
  IF jsonb_typeof(definition->'matches')='array' AND jsonb_array_length(definition->'matches')>0 THEN
    FOR match_index IN 0..jsonb_array_length(definition->'matches')-1 LOOP
      FOREACH slot_name IN ARRAY ARRAY['home','away'] LOOP
        source:=definition->'matches'->match_index->slot_name;
        IF source->>'type'='stage_rank' AND NOT source ? 'groupId' THEN
          SELECT value INTO source_stage FROM jsonb_array_elements(definition->'stages') item(value)
          WHERE value->>'id'=source->>'stageId';
          IF source_stage->>'kind'='group' AND jsonb_array_length(source_stage->'groupIds')>0 THEN
            normalized:=jsonb_set(normalized,ARRAY['matches',match_index::text,slot_name],
              source||jsonb_build_object('groupId',source_stage->'groupIds'->>0),false);
          END IF;
        END IF;
      END LOOP;
    END LOOP;
  END IF;
  IF NOT phase4_phase3_base_format_definition_db_valid(normalized) THEN RETURN false; END IF;
  IF (SELECT count(*)<>count(DISTINCT source.value->>'qualifierId')
      FROM jsonb_array_elements(definition->'matches') graph_match(value)
      CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(graph_match.value->'home',graph_match.value->'away')) source(value)
      WHERE source.value->>'type'='manual_qualifier') THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(definition->'matches') consumer(value)
    CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(consumer.value->'home',consumer.value->'away')) source(value)
    WHERE source.value->>'type'='manual_qualifier' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(definition->'stages') source_stage(value)
      CROSS JOIN jsonb_array_elements(definition->'stages') destination_stage(value)
      WHERE source_stage.value->>'id'=source.value->>'stageId'
        AND destination_stage.value->>'id'=consumer.value->>'stageId'
        AND (source_stage.value->>'order')::integer<(destination_stage.value->>'order')::integer
    )
  ) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase4_prevent_history_mutation() RETURNS trigger AS $$
DECLARE target_competition uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    IF to_jsonb(OLD) ? 'competition_id' THEN target_competition := OLD.competition_id; END IF;
    IF target_competition IS NOT NULL AND NOT EXISTS (SELECT 1 FROM competitions WHERE id=target_competition) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '%', TG_ARGV[0];
END;
$$ LANGUAGE plpgsql;

CREATE TABLE phase4_mutation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key)<>''),
  operation text NOT NULL CHECK (btrim(operation)<>''),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organisation_id,idempotency_key)
);
CREATE INDEX phase4_mutation_receipts_operation_idx ON phase4_mutation_receipts(organisation_id,operation,created_at DESC);
CREATE TRIGGER phase4_mutation_receipts_immutable BEFORE UPDATE OR DELETE ON phase4_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION phase4_prevent_history_mutation('Phase 4 mutation receipts are immutable');

-- Server-owned assisted-setup drafts ---------------------------------------

CREATE TABLE setup_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','expired')),
  current_step text NOT NULL DEFAULT 'basics' CHECK (current_step IN (
    'basics','capacity','settings','entries','format_preferences',
    'format_recommendations','schedule_review','review_publish'
  )),
  completed_steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(completed_steps)='array'),
  steps jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(steps)='object'),
  validation jsonb NOT NULL DEFAULT '{"valid":false,"pending":false,"issues":[]}'::jsonb
    CHECK (jsonb_typeof(validation)='object'),
  created_by uuid NOT NULL REFERENCES accounts(id),
  updated_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '30 days'),
  completed_at timestamptz,
  UNIQUE (competition_id),
  UNIQUE (id, competition_id),
  FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE,
  CHECK ((status='active' AND completed_at IS NULL) OR (status='completed' AND completed_at IS NOT NULL) OR status='expired')
);

CREATE INDEX setup_drafts_org_updated_idx ON setup_drafts(organisation_id, updated_at DESC);

CREATE FUNCTION phase4_guard_setup_draft() RETURNS trigger AS $$
DECLARE competition_org uuid;
BEGIN
  SELECT organisation_id INTO competition_org FROM competitions WHERE id=NEW.competition_id FOR UPDATE;
  IF competition_org IS NULL OR competition_org<>NEW.organisation_id THEN
    RAISE EXCEPTION 'setup draft tenant does not match competition';
  END IF;
  PERFORM phase3_assert_competition_mutable(NEW.competition_id);
  IF TG_OP='UPDATE' THEN
    IF OLD.status<>'active' THEN RAISE EXCEPTION 'completed or expired setup drafts are immutable'; END IF;
    IF NEW.id<>OLD.id OR NEW.organisation_id<>OLD.organisation_id OR NEW.competition_id<>OLD.competition_id
       OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
      RAISE EXCEPTION 'setup draft identity and provenance are immutable';
    END IF;
    IF NEW.revision<>OLD.revision+1 OR NEW.updated_at<=OLD.updated_at THEN
      RAISE EXCEPTION 'setup autosave must advance revision and updated_at exactly once';
    END IF;
    IF NEW.status='expired' AND now()<OLD.expires_at THEN RAISE EXCEPTION 'setup draft cannot expire early'; END IF;
    IF NEW.status='active' THEN NEW.expires_at:=NEW.updated_at+interval '30 days'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER setup_drafts_phase4_guard BEFORE INSERT OR UPDATE ON setup_drafts
FOR EACH ROW EXECUTE FUNCTION phase4_guard_setup_draft();
CREATE TRIGGER setup_drafts_phase4_archive_guard BEFORE DELETE ON setup_drafts
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();

CREATE FUNCTION phase4_create_setup_draft(target_organisation uuid,target_competition uuid,actor uuid,
  idempotency_value text,request_id_value text) RETURNS jsonb AS $$
DECLARE receipt phase4_mutation_receipts%ROWTYPE; draft setup_drafts%ROWTYPE; request_hash_value text;
BEGIN
  request_hash_value:=phase4_sha256_json(jsonb_build_object('competition_id',target_competition));
  PERFORM pg_advisory_xact_lock(hashtextextended('phase4-receipt:'||idempotency_value,0));
  SELECT * INTO receipt FROM phase4_mutation_receipts WHERE organisation_id=target_organisation AND idempotency_key=idempotency_value;
  IF receipt.id IS NOT NULL THEN
    IF receipt.operation<>'setup.create' OR receipt.request_hash<>request_hash_value THEN RAISE EXCEPTION 'idempotency key was reused with a different setup request'; END IF;
    RETURN receipt.response;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organisation_memberships WHERE organisation_id=target_organisation AND account_id=actor
    AND status='active' AND role IN ('owner','organiser')) THEN RAISE EXCEPTION 'setup create requires organiser permission'; END IF;
  INSERT INTO setup_drafts(organisation_id,competition_id,created_by,updated_by)
  VALUES(target_organisation,target_competition,actor,actor)
  ON CONFLICT(competition_id) DO NOTHING
  RETURNING * INTO draft;
  IF draft.id IS NULL THEN SELECT * INTO draft FROM setup_drafts WHERE competition_id=target_competition; END IF;
  INSERT INTO phase4_mutation_receipts(organisation_id,idempotency_key,operation,request_hash,response)
  VALUES(target_organisation,idempotency_value,'setup.create',request_hash_value,to_jsonb(draft));
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id)
  VALUES(request_id_value,actor,'account',target_organisation,'setup.created','setup_draft',draft.id::text);
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('setup_draft',draft.id::text,'setup.created',jsonb_build_object('competition_id',draft.competition_id),
    'phase4:setup-create:'||target_organisation::text||':'||idempotency_value);
  RETURN to_jsonb(draft);
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_save_setup_draft(target_organisation uuid,target_competition uuid,actor uuid,
  expected_revision integer,next_step text,next_completed_steps jsonb,next_steps jsonb,next_validation jsonb,
  next_status text,idempotency_value text,request_id_value text) RETURNS jsonb AS $$
DECLARE receipt phase4_mutation_receipts%ROWTYPE; draft setup_drafts%ROWTYPE; request_document jsonb; request_hash_value text; response_value jsonb;
BEGIN
  request_document:=jsonb_build_object('competition_id',target_competition,'expected_revision',expected_revision,
    'current_step',next_step,'completed_steps',next_completed_steps,'steps',next_steps,'validation',next_validation,'status',next_status);
  request_hash_value:=phase4_sha256_json(request_document);
  PERFORM pg_advisory_xact_lock(hashtextextended('phase4-receipt:'||idempotency_value,0));
  SELECT * INTO receipt FROM phase4_mutation_receipts WHERE organisation_id=target_organisation AND idempotency_key=idempotency_value;
  IF receipt.id IS NOT NULL THEN
    IF receipt.operation<>'setup.save' OR receipt.request_hash<>request_hash_value THEN RAISE EXCEPTION 'idempotency key was reused with a different setup request'; END IF;
    RETURN receipt.response;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organisation_memberships WHERE organisation_id=target_organisation AND account_id=actor
    AND status='active' AND role IN ('owner','organiser')) THEN RAISE EXCEPTION 'setup save requires organiser permission'; END IF;
  SELECT * INTO draft FROM setup_drafts WHERE competition_id=target_competition FOR UPDATE;
  IF draft.id IS NULL OR draft.organisation_id<>target_organisation THEN RAISE EXCEPTION 'setup draft does not exist in organisation'; END IF;
  IF draft.revision<>expected_revision THEN RAISE EXCEPTION 'setup draft revision conflict'; END IF;
  UPDATE setup_drafts SET revision=revision+1,current_step=next_step,completed_steps=next_completed_steps,steps=next_steps,
    validation=next_validation,status=next_status,completed_at=CASE WHEN next_status='completed' THEN now() END,
    updated_by=actor,updated_at=clock_timestamp()
  WHERE id=draft.id RETURNING * INTO draft;
  response_value:=to_jsonb(draft);
  INSERT INTO phase4_mutation_receipts(organisation_id,idempotency_key,operation,request_hash,response)
  VALUES(target_organisation,idempotency_value,'setup.save',request_hash_value,response_value);
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(request_id_value,actor,'account',target_organisation,'setup.saved','setup_draft',draft.id::text,jsonb_build_object('revision',draft.revision,'current_step',draft.current_step));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('setup_draft',draft.id::text,'setup.saved',jsonb_build_object('competition_id',draft.competition_id,'revision',draft.revision),
    'phase4:setup-save:'||target_organisation::text||':'||idempotency_value);
  RETURN response_value;
END;
$$ LANGUAGE plpgsql;

-- Organisation-scoped immutable format templates and editor lineage --------

CREATE TABLE format_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  sport_code text NOT NULL CHECK (btrim(sport_code)<>''),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_by uuid REFERENCES accounts(id),
  archived_at timestamptz,
  UNIQUE (organisation_id, sport_code, name),
  UNIQUE (id, organisation_id),
  CHECK ((status='active' AND archived_by IS NULL AND archived_at IS NULL)
      OR (status='archived' AND archived_by IS NOT NULL AND archived_at IS NOT NULL))
);

CREATE INDEX format_templates_org_status_idx ON format_templates(organisation_id,status,name);

CREATE TABLE format_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES format_templates(id) ON DELETE RESTRICT,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version>0),
  parent_version_id uuid REFERENCES format_template_versions(id) ON DELETE RESTRICT,
  source_format_revision_id uuid NOT NULL REFERENCES format_revisions(id) ON DELETE RESTRICT,
  definition jsonb NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  layout jsonb NOT NULL DEFAULT '{"schema_version":1,"stage_positions":[]}'::jsonb,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version),
  UNIQUE (id, organisation_id),
  FOREIGN KEY (template_id,organisation_id) REFERENCES format_templates(id,organisation_id)
);

CREATE INDEX format_template_versions_template_idx ON format_template_versions(template_id,version DESC);

ALTER TABLE format_revisions
  ADD COLUMN parent_revision_id uuid REFERENCES format_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN root_revision_id uuid REFERENCES format_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN template_version_id uuid REFERENCES format_template_versions(id) ON DELETE RESTRICT,
  ADD COLUMN source_kind text NOT NULL DEFAULT 'legacy' CHECK (source_kind IN ('legacy','manual','visual','template','wizard','ai_assisted')),
  ADD COLUMN layout jsonb NOT NULL DEFAULT '{"schema_version":1,"stage_positions":[]}'::jsonb,
  ADD COLUMN graph_materialized_at timestamptz,
  ADD COLUMN graph_materialization_hash text CHECK (graph_materialization_hash IS NULL OR graph_materialization_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN graph_match_count integer CHECK (graph_match_count IS NULL OR graph_match_count>=0);
ALTER TABLE format_revisions ADD CONSTRAINT format_revisions_id_competition_division_unique
  UNIQUE(id,competition_id,division_id);

CREATE UNIQUE INDEX format_revisions_one_published_per_division
ON format_revisions(division_id) WHERE status='published';
CREATE INDEX format_revisions_parent_idx ON format_revisions(parent_revision_id) WHERE parent_revision_id IS NOT NULL;
CREATE INDEX format_revisions_template_version_idx ON format_revisions(template_version_id) WHERE template_version_id IS NOT NULL;

CREATE FUNCTION phase4_layout_valid(definition jsonb, layout jsonb) RETURNS boolean AS $$
BEGIN
  IF jsonb_typeof(layout)<>'object' OR layout->'schema_version'<>'1'::jsonb
     OR jsonb_typeof(layout->'stage_positions')<>'array' THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(layout->'stage_positions') position
    WHERE jsonb_typeof(position)<>'object'
       OR (SELECT count(*)<>3 OR NOT bool_and(key=ANY(ARRAY['stage_id','x','y'])) FROM jsonb_object_keys(position) key)
       OR jsonb_typeof(position->'stage_id')<>'string'
       OR jsonb_typeof(position->'x')<>'number' OR jsonb_typeof(position->'y')<>'number'
  ) THEN RETURN false; END IF;
  IF (SELECT count(*)<>count(DISTINCT position->>'stage_id') FROM jsonb_array_elements(layout->'stage_positions') position)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(layout->'stage_positions') position
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'stages') stage WHERE stage->>'id'=position->>'stage_id')
     ) THEN RETURN false; END IF;
  -- Empty layout is valid for server-created/legacy revisions. A non-empty
  -- editor layout must cover every stage exactly once.
  RETURN jsonb_array_length(layout->'stage_positions')=0
      OR jsonb_array_length(layout->'stage_positions')=jsonb_array_length(definition->'stages');
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase4_guard_template_version() RETURNS trigger AS $$
DECLARE template_row format_templates%ROWTYPE; parent_row format_template_versions%ROWTYPE; source_row format_revisions%ROWTYPE; source_org uuid;
BEGIN
  SELECT * INTO template_row FROM format_templates WHERE id=NEW.template_id FOR UPDATE;
  IF template_row.id IS NULL OR template_row.organisation_id<>NEW.organisation_id OR template_row.status<>'active' THEN
    RAISE EXCEPTION 'format template version requires an active template in the same organisation';
  END IF;
  IF NEW.definition_hash<>phase4_sha256_json(NEW.definition) OR NOT phase3_format_definition_db_valid(NEW.definition)
     OR NOT phase4_layout_valid(NEW.definition,NEW.layout) THEN
    RAISE EXCEPTION 'format template version definition, hash, or layout is invalid';
  END IF;
  SELECT * INTO source_row FROM format_revisions WHERE id=NEW.source_format_revision_id;
  SELECT organisation_id INTO source_org FROM competitions WHERE id=source_row.competition_id;
  IF source_row.id IS NULL OR source_org<>NEW.organisation_id OR source_row.definition<>NEW.definition
     OR source_row.definition_hash<>NEW.definition_hash OR source_row.layout<>NEW.layout THEN
    RAISE EXCEPTION 'format template provenance must exactly match a source revision in the same organisation';
  END IF;
  IF NEW.version=1 THEN
    IF NEW.parent_version_id IS NOT NULL THEN RAISE EXCEPTION 'first template version cannot have a parent'; END IF;
  ELSE
    SELECT * INTO parent_row FROM format_template_versions WHERE id=NEW.parent_version_id;
    IF parent_row.id IS NULL OR parent_row.template_id<>NEW.template_id OR parent_row.version<>NEW.version-1 THEN
      RAISE EXCEPTION 'template version lineage must reference the immediately preceding version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER format_template_versions_phase4_guard BEFORE INSERT ON format_template_versions
FOR EACH ROW EXECUTE FUNCTION phase4_guard_template_version();
CREATE TRIGGER format_template_versions_phase4_immutable BEFORE UPDATE OR DELETE ON format_template_versions
FOR EACH ROW EXECUTE FUNCTION phase4_prevent_history_mutation('format template versions are immutable');

CREATE FUNCTION phase4_create_format_template(target_organisation uuid,source_revision uuid,actor uuid,
  name_value text,description_value text,request_id_value text) RETURNS format_template_versions AS $$
DECLARE source_row format_revisions%ROWTYPE; template_row format_templates%ROWTYPE; version_row format_template_versions%ROWTYPE;
DECLARE source_org uuid; sport_value text;
BEGIN
  SELECT * INTO source_row FROM format_revisions WHERE id=source_revision FOR SHARE;
  SELECT c.organisation_id,c.sport_code INTO source_org,sport_value FROM competitions c WHERE c.id=source_row.competition_id;
  IF source_row.id IS NULL OR source_org<>target_organisation THEN RAISE EXCEPTION 'template source is outside organisation'; END IF;
  INSERT INTO format_templates(organisation_id,sport_code,name,description,created_by)
  VALUES(target_organisation,sport_value,name_value,description_value,actor) RETURNING * INTO template_row;
  INSERT INTO format_template_versions(template_id,organisation_id,version,source_format_revision_id,definition,definition_hash,layout,created_by)
  VALUES(template_row.id,target_organisation,1,source_row.id,source_row.definition,source_row.definition_hash,source_row.layout,actor)
  RETURNING * INTO version_row;
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id)
  VALUES(request_id_value,actor,'account',target_organisation,'format.template.created','format_template',template_row.id::text);
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('format_template',template_row.id::text,'format.template.created',jsonb_build_object('version_id',version_row.id),
    'phase4:format-template-created:'||template_row.id::text);
  RETURN version_row;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_archive_format_template(target_template uuid,actor uuid,request_id_value text)
RETURNS format_templates AS $$
DECLARE template_row format_templates%ROWTYPE;
BEGIN
  SELECT * INTO template_row FROM format_templates WHERE id=target_template FOR UPDATE;
  IF template_row.id IS NULL THEN RAISE EXCEPTION 'format template does not exist'; END IF;
  IF template_row.status='archived' THEN RETURN template_row; END IF;
  UPDATE format_templates SET status='archived',archived_by=actor,archived_at=now() WHERE id=target_template RETURNING * INTO template_row;
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id)
  VALUES(request_id_value,actor,'account',template_row.organisation_id,'format.template.archived','format_template',template_row.id::text);
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('format_template',template_row.id::text,'format.template.archived','{}',
    'phase4:format-template-archived:'||template_row.id::text);
  RETURN template_row;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_guard_format_revision_lineage() RETURNS trigger AS $$
DECLARE parent_row format_revisions%ROWTYPE; root_row format_revisions%ROWTYPE;
BEGIN
  IF NOT phase4_layout_valid(NEW.definition,NEW.layout) THEN RAISE EXCEPTION 'format revision layout is invalid'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.parent_revision_id IS NULL THEN
      IF NEW.source_kind<>'legacy' AND NEW.revision<>1 THEN RAISE EXCEPTION 'Phase 4 root format revision must be revision one'; END IF;
      IF NEW.source_kind<>'legacy' AND EXISTS (SELECT 1 FROM format_revisions WHERE division_id=NEW.division_id) THEN
        RAISE EXCEPTION 'Phase 4 format revision must continue the existing division lineage';
      END IF;
      NEW.root_revision_id := NEW.id;
    ELSE
      SELECT * INTO parent_row FROM format_revisions WHERE id=NEW.parent_revision_id FOR UPDATE;
      IF parent_row.id IS NULL OR parent_row.competition_id<>NEW.competition_id OR parent_row.division_id<>NEW.division_id
         OR parent_row.revision+1<>NEW.revision THEN
        RAISE EXCEPTION 'format revision parent must be the immediately preceding revision in the same division';
      END IF;
      NEW.root_revision_id := COALESCE(parent_row.root_revision_id,parent_row.id);
    END IF;
    IF NEW.source_kind<>'legacy' AND jsonb_array_length(NEW.layout->'stage_positions')<>jsonb_array_length(NEW.definition->'stages') THEN
      RAISE EXCEPTION 'Phase 4 builder revisions require a complete stage layout';
    END IF;
    SELECT * INTO root_row FROM format_revisions WHERE id=NEW.root_revision_id;
    IF NEW.root_revision_id<>NEW.id AND (root_row.id IS NULL OR root_row.competition_id<>NEW.competition_id
       OR root_row.division_id<>NEW.division_id OR root_row.parent_revision_id IS NOT NULL) THEN
      RAISE EXCEPTION 'format revision root must be the first revision in the same division lineage';
    END IF;
  ELSE
    IF NEW.layout IS DISTINCT FROM OLD.layout OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
       OR NEW.root_revision_id IS DISTINCT FROM OLD.root_revision_id OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id THEN
      RAISE EXCEPTION 'format revision editor content and lineage are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_materialization_is_exact(target_revision uuid) RETURNS boolean AS $$
DECLARE revision_row format_revisions%ROWTYPE; graph_match jsonb; source jsonb; stored_match matches%ROWTYPE; stored_source record;
DECLARE slot_name text; expected_match_id uuid; expected_source_id uuid;
BEGIN
  SELECT * INTO revision_row FROM format_revisions WHERE id=target_revision;
  IF revision_row.id IS NULL OR NOT phase3_format_definition_db_valid(revision_row.definition)
     OR (SELECT count(*) FROM matches WHERE format_revision_id=target_revision)<>jsonb_array_length(revision_row.definition->'matches')
     OR (SELECT count(*) FROM format_match_sources WHERE format_revision_id=target_revision)<>jsonb_array_length(revision_row.definition->'matches')*2
     OR (SELECT count(*) FROM match_dependencies WHERE format_revision_id=target_revision)<>(SELECT count(*) FROM jsonb_array_elements(revision_row.definition->'matches') item
       CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(item->'home',item->'away')) source_item WHERE source_item->>'type' IN ('winner','loser')) THEN RETURN false; END IF;
  FOR graph_match IN SELECT value FROM jsonb_array_elements(revision_row.definition->'matches') LOOP
    expected_match_id:=phase4_deterministic_uuid(target_revision,graph_match->>'id');
    SELECT * INTO stored_match FROM matches WHERE id=expected_match_id;
    IF stored_match.id IS NULL OR stored_match.format_revision_id<>target_revision OR stored_match.competition_id<>revision_row.competition_id
       OR stored_match.division_id<>revision_row.division_id OR stored_match.graph_match_id<>graph_match->>'id'
       OR stored_match.graph_stage_id<>graph_match->>'stageId' OR stored_match.graph_pool_id IS DISTINCT FROM graph_match->>'poolId'
       OR stored_match.graph_purpose<>graph_match->>'purpose'
       OR stored_match.round_number<>(graph_match->>'round')::integer OR stored_match.ordinal<>(graph_match->>'order')::integer THEN RETURN false; END IF;
    FOREACH slot_name IN ARRAY ARRAY['home','away'] LOOP
      source:=graph_match->slot_name;
      SELECT * INTO stored_source FROM format_match_sources WHERE match_id=expected_match_id AND slot=slot_name;
      expected_source_id:=CASE WHEN source->>'type' IN ('winner','loser') THEN phase4_deterministic_uuid(target_revision,source->>'matchId') END;
      IF stored_source.match_id IS NULL OR stored_source.source_kind<>source->>'type'
         OR stored_source.entry_seed IS DISTINCT FROM (CASE WHEN source->>'type'='entry_seed' THEN (source->>'seed')::integer END)
         OR stored_source.source_match_id IS DISTINCT FROM expected_source_id
         OR stored_source.source_graph_match_id IS DISTINCT FROM (CASE WHEN source->>'type' IN ('winner','loser') THEN source->>'matchId' END)
         OR stored_source.source_stage_id IS DISTINCT FROM (CASE WHEN source->>'type' IN ('stage_rank','manual_qualifier') THEN source->>'stageId' END)
         OR stored_source.source_group_id IS DISTINCT FROM (CASE WHEN source->>'type'='stage_rank' THEN source->>'groupId' END)
         OR stored_source.source_rank IS DISTINCT FROM (CASE WHEN source->>'type'='stage_rank' THEN (source->>'rank')::integer END)
         OR stored_source.source_manual_qualifier_id IS DISTINCT FROM (CASE WHEN source->>'type'='manual_qualifier' THEN source->>'qualifierId' END) THEN RETURN false; END IF;
      IF expected_source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM match_dependencies dependency
        WHERE dependency.match_id=expected_match_id AND dependency.format_revision_id=target_revision
          AND dependency.slot=slot_name AND dependency.source_match_id=expected_source_id AND dependency.outcome=source->>'type') THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION phase3_prevent_format_revision_content_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.competition_id IS DISTINCT FROM OLD.competition_id
     OR NEW.division_id IS DISTINCT FROM OLD.division_id OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.definition IS DISTINCT FROM OLD.definition OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.validation_contract IS DISTINCT FROM OLD.validation_contract OR NEW.layout IS DISTINCT FROM OLD.layout
     OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id OR NEW.root_revision_id IS DISTINCT FROM OLD.root_revision_id
     OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR NEW.source_kind IS DISTINCT FROM OLD.source_kind THEN
    RAISE EXCEPTION 'format revision content and lineage are immutable';
  END IF;
  IF OLD.graph_materialized_at IS NOT NULL AND (NEW.graph_materialized_at IS DISTINCT FROM OLD.graph_materialized_at
     OR NEW.graph_materialization_hash IS DISTINCT FROM OLD.graph_materialization_hash OR NEW.graph_match_count IS DISTINCT FROM OLD.graph_match_count) THEN
    RAISE EXCEPTION 'materialised format graph provenance is immutable';
  END IF;
  IF OLD.graph_materialized_at IS NULL AND NEW.graph_materialized_at IS NOT NULL AND (
     NOT phase4_materialization_is_exact(NEW.id) OR NEW.graph_match_count<>jsonb_array_length(NEW.definition->'matches')
     OR NEW.graph_materialization_hash<>phase4_expected_materialization_hash(NEW.id)) THEN
    RAISE EXCEPTION 'format graph materialisation provenance is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER aa_format_revisions_phase4_lineage_guard
BEFORE INSERT OR UPDATE ON format_revisions FOR EACH ROW EXECUTE FUNCTION phase4_guard_format_revision_lineage();

CREATE FUNCTION phase4_save_format_revision(target_competition uuid,target_division uuid,actor uuid,
  parent_revision uuid,definition_value jsonb,layout_value jsonb,source_kind_value text,template_version uuid,
  idempotency_value text,request_id_value text) RETURNS jsonb AS $$
DECLARE target_org uuid; parent_row format_revisions%ROWTYPE; saved format_revisions%ROWTYPE;
DECLARE receipt phase4_mutation_receipts%ROWTYPE; request_value jsonb; request_hash_value text; next_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('phase4-receipt:'||idempotency_value,0));
  SELECT organisation_id INTO target_org FROM competitions WHERE id=target_competition FOR SHARE;
  IF target_org IS NULL OR NOT EXISTS (SELECT 1 FROM divisions WHERE id=target_division AND competition_id=target_competition) THEN
    RAISE EXCEPTION 'format save target does not exist';
  END IF;
  request_value:=jsonb_build_object('competition_id',target_competition,'division_id',target_division,'parent_revision_id',parent_revision,
    'definition',definition_value,'layout',layout_value,'source_kind',source_kind_value,'template_version_id',template_version);
  request_hash_value:=phase4_sha256_json(request_value);
  SELECT * INTO receipt FROM phase4_mutation_receipts WHERE organisation_id=target_org AND idempotency_key=idempotency_value;
  IF receipt.id IS NOT NULL THEN
    IF receipt.operation<>'format.save' OR receipt.request_hash<>request_hash_value THEN RAISE EXCEPTION 'idempotency key was reused with a different format request'; END IF;
    RETURN receipt.response;
  END IF;
  PERFORM phase3_assert_competition_mutable(target_competition);
  PERFORM 1 FROM divisions WHERE id=target_division FOR UPDATE;
  IF parent_revision IS NULL THEN
    next_revision:=1;
  ELSE
    SELECT * INTO parent_row FROM format_revisions WHERE id=parent_revision FOR SHARE;
    IF parent_row.id IS NULL OR parent_row.division_id<>target_division THEN RAISE EXCEPTION 'format parent does not match division'; END IF;
    next_revision:=parent_row.revision+1;
  END IF;
  INSERT INTO format_revisions(competition_id,division_id,revision,parent_revision_id,definition,definition_hash,layout,
    source_kind,template_version_id,created_by,validation_contract)
  VALUES(target_competition,target_division,next_revision,parent_revision,definition_value,phase4_sha256_json(definition_value),layout_value,
    source_kind_value,template_version,actor,'phase3') RETURNING * INTO saved;
  INSERT INTO phase4_mutation_receipts(organisation_id,idempotency_key,operation,request_hash,response)
  VALUES(target_org,idempotency_value,'format.save',request_hash_value,to_jsonb(saved));
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id)
  VALUES(request_id_value,actor,'account',target_org,'format.saved','format_revision',saved.id::text);
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('format_revision',saved.id::text,'format.saved',jsonb_build_object('division_id',target_division,'revision',next_revision),
    'phase4:format-save:'||target_org::text||':'||idempotency_value);
  RETURN to_jsonb(saved);
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_reuse_format_template(target_version uuid,target_competition uuid,target_division uuid,actor uuid,
  parent_revision uuid,idempotency_value text,request_id_value text) RETURNS jsonb AS $$
DECLARE version_row format_template_versions%ROWTYPE; target_org uuid;
BEGIN
  SELECT * INTO version_row FROM format_template_versions WHERE id=target_version FOR SHARE;
  SELECT organisation_id INTO target_org FROM competitions WHERE id=target_competition;
  IF version_row.id IS NULL OR version_row.organisation_id<>target_org THEN RAISE EXCEPTION 'template version is outside competition organisation'; END IF;
  RETURN phase4_save_format_revision(target_competition,target_division,actor,parent_revision,version_row.definition,version_row.layout,
    'template',version_row.id,idempotency_value,request_id_value);
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_materialize_and_publish_format_revision(target_revision uuid,actor uuid,request_id_value text)
RETURNS format_revisions AS $$
BEGIN
  PERFORM phase4_materialize_format_revision(target_revision);
  RETURN phase4_publish_format_revision(target_revision,actor,request_id_value);
END;
$$ LANGUAGE plpgsql;

-- Stable graph IDs bridged into the existing UUID match/results pipeline. ---

ALTER TABLE matches
  ADD COLUMN graph_match_id text,
  ADD COLUMN graph_stage_id text,
  ADD COLUMN graph_pool_id text,
  ADD COLUMN graph_purpose text;

CREATE FUNCTION phase4_expected_materialization_hash(target_revision uuid) RETURNS text AS $$
  SELECT phase4_sha256_json(jsonb_build_object('definitionHash',fr.definition_hash,'matchIds',
    (SELECT jsonb_agg(m.graph_match_id ORDER BY m.ordinal) FROM matches m WHERE m.format_revision_id=fr.id)))
  FROM format_revisions fr WHERE fr.id=target_revision
$$ LANGUAGE sql STABLE;
CREATE UNIQUE INDEX matches_format_graph_match_unique
ON matches(format_revision_id,graph_match_id) WHERE graph_match_id IS NOT NULL;

CREATE TABLE format_match_sources (
  match_id uuid NOT NULL,
  format_revision_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  division_id uuid NOT NULL,
  slot text NOT NULL CHECK (slot IN ('home','away')),
  source_kind text NOT NULL CHECK (source_kind IN ('entry_seed','entry','winner','loser','stage_rank','manual_qualifier','bye')),
  entry_id uuid,
  entry_seed integer,
  source_graph_match_id text,
  source_match_id uuid,
  source_stage_id text,
  source_group_id text,
  source_rank integer,
  source_manual_qualifier_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id,slot),
  FOREIGN KEY (match_id,format_revision_id) REFERENCES matches(id,format_revision_id) ON DELETE CASCADE,
  FOREIGN KEY (format_revision_id,competition_id) REFERENCES format_revisions(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (division_id,competition_id) REFERENCES divisions(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id,division_id) REFERENCES division_entries(id,division_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_match_id,format_revision_id) REFERENCES matches(id,format_revision_id) ON DELETE RESTRICT,
  CHECK (source_rank IS NULL OR source_rank>0),
  CHECK (entry_seed IS NULL OR entry_seed>0),
  CHECK (
    (source_kind='entry_seed' AND entry_seed IS NOT NULL AND entry_id IS NULL AND source_match_id IS NULL AND source_stage_id IS NULL AND source_rank IS NULL AND source_manual_qualifier_id IS NULL)
    OR (source_kind='entry' AND entry_id IS NOT NULL AND entry_seed IS NULL AND source_match_id IS NULL AND source_stage_id IS NULL AND source_rank IS NULL AND source_manual_qualifier_id IS NULL)
    OR (source_kind IN ('winner','loser') AND source_match_id IS NOT NULL AND source_graph_match_id IS NOT NULL AND entry_id IS NULL AND entry_seed IS NULL AND source_stage_id IS NULL AND source_rank IS NULL AND source_manual_qualifier_id IS NULL)
    OR (source_kind='stage_rank' AND source_stage_id IS NOT NULL AND source_rank IS NOT NULL AND entry_id IS NULL AND entry_seed IS NULL AND source_match_id IS NULL AND source_manual_qualifier_id IS NULL)
    OR (source_kind='manual_qualifier' AND btrim(source_manual_qualifier_id)<>'' AND source_stage_id IS NOT NULL AND entry_id IS NULL AND entry_seed IS NULL AND source_match_id IS NULL AND source_rank IS NULL)
    OR (source_kind='bye' AND entry_id IS NULL AND entry_seed IS NULL AND source_match_id IS NULL AND source_stage_id IS NULL AND source_rank IS NULL AND source_manual_qualifier_id IS NULL)
  )
);

CREATE INDEX format_match_sources_revision_idx ON format_match_sources(format_revision_id,match_id);
CREATE INDEX format_match_sources_source_match_idx ON format_match_sources(source_match_id) WHERE source_match_id IS NOT NULL;

CREATE FUNCTION phase4_guard_format_match_source() RETURNS trigger AS $$
DECLARE target_match matches%ROWTYPE;
BEGIN
  SELECT * INTO target_match FROM matches WHERE id=NEW.match_id;
  IF target_match.id IS NULL OR target_match.format_revision_id<>NEW.format_revision_id
     OR target_match.competition_id<>NEW.competition_id OR target_match.division_id<>NEW.division_id THEN
    RAISE EXCEPTION 'format source tenant/revision does not match target match';
  END IF;
  IF NEW.source_match_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM matches source WHERE source.id=NEW.source_match_id
      AND source.format_revision_id=NEW.format_revision_id AND source.ordinal<target_match.ordinal
      AND source.graph_match_id=NEW.source_graph_match_id
  ) THEN RAISE EXCEPTION 'format source must reference an earlier match in the same graph'; END IF;
  IF NEW.entry_seed IS NOT NULL AND NEW.entry_seed>(SELECT team_limit FROM divisions WHERE id=NEW.division_id) THEN
    RAISE EXCEPTION 'format source seed exceeds division limit';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_guard_materialised_projection() RETURNS trigger AS $$
DECLARE target_revision uuid; materialised_at timestamptz; target_competition uuid;
BEGIN
  IF TG_TABLE_NAME='matches' THEN
    target_revision:=CASE WHEN TG_OP='DELETE' THEN OLD.format_revision_id ELSE NEW.format_revision_id END;
    target_competition:=CASE WHEN TG_OP='DELETE' THEN OLD.competition_id ELSE NEW.competition_id END;
  ELSE
    target_revision:=CASE WHEN TG_OP='DELETE' THEN OLD.format_revision_id ELSE NEW.format_revision_id END;
    SELECT competition_id INTO target_competition FROM format_revisions WHERE id=target_revision;
  END IF;
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM competitions WHERE id=target_competition) THEN RETURN OLD; END IF;
  SELECT graph_materialized_at INTO materialised_at FROM format_revisions WHERE id=target_revision;
  IF materialised_at IS NOT NULL THEN
    IF TG_TABLE_NAME='matches' AND TG_OP='UPDATE' THEN
      IF NEW.id=OLD.id AND NEW.competition_id=OLD.competition_id AND NEW.division_id=OLD.division_id
         AND NEW.format_revision_id=OLD.format_revision_id AND NEW.code=OLD.code AND NEW.stage=OLD.stage
         AND NEW.round_number=OLD.round_number AND NEW.ordinal=OLD.ordinal
         AND NEW.graph_match_id IS NOT DISTINCT FROM OLD.graph_match_id
         AND NEW.graph_stage_id IS NOT DISTINCT FROM OLD.graph_stage_id
         AND NEW.graph_pool_id IS NOT DISTINCT FROM OLD.graph_pool_id
         AND NEW.graph_purpose IS NOT DISTINCT FROM OLD.graph_purpose THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'materialised format projection is immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER format_match_sources_phase4_guard BEFORE INSERT OR UPDATE ON format_match_sources
FOR EACH ROW EXECUTE FUNCTION phase4_guard_format_match_source();
CREATE TRIGGER aa_format_match_sources_phase4_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON format_match_sources
FOR EACH ROW EXECUTE FUNCTION phase4_guard_materialised_projection();
CREATE TRIGGER format_match_sources_phase4_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON format_match_sources
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();

CREATE FUNCTION phase4_materialize_format_revision(target_revision uuid) RETURNS integer AS $$
DECLARE revision_row format_revisions%ROWTYPE; graph_match jsonb; source jsonb; new_match_id uuid; source_uuid uuid;
DECLARE stage_kind text; ordinal_value integer; inserted_count integer:=0; slot_name text;
BEGIN
  SELECT * INTO revision_row FROM format_revisions WHERE id=target_revision FOR UPDATE;
  IF revision_row.id IS NULL OR revision_row.status<>'draft' OR revision_row.validation_contract<>'phase3'
     OR NOT phase3_format_definition_db_valid(revision_row.definition)
     OR revision_row.definition_hash<>phase4_sha256_json(revision_row.definition) THEN
    RAISE EXCEPTION 'only a valid immutable Phase 4 draft graph can be materialised';
  END IF;
  PERFORM phase3_assert_competition_mutable(revision_row.competition_id);
  IF EXISTS (SELECT 1 FROM matches WHERE format_revision_id=target_revision)
     OR revision_row.graph_materialized_at IS NOT NULL THEN
    RAISE EXCEPTION 'format revision graph has already been materialised';
  END IF;

  FOR graph_match IN
    SELECT value FROM jsonb_array_elements(revision_row.definition->'matches') item(value)
    ORDER BY (value->>'order')::integer,value->>'id'
  LOOP
    ordinal_value := (graph_match->>'order')::integer;
    new_match_id := phase4_deterministic_uuid(target_revision,graph_match->>'id');
    SELECT COALESCE(stage->>'kind','custom') INTO stage_kind
    FROM jsonb_array_elements(revision_row.definition->'stages') stage
    WHERE stage->>'id'=graph_match->>'stageId';
    INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,
      graph_match_id,graph_stage_id,graph_pool_id,graph_purpose)
    VALUES(new_match_id,revision_row.competition_id,revision_row.division_id,target_revision,
      left(graph_match->>'id',40),
      CASE
        WHEN graph_match->>'purpose'='championship' THEN 'final'
        WHEN graph_match->>'purpose'='placement' THEN 'bronze'
        WHEN stage_kind='single_elimination' THEN 'quarterfinal'
        ELSE 'group'
      END,
      (graph_match->>'round')::integer,ordinal_value,graph_match->>'id',graph_match->>'stageId',graph_match->>'poolId',graph_match->>'purpose');
    inserted_count:=inserted_count+1;
  END LOOP;

  FOR graph_match IN SELECT value FROM jsonb_array_elements(revision_row.definition->'matches') LOOP
    new_match_id:=phase4_deterministic_uuid(target_revision,graph_match->>'id');
    FOREACH slot_name IN ARRAY ARRAY['home','away'] LOOP
      source:=graph_match->slot_name;
      source_uuid:=CASE WHEN source->>'type' IN ('winner','loser')
        THEN phase4_deterministic_uuid(target_revision,source->>'matchId') ELSE NULL END;
      INSERT INTO format_match_sources(match_id,format_revision_id,competition_id,division_id,slot,source_kind,
        entry_seed,source_graph_match_id,source_match_id,source_stage_id,source_group_id,source_rank,source_manual_qualifier_id)
      VALUES(new_match_id,target_revision,revision_row.competition_id,revision_row.division_id,slot_name,
        source->>'type',CASE WHEN source->>'type'='entry_seed' THEN (source->>'seed')::integer END,
        CASE WHEN source->>'type' IN ('winner','loser') THEN source->>'matchId' END,source_uuid,
        CASE WHEN source->>'type' IN ('stage_rank','manual_qualifier') THEN source->>'stageId' END,
        CASE WHEN source->>'type'='stage_rank' THEN source->>'groupId' END,
        CASE WHEN source->>'type'='stage_rank' THEN (source->>'rank')::integer END,
        CASE WHEN source->>'type'='manual_qualifier' THEN source->>'qualifierId' END);
      IF source_uuid IS NOT NULL THEN
        INSERT INTO match_dependencies(match_id,format_revision_id,slot,source_match_id,outcome)
        VALUES(new_match_id,target_revision,slot_name,source_uuid,source->>'type');
      END IF;
    END LOOP;
  END LOOP;

  UPDATE format_revisions SET graph_materialized_at=now(),graph_match_count=inserted_count,
    graph_materialization_hash=phase4_sha256_json(jsonb_build_object(
      'definitionHash',definition_hash,'matchIds',(SELECT jsonb_agg(graph_match_id ORDER BY ordinal) FROM matches WHERE format_revision_id=target_revision)
    )) WHERE id=target_revision;
  RETURN inserted_count;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_match_possible_entries(target_match uuid) RETURNS TABLE(entry_id uuid) AS $$
  WITH RECURSIVE reachable(match_id,entry_id) AS (
    SELECT source.match_id,entry.id
    FROM format_match_sources source
    JOIN matches target ON target.id=source.match_id
    JOIN division_entries entry ON entry.division_id=target.division_id AND entry.seed=source.entry_seed
      AND entry.status IN ('confirmed','active')
    WHERE source.source_kind='entry_seed'
    UNION
    SELECT consumer.match_id,reachable.entry_id
    FROM reachable
    JOIN matches producer ON producer.id=reachable.match_id
    JOIN format_match_sources consumer ON consumer.format_revision_id=producer.format_revision_id AND (
      consumer.source_match_id=producer.id OR
      (consumer.source_stage_id=producer.graph_stage_id AND
        (consumer.source_group_id IS NULL OR consumer.source_group_id=producer.graph_pool_id)))
  )
  SELECT DISTINCT reachable.entry_id FROM reachable WHERE reachable.match_id=target_match ORDER BY reachable.entry_id
$$ LANGUAGE sql STABLE;

CREATE FUNCTION phase4_publish_format_revision(target_revision uuid, actor uuid, request_id_value text) RETURNS format_revisions AS $$
DECLARE candidate format_revisions%ROWTYPE; previous_id uuid;
BEGIN
  SELECT * INTO candidate FROM format_revisions WHERE id=target_revision FOR UPDATE;
  IF candidate.id IS NULL OR candidate.status<>'draft' OR candidate.graph_materialized_at IS NULL
     OR NOT phase4_materialization_is_exact(candidate.id)
     OR candidate.graph_materialization_hash<>phase4_expected_materialization_hash(candidate.id)
     OR candidate.graph_match_count<>jsonb_array_length(candidate.definition->'matches')
     OR (SELECT count(*) FROM matches WHERE format_revision_id=candidate.id)<>candidate.graph_match_count
     OR (SELECT count(*) FROM format_match_sources WHERE format_revision_id=candidate.id)<>candidate.graph_match_count*2 THEN
    RAISE EXCEPTION 'format publication requires a completely materialised draft';
  END IF;
  PERFORM 1 FROM divisions WHERE id=candidate.division_id FOR UPDATE;
  SELECT id INTO previous_id FROM format_revisions WHERE division_id=candidate.division_id AND status='published' FOR UPDATE;
  IF previous_id IS NOT NULL THEN UPDATE format_revisions SET status='superseded' WHERE id=previous_id; END IF;
  UPDATE format_revisions SET status='published',published_at=now() WHERE id=target_revision RETURNING * INTO candidate;
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  SELECT request_id_value,actor,'account',c.organisation_id,'format.published','format_revision',candidate.id::text,
    jsonb_build_object('division_id',candidate.division_id,'superseded_revision_id',previous_id)
  FROM competitions c WHERE c.id=candidate.competition_id;
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('format_revision',candidate.id::text,'format.published',jsonb_build_object('competition_id',candidate.competition_id,'division_id',candidate.division_id),
    'phase4:format-published:'||candidate.id::text);
  RETURN candidate;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER aa_matches_phase4_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON matches
FOR EACH ROW EXECUTE FUNCTION phase4_guard_materialised_projection();
CREATE TRIGGER aa_match_dependencies_phase4_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON match_dependencies
FOR EACH ROW EXECUTE FUNCTION phase4_guard_materialised_projection();

-- Multi-division schedule inputs, background jobs, immutable options/revisions

CREATE FUNCTION phase4_json_exact_keys(value jsonb,keys text[]) RETURNS boolean AS $$
  SELECT jsonb_typeof(value)='object' AND
    (SELECT count(*)=COALESCE(array_length(keys,1),0) AND bool_and(key=ANY(keys)) FROM jsonb_object_keys(value) key)
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION phase4_json_nonnegative_integer(value jsonb) RETURNS boolean AS $$
  SELECT jsonb_typeof(value)='number' AND (value#>>'{}')::numeric=trunc((value#>>'{}')::numeric)
    AND (value#>>'{}')::numeric BETWEEN 0 AND 9007199254740991
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION phase4_schedule_intervals_valid(value jsonb) RETURNS boolean AS $$
BEGIN
  RETURN jsonb_typeof(value)='array' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(value) interval_value
    WHERE NOT phase4_json_exact_keys(interval_value,ARRAY['start_epoch_ms','end_epoch_ms'])
      OR NOT phase4_json_nonnegative_integer(interval_value->'start_epoch_ms')
      OR NOT phase4_json_nonnegative_integer(interval_value->'end_epoch_ms')
      OR (interval_value->>'end_epoch_ms')::numeric<=(interval_value->>'start_epoch_ms')::numeric);
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase4_schedule_constraint_value_valid(constraint_key text,value jsonb) RETURNS boolean AS $$
DECLARE item record;
BEGIN
  IF constraint_key IN ('minimum_rest','avoid_consecutive_matches') THEN
    RETURN phase4_json_exact_keys(value,ARRAY['minutes']) AND phase4_json_nonnegative_integer(value->'minutes');
  ELSIF constraint_key='maximum_matches_per_day' THEN
    RETURN phase4_json_exact_keys(value,ARRAY['matches']) AND phase3_json_positive_integer(value->'matches');
  ELSIF constraint_key='preferred_final_time' THEN
    RETURN phase4_json_exact_keys(value,ARRAY['target_start_epoch_ms','tolerance_minutes'])
      AND phase4_json_nonnegative_integer(value->'target_start_epoch_ms') AND phase4_json_nonnegative_integer(value->'tolerance_minutes');
  ELSIF constraint_key IN ('entry_unavailable','official_availability') THEN
    IF NOT phase4_json_exact_keys(value,ARRAY[CASE WHEN constraint_key='entry_unavailable' THEN 'by_entry_id' ELSE 'by_official_id' END]) THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_each(value->(CASE WHEN constraint_key='entry_unavailable' THEN 'by_entry_id' ELSE 'by_official_id' END)) LOOP
      IF item.key::uuid IS NULL OR NOT phase4_schedule_intervals_valid(item.value) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  ELSIF constraint_key='featured_playing_area' THEN
    RETURN phase4_json_exact_keys(value,ARRAY['area_id','match_ids']) AND (value->>'area_id')::uuid IS NOT NULL
      AND jsonb_typeof(value->'match_ids')='array'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(value->'match_ids') match_item(value) WHERE match_item.value::uuid IS NULL)
      AND (SELECT count(*)=count(DISTINCT match_item.value) FROM jsonb_array_elements_text(value->'match_ids') match_item(value));
  ELSIF constraint_key='balance_early_matches' THEN
    RETURN phase4_json_exact_keys(value,ARRAY['before_local_time']) AND value->>'before_local_time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  ELSIF constraint_key='balance_late_matches' THEN
    RETURN phase4_json_exact_keys(value,ARRAY['at_or_after_local_time']) AND value->>'at_or_after_local_time' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  ELSIF constraint_key='keep_division_together' THEN
    RETURN phase4_json_exact_keys(value,ARRAY['maximum_area_count']) AND phase3_json_positive_integer(value->'maximum_area_count');
  ELSIF constraint_key='preserve_existing_schedule' THEN
    IF NOT phase4_json_exact_keys(value,ARRAY['maximum_shift_minutes','by_match_id'])
       OR NOT phase4_json_nonnegative_integer(value->'maximum_shift_minutes') OR jsonb_typeof(value->'by_match_id')<>'object' THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_each(value->'by_match_id') LOOP
      IF item.key::uuid IS NULL OR NOT phase4_json_exact_keys(item.value,ARRAY['area_id','start_epoch_ms'])
         OR (item.value->>'area_id')::uuid IS NULL OR NOT phase4_json_nonnegative_integer(item.value->'start_epoch_ms') THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase4_schedule_input_valid(value jsonb) RETURNS boolean AS $$
DECLARE match_value jsonb; slot_value jsonb; setting_value jsonb; constraint_key text;
DECLARE constraint_keys text[]:=ARRAY['minimum_rest','maximum_matches_per_day','preferred_final_time','entry_unavailable',
  'official_availability','featured_playing_area','avoid_consecutive_matches','balance_early_matches','balance_late_matches',
  'keep_division_together','preserve_existing_schedule'];
BEGIN
  IF jsonb_typeof(value)<>'object'
     OR (SELECT count(*)<>11 OR NOT bool_and(key=ANY(ARRAY['schema_version','job_id','competition_id','source_revision','time_zone','objective','capacity_revision','capacity_hash','matches','slots','constraints']))
       FROM jsonb_object_keys(value) key)
     OR value->'schema_version'<>'1'::jsonb
     OR jsonb_typeof(value->'job_id')<>'string' OR (value->>'job_id')::uuid IS NULL
     OR jsonb_typeof(value->'competition_id')<>'string' OR (value->>'competition_id')::uuid IS NULL
     OR NOT phase3_json_positive_integer(value->'source_revision')
     OR NOT phase3_json_positive_integer(value->'capacity_revision')
     OR jsonb_typeof(value->'capacity_hash')<>'string' OR value->>'capacity_hash' !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(value->'time_zone')<>'string' OR btrim(value->>'time_zone')=''
     OR value->>'objective' NOT IN ('fastest','balanced','rest_focused')
     OR jsonb_typeof(value->'matches')<>'array' OR jsonb_array_length(value->'matches')=0
     OR jsonb_typeof(value->'slots')<>'array' OR jsonb_array_length(value->'slots')=0
     OR jsonb_typeof(value->'constraints')<>'object' THEN RETURN false; END IF;
  IF (SELECT count(*)<>array_length(constraint_keys,1) OR NOT bool_and(key=ANY(constraint_keys))
      FROM jsonb_object_keys(value->'constraints') key) THEN RETURN false; END IF;
  FOREACH constraint_key IN ARRAY constraint_keys LOOP
    setting_value:=value->'constraints'->constraint_key;
    IF jsonb_typeof(setting_value)<>'object' OR setting_value->>'mode' NOT IN ('required','preferred','ignored')
       OR NOT setting_value ? 'value'
       OR NOT phase4_schedule_constraint_value_valid(constraint_key,setting_value->'value')
       OR (SELECT count(*)<>CASE WHEN setting_value ? 'weight' THEN 3 ELSE 2 END
         OR NOT bool_and(key=ANY(ARRAY['mode','value','weight'])) FROM jsonb_object_keys(setting_value) key)
       OR (setting_value ? 'weight' AND (NOT phase3_json_positive_integer(setting_value->'weight') OR setting_value->>'mode'<>'preferred')) THEN RETURN false; END IF;
  END LOOP;
  FOR match_value IN SELECT item FROM jsonb_array_elements(value->'matches') item LOOP
    IF jsonb_typeof(match_value)<>'object'
       OR (SELECT count(*)<>CASE WHEN match_value ? 'fixed_assignment' THEN 8 ELSE 7 END
         OR NOT bool_and(key=ANY(ARRAY['match_id','division_id','duration_minutes','dependency_match_ids','possible_entry_ids','official_ids','is_championship_final','fixed_assignment']))
         FROM jsonb_object_keys(match_value) key)
       OR (match_value->>'match_id')::uuid IS NULL OR (match_value->>'division_id')::uuid IS NULL
       OR NOT phase3_json_positive_integer(match_value->'duration_minutes')
       OR jsonb_typeof(match_value->'dependency_match_ids')<>'array' OR jsonb_typeof(match_value->'possible_entry_ids')<>'array'
       OR jsonb_array_length(match_value->'possible_entry_ids')<2
       OR jsonb_typeof(match_value->'official_ids')<>'array' OR jsonb_typeof(match_value->'is_championship_final')<>'boolean'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(match_value->'dependency_match_ids') item WHERE item::uuid IS NULL)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(match_value->'possible_entry_ids') item WHERE item::uuid IS NULL)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(match_value->'official_ids') item WHERE item::uuid IS NULL)
       OR (SELECT count(*)<>count(DISTINCT item) FROM jsonb_array_elements_text(match_value->'possible_entry_ids') item)
       OR (match_value ? 'fixed_assignment' AND (jsonb_typeof(match_value->'fixed_assignment')<>'object'
         OR (SELECT count(*)<>5 OR NOT bool_and(key=ANY(ARRAY['reason','area_id','slot_id','start_epoch_ms','end_epoch_ms']))
           FROM jsonb_object_keys(match_value->'fixed_assignment') key)
         OR match_value->'fixed_assignment'->>'reason' NOT IN ('locked','published_history')
         OR (match_value->'fixed_assignment'->>'area_id')::uuid IS NULL OR btrim(match_value->'fixed_assignment'->>'slot_id')=''
         OR jsonb_typeof(match_value->'fixed_assignment'->'start_epoch_ms')<>'number'
         OR jsonb_typeof(match_value->'fixed_assignment'->'end_epoch_ms')<>'number')) THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*)<>count(DISTINCT item->>'match_id') FROM jsonb_array_elements(value->'matches') item) THEN RETURN false; END IF;
  FOR slot_value IN SELECT item FROM jsonb_array_elements(value->'slots') item LOOP
    IF jsonb_typeof(slot_value)<>'object'
       OR (SELECT count(*)<>5 OR NOT bool_and(key=ANY(ARRAY['slot_id','interval_id','area_id','start_epoch_ms','end_epoch_ms'])) FROM jsonb_object_keys(slot_value) key)
       OR btrim(slot_value->>'slot_id')='' OR (slot_value->>'interval_id')::uuid IS NULL
       OR (slot_value->>'area_id')::uuid IS NULL OR jsonb_typeof(slot_value->'start_epoch_ms')<>'number'
       OR jsonb_typeof(slot_value->'end_epoch_ms')<>'number'
       OR (slot_value->>'end_epoch_ms')::numeric<=(slot_value->>'start_epoch_ms')::numeric THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*)<>count(DISTINCT item->>'slot_id') FROM jsonb_array_elements(value->'slots') item) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase4_schedule_problem_hash(value jsonb) RETURNS text AS $$
  SELECT phase4_sha256_json(value-'job_id')
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE FUNCTION phase4_capacity_hash(target_competition uuid) RETURNS text AS $$
DECLARE material text;
BEGIN
  SELECT concat_ws('|',c.id,c.capacity_revision,COALESCE(c.capacity_timezone,c.timezone),
    COALESCE((SELECT string_agg(concat_ws(':',a.id,a.slot_minutes,a.fixed_reserve_slots,a.revision,a.updated_at),',' ORDER BY a.id)
      FROM playing_areas a WHERE a.competition_id=c.id),''),
    COALESCE((SELECT string_agg(concat_ws(':',w.id,w.playing_area_id,w.starts_at,w.ends_at,w.source_date,w.source_start_time,w.source_end_time,w.source_cross_midnight),',' ORDER BY w.id)
      FROM competition_availability_windows w WHERE w.competition_id=c.id),''),
    COALESCE((SELECT string_agg(concat_ws(':',u.id,u.playing_area_id,u.starts_at,u.ends_at,u.source_date,u.source_start_time,u.source_end_time,u.source_cross_midnight),',' ORDER BY u.id)
      FROM playing_area_unavailable_intervals u WHERE u.competition_id=c.id),''))
  INTO material FROM competitions c WHERE c.id=target_competition;
  IF material IS NULL THEN RETURN NULL; END IF;
  RETURN encode(pg_catalog.sha256(convert_to(material,'UTF8')),'hex');
END;
$$ LANGUAGE plpgsql STABLE;

ALTER TABLE schedule_revisions DROP CONSTRAINT schedule_revisions_status_check;
ALTER TABLE schedule_revisions ADD CONSTRAINT schedule_revisions_status_check
  CHECK (status IN ('draft','ready_for_review','published','superseded','expired'));
ALTER TABLE schedule_revisions DROP CONSTRAINT schedule_revisions_competition_id_input_hash_key;
ALTER TABLE schedule_revisions
  ADD COLUMN parent_revision_id uuid REFERENCES schedule_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN source_job_id uuid,
  ADD COLUMN source_option_id uuid,
  ADD COLUMN assignment_hash text CHECK (assignment_hash IS NULL OR assignment_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN quality jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quality)='object'),
  ADD COLUMN editable_until timestamptz,
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN expired_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE schedule_revision_formats (
  schedule_revision_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  division_id uuid NOT NULL,
  format_revision_id uuid NOT NULL,
  PRIMARY KEY(schedule_revision_id,division_id),
  FOREIGN KEY(schedule_revision_id,competition_id) REFERENCES schedule_revisions(id,competition_id) ON DELETE CASCADE,
  FOREIGN KEY(division_id,competition_id) REFERENCES divisions(id,competition_id) ON DELETE RESTRICT,
  FOREIGN KEY(format_revision_id,competition_id,division_id) REFERENCES format_revisions(id,competition_id,division_id) ON DELETE RESTRICT
);
CREATE INDEX schedule_revision_formats_format_idx ON schedule_revision_formats(format_revision_id);

CREATE TABLE schedule_generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','valid_best_found','cancelling','cancelled','completed','failed','no_solution','stale')),
  objective text NOT NULL CHECK (objective IN ('fastest','balanced','rest_focused')),
  input_snapshot jsonb NOT NULL CHECK (phase4_schedule_input_valid(input_snapshot)),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  problem_hash text GENERATED ALWAYS AS (phase4_schedule_problem_hash(input_snapshot)) STORED,
  requested_by uuid NOT NULL REFERENCES accounts(id),
  request_id text NOT NULL CHECK (btrim(request_id)<>''),
  correlation_id text NOT NULL CHECK (btrim(correlation_id)<>''),
  continued_from_job_id uuid REFERENCES schedule_generation_jobs(id) ON DELETE RESTRICT,
  current_best_option_id uuid,
  worker_id text,
  fence_token uuid,
  lease_generation integer NOT NULL DEFAULT 0 CHECK (lease_generation>=0),
  lease_expires_at timestamptz,
  cancellation_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failure_class text CHECK (failure_class IS NULL OR failure_class IN ('invalid_input','no_solution','timeout','transient','permanent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,competition_id),
  UNIQUE(id,organisation_id),
  FOREIGN KEY(competition_id,organisation_id) REFERENCES competitions(id,organisation_id),
  CHECK (input_hash=phase4_sha256_json(input_snapshot)),
  CHECK ((input_snapshot->>'job_id')::uuid=id AND (input_snapshot->>'competition_id')::uuid=competition_id
    AND input_snapshot->>'objective'=objective),
  CHECK ((status IN ('running','valid_best_found','cancelling') AND worker_id IS NOT NULL AND fence_token IS NOT NULL AND lease_expires_at IS NOT NULL AND started_at IS NOT NULL)
      OR status NOT IN ('running','valid_best_found','cancelling')),
  CHECK ((status IN ('cancelled','completed','failed','no_solution','stale') AND completed_at IS NOT NULL) OR status NOT IN ('cancelled','completed','failed','no_solution','stale')),
  CHECK ((status='failed' AND failure_class IS NOT NULL) OR (status<>'failed' AND failure_class IS NULL))
);
CREATE UNIQUE INDEX schedule_generation_jobs_one_active_competition
ON schedule_generation_jobs(competition_id) WHERE status IN ('queued','running','valid_best_found','cancelling');
CREATE INDEX schedule_generation_jobs_claim_idx ON schedule_generation_jobs(created_at,id) WHERE status='queued';
CREATE INDEX schedule_generation_jobs_tenant_idx ON schedule_generation_jobs(organisation_id,competition_id,created_at DESC);
CREATE INDEX schedule_generation_jobs_problem_idx ON schedule_generation_jobs(competition_id,problem_hash,created_at DESC);

CREATE FUNCTION phase4_guard_schedule_job_input_references() RETURNS trigger AS $$
DECLARE competition_row competitions%ROWTYPE; match_value jsonb; slot_value jsonb; stored_match matches%ROWTYPE;
BEGIN
  SELECT * INTO competition_row FROM competitions WHERE id=NEW.competition_id FOR SHARE;
  IF competition_row.id IS NULL OR competition_row.organisation_id<>NEW.organisation_id
     OR (NEW.input_snapshot->>'capacity_revision')::bigint<>competition_row.capacity_revision
     OR NEW.input_snapshot->>'capacity_hash'<>phase4_capacity_hash(NEW.competition_id) THEN
    RAISE EXCEPTION 'schedule job capacity provenance is stale or invalid';
  END IF;
  FOR match_value IN SELECT item FROM jsonb_array_elements(NEW.input_snapshot->'matches') item LOOP
    SELECT * INTO stored_match FROM matches WHERE id=(match_value->>'match_id')::uuid;
    IF stored_match.id IS NULL OR stored_match.competition_id<>NEW.competition_id
       OR stored_match.division_id<>(match_value->>'division_id')::uuid
       OR NOT EXISTS (SELECT 1 FROM format_revisions fr WHERE fr.id=stored_match.format_revision_id AND fr.status='published')
       OR EXISTS (SELECT possible::uuid FROM jsonb_array_elements_text(match_value->'possible_entry_ids') possible
          EXCEPT SELECT entry_id FROM phase4_match_possible_entries(stored_match.id))
       OR EXISTS (SELECT entry_id FROM phase4_match_possible_entries(stored_match.id)
          EXCEPT SELECT possible::uuid FROM jsonb_array_elements_text(match_value->'possible_entry_ids') possible)
       OR EXISTS (SELECT dependency.source_match_id FROM match_dependencies dependency WHERE dependency.match_id=stored_match.id
          EXCEPT SELECT item::uuid FROM jsonb_array_elements_text(match_value->'dependency_match_ids') item)
       OR EXISTS (SELECT item::uuid FROM jsonb_array_elements_text(match_value->'dependency_match_ids') item
          EXCEPT SELECT dependency.source_match_id FROM match_dependencies dependency WHERE dependency.match_id=stored_match.id) THEN
      RAISE EXCEPTION 'schedule job match, division, participants, or dependencies are not authoritative';
    END IF;
  END LOOP;
  FOR slot_value IN SELECT item FROM jsonb_array_elements(NEW.input_snapshot->'slots') item LOOP
    IF NOT EXISTS (
      SELECT 1 FROM competition_availability_windows availability_window
      JOIN playing_areas area ON area.id=availability_window.playing_area_id AND area.competition_id=availability_window.competition_id
      WHERE availability_window.id=(slot_value->>'interval_id')::uuid AND availability_window.competition_id=NEW.competition_id
        AND availability_window.playing_area_id=(slot_value->>'area_id')::uuid
        AND to_timestamp((slot_value->>'start_epoch_ms')::double precision/1000)>=availability_window.starts_at
        AND to_timestamp((slot_value->>'end_epoch_ms')::double precision/1000)<=availability_window.ends_at
        AND (slot_value->>'end_epoch_ms')::numeric-(slot_value->>'start_epoch_ms')::numeric=area.slot_minutes::numeric*60000
        AND NOT EXISTS (SELECT 1 FROM playing_area_unavailable_intervals unavailable
          WHERE unavailable.playing_area_id=area.id
            AND tstzrange(unavailable.starts_at,unavailable.ends_at,'[)') && tstzrange(
              to_timestamp((slot_value->>'start_epoch_ms')::double precision/1000),
              to_timestamp((slot_value->>'end_epoch_ms')::double precision/1000),'[)'))
    ) THEN RAISE EXCEPTION 'schedule job slot is outside authoritative capacity'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER schedule_generation_jobs_phase4_input_guard BEFORE INSERT ON schedule_generation_jobs
FOR EACH ROW EXECUTE FUNCTION phase4_guard_schedule_job_input_references();

CREATE FUNCTION phase4_guard_schedule_job_continuation() RETURNS trigger AS $$
DECLARE parent schedule_generation_jobs%ROWTYPE;
BEGIN
  IF NEW.continued_from_job_id IS NOT NULL THEN
    SELECT * INTO parent FROM schedule_generation_jobs WHERE id=NEW.continued_from_job_id FOR SHARE;
    IF parent.id IS NULL OR parent.organisation_id<>NEW.organisation_id OR parent.competition_id<>NEW.competition_id
       OR parent.problem_hash<>phase4_schedule_problem_hash(NEW.input_snapshot) OR parent.current_best_option_id IS NULL THEN
      RAISE EXCEPTION 'schedule continuation must preserve the exact tenant, problem, and current best lineage';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER schedule_generation_jobs_phase4_continuation_guard BEFORE INSERT ON schedule_generation_jobs
FOR EACH ROW EXECUTE FUNCTION phase4_guard_schedule_job_continuation();

CREATE FUNCTION phase4_schedule_quality_valid(value jsonb,expected_objective text) RETURNS boolean AS $$
DECLARE component jsonb;
DECLARE component_keys text[]:=ARRAY['completion','rest','daily_balance','preferred_final','featured_area','consecutive',
  'time_balance','division_cohesion','schedule_preservation','entry_availability','official_availability'];
BEGIN
  IF jsonb_typeof(value)<>'object'
     OR (SELECT count(*)<>10 OR NOT bool_and(key=ANY(ARRAY['score','objective','valid','makespan_minutes','minimum_rest_minutes',
       'maximum_matches_per_entry_day','preferred_final_delta_minutes','required_violation_count','preferred_penalty','components']))
       FROM jsonb_object_keys(value) key)
     OR value->>'objective'<>expected_objective OR value->'valid'<>'true'::jsonb
     OR jsonb_typeof(value->'score')<>'number' OR (value->>'score')::numeric NOT BETWEEN 0 AND 100
     OR jsonb_typeof(value->'makespan_minutes')<>'number' OR (value->>'makespan_minutes')::numeric<0
     OR (value->'minimum_rest_minutes'<>'null'::jsonb AND (jsonb_typeof(value->'minimum_rest_minutes')<>'number' OR (value->>'minimum_rest_minutes')::numeric<0))
     OR jsonb_typeof(value->'maximum_matches_per_entry_day')<>'number' OR (value->>'maximum_matches_per_entry_day')::numeric<0
     OR (value->'preferred_final_delta_minutes'<>'null'::jsonb AND (jsonb_typeof(value->'preferred_final_delta_minutes')<>'number' OR (value->>'preferred_final_delta_minutes')::numeric<0))
     OR jsonb_typeof(value->'required_violation_count')<>'number' OR (value->>'required_violation_count')::numeric<0
     OR jsonb_typeof(value->'preferred_penalty')<>'number' OR (value->>'preferred_penalty')::numeric<0
     OR jsonb_typeof(value->'components')<>'array' OR jsonb_array_length(value->'components')<>array_length(component_keys,1)
     OR (SELECT count(*)<>count(DISTINCT item->>'key') OR NOT bool_and(item->>'key'=ANY(component_keys))
       FROM jsonb_array_elements(value->'components') item) THEN RETURN false; END IF;
  FOR component IN SELECT item FROM jsonb_array_elements(value->'components') item LOOP
    IF jsonb_typeof(component)<>'object'
       OR (SELECT count(*)<>6 OR NOT bool_and(key=ANY(ARRAY['key','score','weight','measured','unit','explanation'])) FROM jsonb_object_keys(component) key)
       OR jsonb_typeof(component->'score')<>'number' OR (component->>'score')::numeric NOT BETWEEN 0 AND 100
       OR jsonb_typeof(component->'weight')<>'number' OR (component->>'weight')::numeric<0
       OR jsonb_typeof(component->'measured')<>'number'
       OR component->>'unit' NOT IN ('minutes','matches','areas','percent')
       OR jsonb_typeof(component->'explanation')<>'string' OR btrim(component->>'explanation')='' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase4_schedule_quality_better(candidate jsonb,current_value jsonb,objective_value text,
  candidate_hash text,current_hash text) RETURNS boolean AS $$
BEGIN
  IF (candidate->>'score')::numeric<>(current_value->>'score')::numeric THEN
    RETURN (candidate->>'score')::numeric>(current_value->>'score')::numeric;
  END IF;
  IF (candidate->>'preferred_penalty')::numeric<>(current_value->>'preferred_penalty')::numeric THEN
    RETURN (candidate->>'preferred_penalty')::numeric<(current_value->>'preferred_penalty')::numeric;
  END IF;
  IF objective_value='fastest' AND (candidate->>'makespan_minutes')::numeric<>(current_value->>'makespan_minutes')::numeric THEN
    RETURN (candidate->>'makespan_minutes')::numeric<(current_value->>'makespan_minutes')::numeric;
  ELSIF objective_value='rest_focused' AND
    COALESCE((candidate->>'minimum_rest_minutes')::numeric,1e100::numeric)<>COALESCE((current_value->>'minimum_rest_minutes')::numeric,1e100::numeric) THEN
    RETURN COALESCE((candidate->>'minimum_rest_minutes')::numeric,1e100::numeric)>COALESCE((current_value->>'minimum_rest_minutes')::numeric,1e100::numeric);
  ELSIF objective_value='balanced' THEN
    IF (candidate->>'maximum_matches_per_entry_day')::numeric<>(current_value->>'maximum_matches_per_entry_day')::numeric THEN
      RETURN (candidate->>'maximum_matches_per_entry_day')::numeric<(current_value->>'maximum_matches_per_entry_day')::numeric;
    ELSIF COALESCE((candidate->>'preferred_final_delta_minutes')::numeric,-1)<>COALESCE((current_value->>'preferred_final_delta_minutes')::numeric,-1) THEN
      RETURN COALESCE((candidate->>'preferred_final_delta_minutes')::numeric,-1)<COALESCE((current_value->>'preferred_final_delta_minutes')::numeric,-1);
    ELSIF (candidate->>'makespan_minutes')::numeric<>(current_value->>'makespan_minutes')::numeric THEN
      RETURN (candidate->>'makespan_minutes')::numeric<(current_value->>'makespan_minutes')::numeric;
    END IF;
  END IF;
  RETURN candidate_hash<current_hash;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE FUNCTION phase4_schedule_assignments_valid(snapshot jsonb,assignments_value jsonb) RETURNS boolean AS $$
DECLARE assignment jsonb; match_value jsonb; fixed_value jsonb; required_rest numeric:=0;
DECLARE required_max_per_day integer; constraint_value jsonb; balance_spread integer; threshold_minutes integer;
BEGIN
  IF jsonb_typeof(assignments_value)<>'array'
     OR jsonb_array_length(assignments_value)<>jsonb_array_length(snapshot->'matches')
     OR (SELECT count(*)<>count(DISTINCT item->>'match_id') FROM jsonb_array_elements(assignments_value) item)
     OR (SELECT count(*)<>count(DISTINCT item->>'slot_id') FROM jsonb_array_elements(assignments_value) item) THEN RETURN false; END IF;
  FOR assignment IN SELECT item FROM jsonb_array_elements(assignments_value) item LOOP
    IF NOT phase4_json_exact_keys(assignment,ARRAY['match_id','division_id','area_id','interval_id','slot_id','start_epoch_ms','end_epoch_ms','fixed'])
       OR jsonb_typeof(assignment->'fixed')<>'boolean'
       OR NOT phase4_json_nonnegative_integer(assignment->'start_epoch_ms')
       OR NOT phase4_json_nonnegative_integer(assignment->'end_epoch_ms')
       OR (assignment->>'end_epoch_ms')::numeric<=(assignment->>'start_epoch_ms')::numeric THEN RETURN false; END IF;
    SELECT item INTO match_value FROM jsonb_array_elements(snapshot->'matches') item
      WHERE item->>'match_id'=assignment->>'match_id';
    IF match_value IS NULL OR match_value->>'division_id'<>assignment->>'division_id'
       OR (assignment->>'end_epoch_ms')::numeric-(assignment->>'start_epoch_ms')::numeric
         <>(match_value->>'duration_minutes')::numeric*60000
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot->'slots') slot
         WHERE slot->>'slot_id'=assignment->>'slot_id' AND slot->>'interval_id'=assignment->>'interval_id'
           AND slot->>'area_id'=assignment->>'area_id' AND slot->'start_epoch_ms'=assignment->'start_epoch_ms'
           AND slot->'end_epoch_ms'=assignment->'end_epoch_ms') THEN RETURN false; END IF;
    fixed_value:=match_value->'fixed_assignment';
    IF fixed_value IS NOT NULL AND (assignment->'fixed'<>'true'::jsonb OR assignment->>'area_id'<>fixed_value->>'area_id'
       OR assignment->>'slot_id'<>fixed_value->>'slot_id' OR assignment->'start_epoch_ms'<>fixed_value->'start_epoch_ms'
       OR assignment->'end_epoch_ms'<>fixed_value->'end_epoch_ms') THEN RETURN false;
    ELSIF fixed_value IS NULL AND assignment->'fixed'<>'false'::jsonb THEN RETURN false; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(assignments_value) a, jsonb_array_elements(assignments_value) b
    WHERE a->>'match_id'<b->>'match_id' AND a->>'area_id'=b->>'area_id'
      AND (a->>'start_epoch_ms')::numeric<(b->>'end_epoch_ms')::numeric
      AND (b->>'start_epoch_ms')::numeric<(a->>'end_epoch_ms')::numeric
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') dependent,
      jsonb_array_elements_text(dependent->'dependency_match_ids') source_id,
      jsonb_array_elements(assignments_value) dependent_assignment,
      jsonb_array_elements(assignments_value) source_assignment
    WHERE dependent_assignment->>'match_id'=dependent->>'match_id' AND source_assignment->>'match_id'=source_id
      AND (source_assignment->>'end_epoch_ms')::numeric>(dependent_assignment->>'start_epoch_ms')::numeric
  ) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') m1,jsonb_array_elements(snapshot->'matches') m2,
      jsonb_array_elements(assignments_value) a1,jsonb_array_elements(assignments_value) a2
    WHERE m1->>'match_id'<m2->>'match_id' AND a1->>'match_id'=m1->>'match_id' AND a2->>'match_id'=m2->>'match_id'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m1->'official_ids') o1
        JOIN jsonb_array_elements_text(m2->'official_ids') o2 ON o2=o1)
      AND (a1->>'start_epoch_ms')::numeric<(a2->>'end_epoch_ms')::numeric
      AND (a2->>'start_epoch_ms')::numeric<(a1->>'end_epoch_ms')::numeric
  ) THEN RETURN false; END IF;
  IF snapshot->'constraints'->'minimum_rest'->>'mode'='required' THEN
    required_rest:=GREATEST(required_rest,(snapshot->'constraints'->'minimum_rest'->'value'->>'minutes')::numeric);
  END IF;
  IF snapshot->'constraints'->'avoid_consecutive_matches'->>'mode'='required' THEN
    required_rest:=GREATEST(required_rest,(snapshot->'constraints'->'avoid_consecutive_matches'->'value'->>'minutes')::numeric);
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') m1,jsonb_array_elements(snapshot->'matches') m2,
      jsonb_array_elements(assignments_value) a1,jsonb_array_elements(assignments_value) a2
    WHERE m1->>'match_id'<m2->>'match_id' AND a1->>'match_id'=m1->>'match_id' AND a2->>'match_id'=m2->>'match_id'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m1->'possible_entry_ids') e1
        JOIN jsonb_array_elements_text(m2->'possible_entry_ids') e2 ON e2=e1)
      AND ((a1->>'start_epoch_ms')::numeric<(a2->>'end_epoch_ms')::numeric
        AND (a2->>'start_epoch_ms')::numeric<(a1->>'end_epoch_ms')::numeric
        OR GREATEST((a1->>'start_epoch_ms')::numeric,(a2->>'start_epoch_ms')::numeric)
          -LEAST((a1->>'end_epoch_ms')::numeric,(a2->>'end_epoch_ms')::numeric)<required_rest*60000)
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'entry_unavailable';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') match_item,jsonb_array_elements(assignments_value) assigned,
      jsonb_array_elements_text(match_item->'possible_entry_ids') entry_id,
      jsonb_array_elements(constraint_value->'value'->'by_entry_id'->entry_id) blocked
    WHERE assigned->>'match_id'=match_item->>'match_id'
      AND (assigned->>'start_epoch_ms')::numeric<(blocked->>'end_epoch_ms')::numeric
      AND (blocked->>'start_epoch_ms')::numeric<(assigned->>'end_epoch_ms')::numeric
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'official_availability';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') match_item,jsonb_array_elements(assignments_value) assigned,
      jsonb_array_elements_text(match_item->'official_ids') official_id
    WHERE assigned->>'match_id'=match_item->>'match_id' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(constraint_value->'value'->'by_official_id'->official_id) available
      WHERE (available->>'start_epoch_ms')::numeric<=(assigned->>'start_epoch_ms')::numeric
        AND (available->>'end_epoch_ms')::numeric>=(assigned->>'end_epoch_ms')::numeric)
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'featured_playing_area';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(constraint_value->'value'->'match_ids') featured,
      jsonb_array_elements(assignments_value) assigned
    WHERE assigned->>'match_id'=featured AND assigned->>'area_id'<>constraint_value->'value'->>'area_id'
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'preferred_final_time';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'matches') match_item,jsonb_array_elements(assignments_value) assigned
    WHERE assigned->>'match_id'=match_item->>'match_id' AND match_item->'is_championship_final'='true'::jsonb
      AND abs((assigned->>'start_epoch_ms')::numeric-(constraint_value->'value'->>'target_start_epoch_ms')::numeric)
        >(constraint_value->'value'->>'tolerance_minutes')::numeric*60000
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'preserve_existing_schedule';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_each(constraint_value->'value'->'by_match_id') preserved(match_id,original),
      jsonb_array_elements(assignments_value) assigned
    WHERE assigned->>'match_id'=preserved.match_id AND (assigned->>'area_id'<>preserved.original->>'area_id'
      OR abs((assigned->>'start_epoch_ms')::numeric-(preserved.original->>'start_epoch_ms')::numeric)
        >(constraint_value->'value'->>'maximum_shift_minutes')::numeric*60000)
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'maximum_matches_per_day';
  IF constraint_value->>'mode'='required' THEN
    required_max_per_day:=(constraint_value->'value'->>'matches')::integer;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(assignments_value) assigned
      JOIN jsonb_array_elements(snapshot->'matches') snapshot_match ON snapshot_match->>'match_id'=assigned->>'match_id'
      CROSS JOIN LATERAL jsonb_array_elements_text(snapshot_match->'possible_entry_ids') entry_id
      GROUP BY entry_id,to_char(to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'),'YYYY-MM-DD')
      HAVING count(*)>required_max_per_day
    ) THEN RETURN false; END IF;
  END IF;
  constraint_value:=snapshot->'constraints'->'keep_division_together';
  IF constraint_value->>'mode'='required' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(assignments_value) assigned
    GROUP BY assigned->>'division_id'
    HAVING count(DISTINCT assigned->>'area_id')>(constraint_value->'value'->>'maximum_area_count')::integer
  ) THEN RETURN false; END IF;
  constraint_value:=snapshot->'constraints'->'balance_early_matches';
  IF constraint_value->>'mode'='required' THEN
    threshold_minutes:=split_part(constraint_value->'value'->>'before_local_time',':',1)::integer*60
      +split_part(constraint_value->'value'->>'before_local_time',':',2)::integer;
    SELECT COALESCE(max(match_count)-min(match_count),0)::integer INTO balance_spread FROM (
      SELECT entry_id,count(assigned->>'match_id') FILTER (WHERE
        extract(hour FROM to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'))*60
        +extract(minute FROM to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'))<threshold_minutes) match_count
      FROM (SELECT DISTINCT entry_id FROM jsonb_array_elements(snapshot->'matches') source_match
        CROSS JOIN LATERAL jsonb_array_elements_text(source_match->'possible_entry_ids') entry_id) entries
      LEFT JOIN jsonb_array_elements(snapshot->'matches') source_match
        ON EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_match->'possible_entry_ids') possible WHERE possible=entries.entry_id)
      LEFT JOIN jsonb_array_elements(assignments_value) assigned ON assigned->>'match_id'=source_match->>'match_id'
      GROUP BY entry_id
    ) early_counts;
    IF balance_spread>1 THEN RETURN false; END IF;
  END IF;
  constraint_value:=snapshot->'constraints'->'balance_late_matches';
  IF constraint_value->>'mode'='required' THEN
    threshold_minutes:=split_part(constraint_value->'value'->>'at_or_after_local_time',':',1)::integer*60
      +split_part(constraint_value->'value'->>'at_or_after_local_time',':',2)::integer;
    SELECT COALESCE(max(match_count)-min(match_count),0)::integer INTO balance_spread FROM (
      SELECT entry_id,count(assigned->>'match_id') FILTER (WHERE
        extract(hour FROM to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'))*60
        +extract(minute FROM to_timestamp((assigned->>'start_epoch_ms')::double precision/1000) AT TIME ZONE (snapshot->>'time_zone'))>=threshold_minutes) match_count
      FROM (SELECT DISTINCT entry_id FROM jsonb_array_elements(snapshot->'matches') source_match
        CROSS JOIN LATERAL jsonb_array_elements_text(source_match->'possible_entry_ids') entry_id) entries
      LEFT JOIN jsonb_array_elements(snapshot->'matches') source_match
        ON EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_match->'possible_entry_ids') possible WHERE possible=entries.entry_id)
      LEFT JOIN jsonb_array_elements(assignments_value) assigned ON assigned->>'match_id'=source_match->>'match_id'
      GROUP BY entry_id
    ) late_counts;
    IF balance_spread>1 THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase4_schedule_preferred_violations_valid(value jsonb) RETURNS boolean AS $$
BEGIN
  RETURN jsonb_typeof(value)='array' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(value) violation
    WHERE NOT phase4_json_exact_keys(violation,CASE WHEN violation ? 'amount'
        THEN ARRAY['code','severity','match_ids','message','amount'] ELSE ARRAY['code','severity','match_ids','message'] END)
      OR violation->>'severity'<>'preferred' OR violation->>'code' NOT IN ('minimum_rest','maximum_matches_per_day',
        'entry_unavailable','official_unavailable','preferred_final_time','featured_playing_area','consecutive_matches',
        'early_match_balance','late_match_balance','division_area_spread','existing_schedule_moved')
      OR jsonb_typeof(violation->'match_ids')<>'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(violation->'match_ids') match_id WHERE match_id::uuid IS NULL)
      OR jsonb_typeof(violation->'message')<>'string' OR btrim(violation->>'message')=''
      OR (violation ? 'amount' AND (jsonb_typeof(violation->'amount')<>'number' OR (violation->>'amount')::numeric<0)));
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE schedule_generation_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES schedule_generation_jobs(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  result_revision integer NOT NULL CHECK (result_revision>0),
  solver_iteration integer NOT NULL CHECK (solver_iteration>=0),
  result_status text NOT NULL CHECK (result_status IN ('valid','infeasible')),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  problem_hash text NOT NULL CHECK (problem_hash ~ '^[0-9a-f]{64}$'),
  quality jsonb NOT NULL CHECK (phase4_schedule_quality_valid(quality,quality->>'objective')),
  assignments jsonb NOT NULL CHECK (jsonb_typeof(assignments)='array'),
  violations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(violations)='array'),
  assignment_hash text NOT NULL CHECK (assignment_hash ~ '^[0-9a-f]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,result_revision),
  UNIQUE(job_id,assignment_hash),
  UNIQUE(id,job_id),
  FOREIGN KEY(job_id,organisation_id) REFERENCES schedule_generation_jobs(id,organisation_id) ON DELETE CASCADE,
  FOREIGN KEY(job_id,competition_id) REFERENCES schedule_generation_jobs(id,competition_id) ON DELETE CASCADE,
  CHECK (assignment_hash=phase4_sha256_json(assignments)),
  CHECK (result_hash=phase4_sha256_json(jsonb_build_object('input_hash',input_hash,'problem_hash',problem_hash,
    'quality',quality,'assignments',assignments,'violations',violations)))
);

CREATE FUNCTION phase4_guard_schedule_option_dml() RETURNS trigger AS $$
DECLARE target schedule_generation_jobs%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' OR current_setting('matchday.phase4_schedule_checkpoint',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'schedule options may only be written by the checkpoint routine';
  END IF;
  SELECT * INTO target FROM schedule_generation_jobs WHERE id=NEW.job_id;
  IF target.id IS NULL OR NEW.organisation_id<>target.organisation_id OR NEW.competition_id<>target.competition_id
     OR NEW.input_hash<>target.input_hash OR NEW.problem_hash<>target.problem_hash
     OR NOT phase4_schedule_quality_valid(NEW.quality,target.objective)
     OR (NEW.quality->>'required_violation_count')::numeric<>0 OR NOT phase4_schedule_preferred_violations_valid(NEW.violations)
     OR NOT phase4_schedule_assignments_valid(target.input_snapshot,NEW.assignments) THEN
    RAISE EXCEPTION 'schedule option provenance is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER schedule_generation_options_phase4_dml_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_generation_options
FOR EACH ROW EXECUTE FUNCTION phase4_guard_schedule_option_dml();
ALTER TABLE schedule_generation_jobs ADD CONSTRAINT schedule_generation_jobs_best_fk
  FOREIGN KEY(current_best_option_id,id) REFERENCES schedule_generation_options(id,job_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX schedule_generation_options_job_quality_idx ON schedule_generation_options(job_id,((quality->>'score')::numeric) DESC,result_revision);

ALTER TABLE schedule_revisions
  ADD CONSTRAINT schedule_revisions_source_job_fk FOREIGN KEY(source_job_id,competition_id)
    REFERENCES schedule_generation_jobs(id,competition_id) ON DELETE RESTRICT,
  ADD CONSTRAINT schedule_revisions_source_option_fk FOREIGN KEY(source_option_id,source_job_id)
    REFERENCES schedule_generation_options(id,job_id) ON DELETE RESTRICT,
  ADD CONSTRAINT schedule_revisions_source_pair_check CHECK (
    (source_job_id IS NULL AND source_option_id IS NULL) OR (source_job_id IS NOT NULL AND source_option_id IS NOT NULL));
CREATE UNIQUE INDEX schedule_revisions_source_option_unique ON schedule_revisions(source_option_id) WHERE source_option_id IS NOT NULL;

CREATE TABLE schedule_assignment_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  source_schedule_revision_id uuid REFERENCES schedule_revisions(id) ON DELETE RESTRICT,
  playing_area_id uuid NOT NULL REFERENCES playing_areas(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at>starts_at),
  locked_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(competition_id,match_id),
  FOREIGN KEY(competition_id,organisation_id) REFERENCES competitions(id,organisation_id),
  FOREIGN KEY(match_id,competition_id) REFERENCES matches(id,competition_id),
  FOREIGN KEY(playing_area_id,competition_id) REFERENCES playing_areas(id,competition_id)
);
CREATE INDEX schedule_assignment_locks_tenant_idx ON schedule_assignment_locks(organisation_id,competition_id);

CREATE FUNCTION phase4_guard_schedule_assignment_lock_dml() RETURNS trigger AS $$
BEGIN
  IF current_setting('matchday.phase4_schedule_lock',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'schedule assignment locks may only be changed by the server-owned lock routine';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER aa_schedule_assignment_locks_phase4_dml_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_assignment_locks
FOR EACH ROW EXECUTE FUNCTION phase4_guard_schedule_assignment_lock_dml();

CREATE FUNCTION phase4_set_schedule_assignment_lock(target_competition uuid,target_match uuid,target_revision uuid,
  target_area uuid,start_value timestamptz,end_value timestamptz,actor uuid,request_id_value text)
RETURNS schedule_assignment_locks AS $$
DECLARE lock_row schedule_assignment_locks%ROWTYPE; target_org uuid;
BEGIN
  PERFORM phase3_assert_competition_mutable(target_competition);
  SELECT organisation_id INTO target_org FROM competitions WHERE id=target_competition;
  IF end_value<=start_value OR NOT EXISTS (SELECT 1 FROM matches WHERE id=target_match AND competition_id=target_competition)
     OR NOT EXISTS (SELECT 1 FROM playing_areas WHERE id=target_area AND competition_id=target_competition)
     OR (target_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM schedule_revisions
       WHERE id=target_revision AND competition_id=target_competition AND status IN ('draft','ready_for_review'))) THEN
    RAISE EXCEPTION 'schedule assignment lock provenance is invalid';
  END IF;
  PERFORM set_config('matchday.phase4_schedule_lock','on',true);
  INSERT INTO schedule_assignment_locks(competition_id,organisation_id,match_id,source_schedule_revision_id,playing_area_id,starts_at,ends_at,locked_by)
  VALUES(target_competition,target_org,target_match,target_revision,target_area,start_value,end_value,actor)
  ON CONFLICT(competition_id,match_id) DO UPDATE SET source_schedule_revision_id=excluded.source_schedule_revision_id,
    playing_area_id=excluded.playing_area_id,starts_at=excluded.starts_at,ends_at=excluded.ends_at,locked_by=excluded.locked_by,created_at=now()
  RETURNING * INTO lock_row;
  PERFORM set_config('matchday.phase4_schedule_lock','off',true);
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(request_id_value,actor,'account',target_org,'schedule.assignment.locked','match',target_match::text,
    jsonb_build_object('area_id',target_area,'starts_at',start_value,'ends_at',end_value));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('match',target_match::text,'schedule.assignment.locked',jsonb_build_object('competition_id',target_competition),
    'phase4:schedule-lock:'||target_match::text||':'||extract(epoch FROM start_value)::bigint::text)
  ON CONFLICT(idempotency_key) DO NOTHING;
  RETURN lock_row;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE schedule_revision_warnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_revision_id uuid NOT NULL REFERENCES schedule_revisions(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  warning_days smallint NOT NULL CHECK (warning_days IN (7,1)),
  expires_at timestamptz NOT NULL,
  notified_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
  emitted_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE,
  UNIQUE(schedule_revision_id,warning_days,notified_account_id),
  FOREIGN KEY(schedule_revision_id,competition_id) REFERENCES schedule_revisions(id,competition_id) ON DELETE CASCADE
);
CREATE INDEX schedule_revision_warnings_due_idx ON schedule_revision_warnings(expires_at,warning_days);

CREATE FUNCTION phase4_schedule_assignment_hash(target_revision uuid) RETURNS text AS $$
DECLARE value text;
BEGIN
  SELECT string_agg(concat_ws(':',match_id::text,playing_area_id::text,starts_at::text,ends_at::text),',' ORDER BY match_id)
  INTO value FROM scheduled_matches WHERE schedule_revision_id=target_revision;
  RETURN encode(pg_catalog.sha256(convert_to(COALESCE(value,''),'UTF8')),'hex');
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase4_schedule_expiry(base_time timestamptz) RETURNS timestamptz AS $$
  SELECT base_time + interval '30 days'
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE FUNCTION phase4_guard_schedule_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.editable_until:=CASE WHEN NEW.status='published' THEN NULL ELSE phase4_schedule_expiry(NEW.updated_at) END;
    IF NEW.status='expired' OR NEW.expired_at IS NOT NULL THEN RAISE EXCEPTION 'schedule revisions cannot be inserted expired'; END IF;
  ELSE
    IF OLD.status IN ('published','superseded','expired') AND NOT (OLD.status='published' AND NEW.status='superseded'
      AND ((OLD.source_job_id IS NULL AND OLD.source_option_id IS NULL)
        OR current_setting('matchday.phase4_publish_schedule',true) IS NOT DISTINCT FROM 'on')) THEN
      RAISE EXCEPTION 'terminal schedule revisions are immutable';
    END IF;
    IF NEW.id<>OLD.id OR NEW.competition_id<>OLD.competition_id OR NEW.revision<>OLD.revision
       OR NEW.format_revision_id<>OLD.format_revision_id OR NEW.input_hash<>OLD.input_hash
       OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
       OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
       OR NEW.source_job_id IS DISTINCT FROM OLD.source_job_id OR NEW.source_option_id IS DISTINCT FROM OLD.source_option_id
       OR (NEW.assignment_hash IS DISTINCT FROM OLD.assignment_hash AND NOT (OLD.assignment_hash IS NULL
         AND current_setting('matchday.phase4_accept_schedule',true) IS NOT DISTINCT FROM 'on'))
       OR NEW.quality IS DISTINCT FROM OLD.quality
       OR (OLD.status IN ('published','superseded','expired') AND (NEW.warnings IS DISTINCT FROM OLD.warnings
         OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.expired_at IS DISTINCT FROM OLD.expired_at
         OR NEW.editable_until IS DISTINCT FROM OLD.editable_until)) THEN
      RAISE EXCEPTION 'schedule revision provenance is immutable';
    END IF;
    IF NEW.status='expired' THEN
      IF now()<OLD.editable_until OR NEW.expired_at IS NULL THEN RAISE EXCEPTION 'schedule revision cannot expire before 30 days'; END IF;
    ELSIF NEW.status='published' THEN
      IF (OLD.source_job_id IS NOT NULL OR OLD.source_option_id IS NOT NULL) AND (OLD.status<>'ready_for_review'
         OR current_setting('matchday.phase4_publish_schedule',true) IS DISTINCT FROM 'on'
         OR OLD.assignment_hash IS NULL OR OLD.assignment_hash<>phase4_schedule_assignment_hash(OLD.id)) THEN
        RAISE EXCEPTION 'Phase 4 schedule revisions may only be published by the server-owned publication routine';
      END IF;
      NEW.editable_until:=NULL;
    ELSIF NEW.status='superseded' THEN
      IF OLD.status<>'published' OR NOT ((OLD.source_job_id IS NULL AND OLD.source_option_id IS NULL)
        OR current_setting('matchday.phase4_publish_schedule',true) IS NOT DISTINCT FROM 'on') THEN
        RAISE EXCEPTION 'only the schedule publication routine may supersede a published revision';
      END IF;
      NEW.superseded_at:=now();
    ELSIF NEW.status='ready_for_review' THEN
      IF NEW.assignment_hash IS NULL OR NEW.assignment_hash<>phase4_schedule_assignment_hash(NEW.id) THEN
        RAISE EXCEPTION 'ready schedule revision requires a database-verified assignment hash';
      END IF;
    ELSIF NEW.updated_at>OLD.updated_at THEN
      NEW.editable_until:=phase4_schedule_expiry(NEW.updated_at);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_accept_schedule_option(target_option uuid,actor uuid,request_id_value text)
RETURNS schedule_revisions AS $$
DECLARE option_row schedule_generation_options%ROWTYPE; job schedule_generation_jobs%ROWTYPE;
DECLARE revision_row schedule_revisions%ROWTYPE; assignment jsonb; next_revision integer;
BEGIN
  SELECT * INTO option_row FROM schedule_generation_options WHERE id=target_option FOR UPDATE;
  IF option_row.id IS NULL OR option_row.result_status<>'valid' THEN RAISE EXCEPTION 'only a valid generated option can be accepted'; END IF;
  SELECT * INTO job FROM schedule_generation_jobs WHERE id=option_row.job_id FOR UPDATE;
  IF job.id IS NULL OR job.current_best_option_id<>option_row.id OR job.status NOT IN ('valid_best_found','completed') THEN
    RAISE EXCEPTION 'schedule option is not the current accepted candidate';
  END IF;
  IF (option_row.quality->>'required_violation_count')::numeric<>0 OR NOT phase4_schedule_preferred_violations_valid(option_row.violations)
     OR NOT phase4_schedule_assignments_valid(job.input_snapshot,option_row.assignments) THEN
    RAISE EXCEPTION 'schedule option no longer satisfies the authoritative job snapshot';
  END IF;
  IF EXISTS (SELECT 1 FROM schedule_revisions WHERE source_option_id=option_row.id) THEN
    SELECT * INTO revision_row FROM schedule_revisions WHERE source_option_id=option_row.id; RETURN revision_row;
  END IF;
  SELECT COALESCE(max(revision),0)+1 INTO next_revision FROM schedule_revisions WHERE competition_id=job.competition_id;
  INSERT INTO schedule_revisions(competition_id,format_revision_id,revision,input_hash,status,created_by,source_job_id,source_option_id,quality)
  VALUES(job.competition_id,(SELECT match_row.format_revision_id FROM matches match_row
    WHERE match_row.id IN (SELECT (item->>'match_id')::uuid FROM jsonb_array_elements(option_row.assignments) item) LIMIT 1),
    next_revision,job.input_hash,'draft',actor,job.id,option_row.id,option_row.quality)
  RETURNING * INTO revision_row;
  INSERT INTO schedule_revision_formats(schedule_revision_id,competition_id,division_id,format_revision_id)
  SELECT DISTINCT revision_row.id,job.competition_id,match_row.division_id,match_row.format_revision_id
  FROM matches match_row WHERE match_row.id IN (SELECT (item->>'match_id')::uuid FROM jsonb_array_elements(option_row.assignments) item);
  FOR assignment IN SELECT item FROM jsonb_array_elements(option_row.assignments) item LOOP
    IF NOT phase4_json_exact_keys(assignment,ARRAY['match_id','division_id','area_id','interval_id','slot_id','start_epoch_ms','end_epoch_ms','fixed'])
       OR NOT phase4_json_nonnegative_integer(assignment->'start_epoch_ms') OR NOT phase4_json_nonnegative_integer(assignment->'end_epoch_ms')
       OR (assignment->>'end_epoch_ms')::numeric<=(assignment->>'start_epoch_ms')::numeric
       OR NOT EXISTS (SELECT 1 FROM matches target WHERE target.id=(assignment->>'match_id')::uuid
         AND target.competition_id=job.competition_id AND target.division_id=(assignment->>'division_id')::uuid)
       OR NOT EXISTS (SELECT 1 FROM playing_areas area WHERE area.id=(assignment->>'area_id')::uuid AND area.competition_id=job.competition_id) THEN
      RAISE EXCEPTION 'generated schedule assignment provenance is invalid';
    END IF;
    INSERT INTO scheduled_matches(schedule_revision_id,match_id,competition_id,playing_area_id,starts_at,ends_at)
    VALUES(revision_row.id,(assignment->>'match_id')::uuid,job.competition_id,(assignment->>'area_id')::uuid,
      to_timestamp((assignment->>'start_epoch_ms')::double precision/1000),to_timestamp((assignment->>'end_epoch_ms')::double precision/1000));
  END LOOP;
  PERFORM set_config('matchday.phase4_accept_schedule','on',true);
  UPDATE schedule_revisions SET assignment_hash=phase4_schedule_assignment_hash(revision_row.id),status='ready_for_review',updated_at=now()
  WHERE id=revision_row.id RETURNING * INTO revision_row;
  PERFORM set_config('matchday.phase4_accept_schedule','off',true);
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id)
  VALUES(request_id_value,actor,'account',job.organisation_id,'schedule.option.accepted','schedule_revision',revision_row.id::text);
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('schedule_revision',revision_row.id::text,'schedule.option.accepted',jsonb_build_object('option_id',option_row.id),
    'phase4:schedule-option-accepted:'||option_row.id::text);
  RETURN revision_row;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_published_schedule_assignment() RETURNS trigger AS $$
DECLARE revision_id uuid; revision_status text;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM competitions WHERE id=OLD.competition_id) THEN RETURN OLD; END IF;
  revision_id:=CASE WHEN TG_OP='DELETE' THEN OLD.schedule_revision_id ELSE NEW.schedule_revision_id END;
  SELECT status INTO revision_status FROM schedule_revisions WHERE id=revision_id;
  IF revision_status='published' THEN
    RAISE EXCEPTION 'published schedule assignments are immutable';
  ELSIF revision_status IN ('ready_for_review','superseded','expired') THEN
    RAISE EXCEPTION 'accepted or terminal schedule assignments are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER schedule_revisions_immutable ON schedule_revisions;
CREATE TRIGGER schedule_revisions_phase4_guard BEFORE INSERT OR UPDATE ON schedule_revisions
FOR EACH ROW EXECUTE FUNCTION phase4_guard_schedule_revision();
CREATE TRIGGER schedule_revisions_phase4_immutable_delete BEFORE DELETE ON schedule_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_aggregate_history_mutation('schedule revisions are immutable and append-only');

CREATE FUNCTION phase4_claim_schedule_job(target_job uuid, worker text, expected_input_hash text, lease_seconds integer DEFAULT 30)
RETURNS schedule_generation_jobs AS $$
DECLARE claimed schedule_generation_jobs%ROWTYPE;
BEGIN
  IF btrim(worker)='' OR expected_input_hash !~ '^[0-9a-f]{64}$' OR lease_seconds NOT BETWEEN 5 AND 300 THEN RAISE EXCEPTION 'invalid worker lease'; END IF;
  SELECT * INTO claimed FROM schedule_generation_jobs WHERE id=target_job AND input_hash=expected_input_hash
    AND (status='queued' OR (status IN ('running','valid_best_found','cancelling') AND lease_expires_at<=now()))
    FOR UPDATE SKIP LOCKED;
  IF claimed.id IS NULL THEN RETURN NULL; END IF;
  PERFORM phase3_assert_competition_mutable(claimed.competition_id);
  UPDATE schedule_generation_jobs SET status=CASE WHEN status='cancelling' THEN 'cancelling' ELSE 'running' END,
    worker_id=worker,fence_token=gen_random_uuid(),lease_generation=lease_generation+1,
    lease_expires_at=now()+make_interval(secs=>lease_seconds),
    started_at=COALESCE(started_at,now()),updated_at=now(),revision=revision+1 WHERE id=claimed.id RETURNING * INTO claimed;
  RETURN claimed;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_renew_schedule_job_lease(target_job uuid, worker text, fence uuid, lease_seconds integer DEFAULT 30)
RETURNS schedule_generation_jobs AS $$
DECLARE renewed schedule_generation_jobs%ROWTYPE;
BEGIN
  IF lease_seconds NOT BETWEEN 5 AND 300 THEN RAISE EXCEPTION 'invalid worker lease'; END IF;
  UPDATE schedule_generation_jobs SET lease_expires_at=now()+make_interval(secs=>lease_seconds),updated_at=now()
  WHERE id=target_job AND worker_id=worker AND fence_token=fence AND lease_expires_at>now()
    AND status IN ('running','valid_best_found','cancelling') RETURNING * INTO renewed;
  IF renewed.id IS NULL THEN RAISE EXCEPTION 'schedule lease fence was lost'; END IF;
  RETURN renewed;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_is_schedule_job_cancel_requested(target_job uuid, fence uuid) RETURNS boolean AS $$
  SELECT COALESCE((SELECT status='cancelling' OR cancellation_requested_at IS NOT NULL
    FROM schedule_generation_jobs WHERE id=target_job AND fence_token=fence),true)
$$ LANGUAGE sql STABLE;

CREATE FUNCTION phase4_checkpoint_schedule_option(target_job uuid, worker text, fence uuid, expected_job_revision integer,
  expected_input_hash text,solver_iteration_value integer,option_quality jsonb, option_assignments jsonb,
  option_violations jsonb) RETURNS schedule_generation_options AS $$
DECLARE target schedule_generation_jobs%ROWTYPE; option_row schedule_generation_options%ROWTYPE; next_revision integer;
DECLARE current_quality jsonb; current_hash text; candidate_hash text;
BEGIN
  SELECT * INTO target FROM schedule_generation_jobs WHERE id=target_job FOR UPDATE;
  IF target.id IS NOT NULL AND target.worker_id=worker AND target.fence_token=fence
     AND (target.status='cancelling' OR target.cancellation_requested_at IS NOT NULL) THEN
    RAISE EXCEPTION 'schedule checkpoint cancelled';
  END IF;
  IF target.id IS NULL OR target.worker_id<>worker OR target.fence_token<>fence OR target.revision<>expected_job_revision
     OR target.input_hash<>expected_input_hash
     OR target.status NOT IN ('running','valid_best_found') OR target.lease_expires_at<=now() THEN
    RAISE EXCEPTION 'schedule checkpoint lost its worker fence';
  END IF;
  IF solver_iteration_value<0 OR NOT phase4_schedule_quality_valid(option_quality,target.objective)
     OR jsonb_typeof(option_assignments)<>'array' OR jsonb_typeof(option_violations)<>'array' THEN RAISE EXCEPTION 'invalid schedule checkpoint'; END IF;
  candidate_hash:=phase4_sha256_json(option_assignments);
  IF target.current_best_option_id IS NOT NULL THEN
    SELECT quality,assignment_hash INTO current_quality,current_hash FROM schedule_generation_options WHERE id=target.current_best_option_id;
    IF NOT phase4_schedule_quality_better(option_quality,current_quality,target.objective,candidate_hash,current_hash) THEN
      RAISE EXCEPTION 'schedule checkpoint must improve current best';
    END IF;
  END IF;
  IF (option_quality->>'required_violation_count')::numeric<>0 OR NOT phase4_schedule_preferred_violations_valid(option_violations)
     OR NOT phase4_schedule_assignments_valid(target.input_snapshot,option_assignments) THEN
    RAISE EXCEPTION 'invalid schedule checkpoint';
  END IF;
  SELECT COALESCE(max(result_revision),0)+1 INTO next_revision FROM schedule_generation_options WHERE job_id=target_job;
  PERFORM set_config('matchday.phase4_schedule_checkpoint','on',true);
  INSERT INTO schedule_generation_options(job_id,organisation_id,competition_id,result_revision,solver_iteration,result_status,input_hash,problem_hash,quality,assignments,violations,assignment_hash,result_hash)
  VALUES(target_job,target.organisation_id,target.competition_id,next_revision,solver_iteration_value,'valid',target.input_hash,target.problem_hash,
    option_quality,option_assignments,option_violations,candidate_hash,phase4_sha256_json(jsonb_build_object('input_hash',target.input_hash,
      'problem_hash',target.problem_hash,'quality',option_quality,'assignments',option_assignments,'violations',option_violations)))
  RETURNING * INTO option_row;
  PERFORM set_config('matchday.phase4_schedule_checkpoint','off',true);
  UPDATE schedule_generation_jobs SET current_best_option_id=option_row.id,status='valid_best_found',revision=revision+1,updated_at=now()
  WHERE id=target_job;
  RETURN option_row;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_release_schedule_job_after_failure(target_job uuid, worker text, fence uuid,
  failure_class_value text) RETURNS schedule_generation_jobs AS $$
DECLARE target schedule_generation_jobs%ROWTYPE;
BEGIN
  IF failure_class_value NOT IN ('timeout','transient') THEN RAISE EXCEPTION 'only retryable failures may release a schedule job'; END IF;
  SELECT * INTO target FROM schedule_generation_jobs WHERE id=target_job FOR UPDATE;
  IF target.id IS NULL OR target.worker_id<>worker OR target.fence_token<>fence OR target.lease_expires_at<=now()
     OR target.status NOT IN ('running','valid_best_found','cancelling') THEN RAISE EXCEPTION 'schedule release lost its worker fence'; END IF;
  IF target.status='cancelling' THEN
    UPDATE schedule_generation_jobs SET status='cancelled',completed_at=now(),worker_id=NULL,fence_token=NULL,lease_expires_at=NULL,
      updated_at=now(),revision=revision+1 WHERE id=target_job RETURNING * INTO target;
    RETURN target;
  END IF;
  UPDATE schedule_generation_jobs SET status='queued',worker_id=NULL,fence_token=NULL,lease_expires_at=NULL,
    updated_at=now(),revision=revision+1 WHERE id=target_job RETURNING * INTO target;
  RETURN target;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_mark_schedule_job_dead_lettered(target_job uuid,failure_class_value text)
RETURNS schedule_generation_jobs AS $$
DECLARE target schedule_generation_jobs%ROWTYPE;
BEGIN
  IF failure_class_value NOT IN ('invalid_input','timeout','transient','permanent') THEN RAISE EXCEPTION 'invalid dead-letter failure class'; END IF;
  SELECT * INTO target FROM schedule_generation_jobs WHERE id=target_job FOR UPDATE;
  IF target.id IS NULL OR target.status<>'queued' THEN RAISE EXCEPTION 'only a queued schedule job can be dead-lettered'; END IF;
  UPDATE schedule_generation_jobs SET status='failed',failure_class=failure_class_value,completed_at=now(),updated_at=now(),revision=revision+1
  WHERE id=target_job RETURNING * INTO target;
  RETURN target;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_finish_schedule_job(target_job uuid, worker text, fence uuid, final_status text,
  failure_class_value text DEFAULT NULL) RETURNS schedule_generation_jobs AS $$
DECLARE target schedule_generation_jobs%ROWTYPE;
BEGIN
  IF final_status NOT IN ('cancelled','completed','failed','no_solution','stale') THEN RAISE EXCEPTION 'invalid terminal job status'; END IF;
  SELECT * INTO target FROM schedule_generation_jobs WHERE id=target_job FOR UPDATE;
  IF target.id IS NULL OR target.worker_id<>worker OR target.fence_token<>fence OR target.lease_expires_at<=now()
     OR target.status NOT IN ('running','valid_best_found','cancelling') THEN RAISE EXCEPTION 'schedule finish lost its worker fence'; END IF;
  IF final_status='completed' AND target.current_best_option_id IS NULL THEN RAISE EXCEPTION 'completed job requires a valid best result'; END IF;
  UPDATE schedule_generation_jobs SET status=final_status,completed_at=now(),updated_at=now(),revision=revision+1,
    worker_id=NULL,fence_token=NULL,lease_expires_at=NULL,
    failure_class=CASE WHEN final_status='failed' THEN failure_class_value ELSE NULL END
  WHERE id=target_job RETURNING * INTO target;
  RETURN target;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_request_schedule_cancellation(target_job uuid, actor uuid, request_id_value text)
RETURNS schedule_generation_jobs AS $$
DECLARE target schedule_generation_jobs%ROWTYPE;
BEGIN
  SELECT * INTO target FROM schedule_generation_jobs WHERE id=target_job FOR UPDATE;
  IF target.id IS NULL THEN RAISE EXCEPTION 'schedule job does not exist'; END IF;
  IF target.status IN ('cancelled','completed','failed','no_solution','stale') THEN RETURN target; END IF;
  IF target.status='queued' THEN
    UPDATE schedule_generation_jobs SET status='cancelled',cancellation_requested_at=now(),completed_at=now(),updated_at=now(),revision=revision+1
    WHERE id=target_job RETURNING * INTO target;
  ELSIF target.status<>'cancelling' THEN
    UPDATE schedule_generation_jobs SET status='cancelling',cancellation_requested_at=now(),updated_at=now(),revision=revision+1
    WHERE id=target_job RETURNING * INTO target;
  END IF;
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id)
  VALUES(request_id_value,actor,'account',target.organisation_id,'schedule.job.cancel_requested','schedule_generation_job',target.id::text)
  ON CONFLICT DO NOTHING;
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('schedule_generation_job',target.id::text,'schedule.job.cancel_requested','{}','phase4:schedule-cancel:'||target.id::text)
  ON CONFLICT(idempotency_key) DO NOTHING;
  RETURN target;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_emit_schedule_expiry_warning(target_revision uuid,days_remaining integer,
  target_account uuid,request_id_value text) RETURNS schedule_revision_warnings AS $$
DECLARE revision_row schedule_revisions%ROWTYPE; warning_row schedule_revision_warnings%ROWTYPE; target_org uuid; notification_value uuid:=gen_random_uuid();
BEGIN
  IF days_remaining NOT IN (7,1) THEN RAISE EXCEPTION 'schedule warning must be seven or one day'; END IF;
  SELECT * INTO revision_row FROM schedule_revisions WHERE id=target_revision FOR UPDATE;
  IF revision_row.id IS NULL OR revision_row.status NOT IN ('draft','ready_for_review') OR revision_row.editable_until IS NULL
     OR current_date<>(revision_row.editable_until AT TIME ZONE 'UTC')::date-days_remaining THEN
    RAISE EXCEPTION 'schedule revision is not due for this expiry warning';
  END IF;
  SELECT organisation_id INTO target_org FROM competitions WHERE id=revision_row.competition_id;
  SELECT * INTO warning_row FROM schedule_revision_warnings WHERE schedule_revision_id=revision_row.id
    AND warning_days=days_remaining AND notified_account_id=target_account;
  IF warning_row.id IS NOT NULL THEN RETURN warning_row; END IF;
  INSERT INTO notifications(id,account_id,type,payload,idempotency_key)
  VALUES(notification_value,target_account,'schedule_draft_expiry',jsonb_build_object('competition_id',revision_row.competition_id,
    'schedule_revision_id',revision_row.id,'days_remaining',days_remaining,'expires_at',revision_row.editable_until),
    'phase4:schedule-expiry-warning:'||revision_row.id::text||':'||days_remaining||':'||target_account::text);
  INSERT INTO schedule_revision_warnings(schedule_revision_id,competition_id,warning_days,expires_at,notified_account_id,notification_id,idempotency_key)
  VALUES(revision_row.id,revision_row.competition_id,days_remaining,revision_row.editable_until,target_account,notification_value,
    'phase4:schedule-expiry-warning:'||revision_row.id::text||':'||days_remaining||':'||target_account::text)
  RETURNING * INTO warning_row;
  INSERT INTO audit_events(request_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(request_id_value,'system',target_org,'schedule.expiry_warning_emitted','schedule_revision',revision_row.id::text,
    jsonb_build_object('days_remaining',days_remaining,'account_id',target_account));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('schedule_revision',revision_row.id::text,'schedule.expiry_warning',jsonb_build_object('days_remaining',days_remaining,'account_id',target_account),warning_row.idempotency_key);
  RETURN warning_row;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_expire_schedule_revision(target_revision uuid,request_id_value text)
RETURNS schedule_revisions AS $$
DECLARE revision_row schedule_revisions%ROWTYPE; target_org uuid;
BEGIN
  SELECT * INTO revision_row FROM schedule_revisions WHERE id=target_revision FOR UPDATE;
  IF revision_row.id IS NULL THEN RAISE EXCEPTION 'schedule revision does not exist'; END IF;
  IF revision_row.status='expired' THEN RETURN revision_row; END IF;
  IF revision_row.status NOT IN ('draft','ready_for_review') OR revision_row.editable_until IS NULL OR now()<revision_row.editable_until THEN
    RAISE EXCEPTION 'schedule revision is not eligible for expiry';
  END IF;
  UPDATE schedule_revisions SET status='expired',expired_at=now() WHERE id=target_revision RETURNING * INTO revision_row;
  SELECT organisation_id INTO target_org FROM competitions WHERE id=revision_row.competition_id;
  INSERT INTO audit_events(request_id,actor_type,organisation_id,action,target_type,target_id)
  VALUES(request_id_value,'system',target_org,'schedule.expired','schedule_revision',revision_row.id::text);
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('schedule_revision',revision_row.id::text,'schedule.expired',jsonb_build_object('competition_id',revision_row.competition_id),
    'phase4:schedule-expired:'||revision_row.id::text);
  RETURN revision_row;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_publish_schedule_revision(target_revision uuid,actor uuid,request_id_value text)
RETURNS schedule_revisions AS $$
DECLARE candidate schedule_revisions%ROWTYPE; previous_id uuid; target_org uuid;
BEGIN
  SELECT * INTO candidate FROM schedule_revisions WHERE id=target_revision FOR UPDATE;
  IF candidate.id IS NULL OR candidate.status<>'ready_for_review' OR candidate.assignment_hash IS NULL
     OR candidate.assignment_hash<>phase4_schedule_assignment_hash(candidate.id) THEN
    RAISE EXCEPTION 'schedule publication requires an accepted immutable revision';
  END IF;
  PERFORM 1 FROM competitions WHERE id=candidate.competition_id FOR UPDATE;
  SELECT organisation_id INTO target_org FROM competitions WHERE id=candidate.competition_id;
  SELECT id INTO previous_id FROM schedule_revisions WHERE competition_id=candidate.competition_id AND status='published' FOR UPDATE;
  PERFORM set_config('matchday.phase4_publish_schedule','on',true);
  IF previous_id IS NOT NULL THEN
    UPDATE schedule_revisions SET status='superseded',superseded_at=now(),updated_at=now() WHERE id=previous_id;
  END IF;
  UPDATE schedule_revisions SET status='published',published_at=now(),updated_at=now() WHERE id=target_revision RETURNING * INTO candidate;
  PERFORM set_config('matchday.phase4_publish_schedule','off',true);
  INSERT INTO competition_publications(competition_id,published_schedule_revision_id,schedule_version,schedule_published_at,updated_at)
  VALUES(candidate.competition_id,candidate.id,1,now(),now())
  ON CONFLICT(competition_id) DO UPDATE SET published_schedule_revision_id=excluded.published_schedule_revision_id,
    schedule_version=competition_publications.schedule_version+1,schedule_published_at=excluded.schedule_published_at,updated_at=now();
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(request_id_value,actor,'account',target_org,'schedule.published','schedule_revision',candidate.id::text,
    jsonb_build_object('superseded_revision_id',previous_id));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('schedule_revision',candidate.id::text,'schedule.published',jsonb_build_object('competition_id',candidate.competition_id),
    'phase4:schedule-published:'||candidate.id::text);
  RETURN candidate;
END;
$$ LANGUAGE plpgsql;

-- AI action accounting/cache/audit ------------------------------------------

CREATE TABLE ai_usage_allowances (
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('text_to_brief','format_recommendations')),
  period_start date NOT NULL,
  action_limit integer NOT NULL CHECK (action_limit>=0),
  used_units integer NOT NULL DEFAULT 0 CHECK (used_units>=0 AND used_units<=action_limit),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organisation_id,actor_account_id,action,period_start)
);
CREATE INDEX ai_usage_allowances_account_idx ON ai_usage_allowances(actor_account_id,period_start DESC);

CREATE TABLE ai_action_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  competition_id uuid REFERENCES competitions(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('text_to_brief','format_recommendations')),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  correlation_id text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,200}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL CHECK (schema_version='1.0'),
  input_character_count integer NOT NULL CHECK (input_character_count BETWEEN 0 AND 100000),
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','success','failed','manual_fallback')),
  cache_status text NOT NULL DEFAULT 'not_checked' CHECK (cache_status IN ('hit','miss','not_checked')),
  validated boolean NOT NULL DEFAULT false,
  charged_units smallint NOT NULL DEFAULT 0 CHECK (charged_units IN (0,1)),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts>=0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms>=0),
  failure_code text CHECK (failure_code IS NULL OR failure_code IN ('aborted','invalid_input','invalid_response','provider_authentication','provider_rate_limited','provider_unavailable','timeout','unknown')),
  provider_request_id text CHECK (provider_request_id IS NULL OR provider_request_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata)<=8192 AND phase4_json_object_without_forbidden_keys(metadata)),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(organisation_id,idempotency_key),
  UNIQUE(id,organisation_id),
  UNIQUE(id,organisation_id,action,request_fingerprint,schema_version),
  CHECK ((outcome='pending' AND completed_at IS NULL AND charged_units=0)
      OR (outcome<>'pending' AND completed_at IS NOT NULL)),
  CHECK (charged_units=0 OR (outcome='success' AND cache_status='miss' AND validated)),
  CHECK ((outcome='failed' AND failure_code IS NOT NULL) OR outcome<>'failed')
);
CREATE INDEX ai_action_ledger_tenant_time_idx ON ai_action_ledger(organisation_id,actor_account_id,created_at DESC);
CREATE INDEX ai_action_ledger_fingerprint_idx ON ai_action_ledger(organisation_id,action,request_fingerprint,schema_version);

CREATE TABLE ai_response_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('text_to_brief','format_recommendations')),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL CHECK (schema_version='1.0'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  validated boolean NOT NULL CHECK (validated),
  created_from_ledger_id uuid NOT NULL REFERENCES ai_action_ledger(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
  UNIQUE(organisation_id,action,request_fingerprint,schema_version),
  FOREIGN KEY(created_from_ledger_id,organisation_id,action,request_fingerprint,schema_version)
    REFERENCES ai_action_ledger(id,organisation_id,action,request_fingerprint,schema_version) ON DELETE RESTRICT,
  CHECK (result_hash=phase4_sha256_json(result))
);
CREATE INDEX ai_response_cache_lookup_idx ON ai_response_cache(organisation_id,action,request_fingerprint,schema_version,expires_at DESC);

CREATE FUNCTION phase4_guard_ai_ledger_tenant() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organisation_memberships m WHERE m.organisation_id=NEW.organisation_id
      AND m.account_id=NEW.actor_account_id AND m.status='active') THEN
    RAISE EXCEPTION 'AI actor is not an active member of the organisation';
  END IF;
  IF NEW.competition_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM competitions c WHERE c.id=NEW.competition_id AND c.organisation_id=NEW.organisation_id
  ) THEN RAISE EXCEPTION 'AI competition tenant does not match ledger organisation'; END IF;
  IF TG_OP='UPDATE' AND current_setting('matchday.phase4_ai_finalize',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'AI action ledger may only be finalised by the server-owned accounting function';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_guard_ai_cache() RETURNS trigger AS $$
BEGIN
  IF NOT phase4_ai_result_valid(NEW.action,NEW.result) THEN RAISE EXCEPTION 'AI cache result is not schema-valid'; END IF;
  IF current_setting('matchday.phase4_ai_finalize',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'AI cache may only be populated by server-owned finalisation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ai_action_ledger_phase4_guard BEFORE INSERT OR UPDATE ON ai_action_ledger
FOR EACH ROW EXECUTE FUNCTION phase4_guard_ai_ledger_tenant();
CREATE TRIGGER ai_action_ledger_phase4_immutable_delete BEFORE DELETE ON ai_action_ledger
FOR EACH ROW EXECUTE FUNCTION phase4_prevent_history_mutation('AI action ledger is append-only');
CREATE TRIGGER ai_response_cache_phase4_immutable BEFORE UPDATE OR DELETE ON ai_response_cache
FOR EACH ROW EXECUTE FUNCTION phase4_prevent_history_mutation('AI response cache entries are immutable');
CREATE TRIGGER ai_response_cache_phase4_guard BEFORE INSERT ON ai_response_cache
FOR EACH ROW EXECUTE FUNCTION phase4_guard_ai_cache();

CREATE FUNCTION phase4_begin_ai_action(target_ledger uuid,target_organisation uuid,actor uuid,target_competition uuid,
  action_value text,request_id_value text,correlation_id_value text,idempotency_value text,fingerprint_value text,
  schema_version_value text,input_character_count_value integer) RETURNS jsonb AS $$
DECLARE ledger ai_action_ledger%ROWTYPE; cached ai_response_cache%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target_organisation::text||':'||idempotency_value,0));
  SELECT * INTO ledger FROM ai_action_ledger WHERE organisation_id=target_organisation AND idempotency_key=idempotency_value;
  IF ledger.id IS NOT NULL THEN
    IF ledger.action<>action_value OR ledger.request_fingerprint<>fingerprint_value OR ledger.schema_version<>schema_version_value THEN
      RAISE EXCEPTION 'AI idempotency key was reused with a different request';
    END IF;
    SELECT * INTO cached FROM ai_response_cache WHERE organisation_id=target_organisation AND action=action_value
      AND request_fingerprint=fingerprint_value AND schema_version=schema_version_value AND expires_at>now();
    RETURN jsonb_build_object('ledger',to_jsonb(ledger),'cache_result',CASE WHEN cached.id IS NULL THEN NULL ELSE cached.result END);
  END IF;
  SELECT * INTO cached FROM ai_response_cache WHERE organisation_id=target_organisation AND action=action_value
    AND request_fingerprint=fingerprint_value AND schema_version=schema_version_value AND expires_at>now();
  INSERT INTO ai_action_ledger(id,organisation_id,actor_account_id,competition_id,action,request_id,correlation_id,idempotency_key,
    request_fingerprint,schema_version,input_character_count)
  VALUES(target_ledger,target_organisation,actor,target_competition,action_value,request_id_value,correlation_id_value,idempotency_value,
    fingerprint_value,schema_version_value,input_character_count_value) RETURNING * INTO ledger;
  IF cached.id IS NOT NULL THEN
    PERFORM set_config('matchday.phase4_ai_finalize','on',true);
    UPDATE ai_action_ledger SET outcome='success',cache_status='hit',validated=true,attempts=0,duration_ms=0,completed_at=now()
    WHERE id=ledger.id RETURNING * INTO ledger;
    PERFORM set_config('matchday.phase4_ai_finalize','off',true);
    INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
    VALUES(ledger.request_id,ledger.actor_account_id,'account',ledger.organisation_id,'ai.action.completed','ai_action',ledger.id::text,
      jsonb_build_object('action',ledger.action,'outcome',ledger.outcome,'cache_status','hit','charged_units',0));
    INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
    VALUES('ai_action',ledger.id::text,'ai.action.completed',jsonb_build_object('outcome',ledger.outcome,'charged_units',0),
      'phase4:ai-action:'||ledger.id::text);
  END IF;
  RETURN jsonb_build_object('ledger',to_jsonb(ledger),'cache_result',CASE WHEN cached.id IS NULL THEN NULL ELSE cached.result END);
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_finalize_ai_action(target_ledger uuid, final_outcome text, final_cache_status text,
  result_value jsonb, result_expires_at timestamptz, attempt_count integer, elapsed_ms integer,
  failure_code_value text DEFAULT NULL,provider_request_id_value text DEFAULT NULL,metadata_value jsonb DEFAULT '{}'::jsonb)
  RETURNS ai_action_ledger AS $$
DECLARE ledger ai_action_ledger%ROWTYPE; allowance ai_usage_allowances%ROWTYPE; charge smallint:=0;
DECLARE cached ai_response_cache%ROWTYPE;
BEGIN
  SELECT * INTO ledger FROM ai_action_ledger WHERE id=target_ledger FOR UPDATE;
  IF ledger.id IS NULL THEN RAISE EXCEPTION 'AI action does not exist'; END IF;
  IF ledger.outcome<>'pending' THEN RETURN ledger; END IF;
  IF final_outcome NOT IN ('success','failed','manual_fallback') OR final_cache_status NOT IN ('hit','miss','not_checked') THEN
    RAISE EXCEPTION 'invalid AI final outcome';
  END IF;
  IF final_outcome='success' AND NOT phase4_ai_result_valid(ledger.action,result_value) THEN
    RAISE EXCEPTION 'successful AI action requires validated structured result';
  END IF;
  IF final_outcome='success' AND final_cache_status='miss' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(':',ledger.organisation_id,ledger.action,ledger.request_fingerprint,ledger.schema_version),0));
    SELECT * INTO cached FROM ai_response_cache WHERE organisation_id=ledger.organisation_id AND action=ledger.action
      AND request_fingerprint=ledger.request_fingerprint AND schema_version=ledger.schema_version AND expires_at>now();
    IF cached.id IS NOT NULL THEN final_cache_status:='hit'; END IF;
  END IF;
  IF final_outcome='success' AND final_cache_status='miss' THEN
    SELECT * INTO allowance FROM ai_usage_allowances WHERE organisation_id=ledger.organisation_id
      AND actor_account_id=ledger.actor_account_id AND action=ledger.action AND period_start<=current_date
    ORDER BY period_start DESC LIMIT 1 FOR UPDATE;
    IF allowance.organisation_id IS NULL OR allowance.used_units>=allowance.action_limit THEN RAISE EXCEPTION 'AI action quota exhausted'; END IF;
    charge:=1;
    UPDATE ai_usage_allowances SET used_units=used_units+1,revision=revision+1,updated_at=now()
    WHERE organisation_id=allowance.organisation_id AND actor_account_id=allowance.actor_account_id
      AND action=allowance.action AND period_start=allowance.period_start;
    PERFORM set_config('matchday.phase4_ai_finalize','on',true);
    INSERT INTO ai_response_cache(organisation_id,action,request_fingerprint,schema_version,result,result_hash,validated,created_from_ledger_id,expires_at)
    VALUES(ledger.organisation_id,ledger.action,ledger.request_fingerprint,ledger.schema_version,result_value,
      phase4_sha256_json(result_value),true,ledger.id,result_expires_at)
    ;
  END IF;
  PERFORM set_config('matchday.phase4_ai_finalize','on',true);
  UPDATE ai_action_ledger SET outcome=final_outcome,cache_status=final_cache_status,validated=(final_outcome='success'),
    charged_units=charge,attempts=attempt_count,duration_ms=elapsed_ms,failure_code=failure_code_value,
    provider_request_id=provider_request_id_value,metadata=metadata_value,completed_at=now()
  WHERE id=ledger.id RETURNING * INTO ledger;
  INSERT INTO audit_events(request_id,actor_account_id,actor_type,organisation_id,action,target_type,target_id,metadata)
  VALUES(ledger.request_id,ledger.actor_account_id,'account',ledger.organisation_id,'ai.action.completed','ai_action',ledger.id::text,
    jsonb_build_object('action',ledger.action,'outcome',ledger.outcome,'cache_status',ledger.cache_status,'charged_units',ledger.charged_units));
  INSERT INTO outbox_events(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
  VALUES('ai_action',ledger.id::text,'ai.action.completed',jsonb_build_object('outcome',ledger.outcome,'charged_units',ledger.charged_units),
    'phase4:ai-action:'||ledger.id::text);
  RETURN ledger;
END;
$$ LANGUAGE plpgsql;

-- New Phase 4 children inherit the archived-aggregate fence. History tables
-- remain cascade-safe through phase4_prevent_history_mutation.
CREATE TRIGGER setup_drafts_phase4_archive_write_guard BEFORE INSERT OR UPDATE ON setup_drafts
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER format_match_sources_phase4_archive_write_guard BEFORE INSERT OR UPDATE ON format_match_sources
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_revision_formats_phase4_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_revision_formats
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_generation_jobs_phase4_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_generation_jobs
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_generation_options_phase4_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_generation_options
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_assignment_locks_phase4_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_assignment_locks
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER schedule_revision_warnings_phase4_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_revision_warnings
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();

CREATE TRIGGER schedule_generation_options_phase4_immutable BEFORE UPDATE OR DELETE ON schedule_generation_options
FOR EACH ROW EXECUTE FUNCTION phase4_prevent_history_mutation('schedule generation options are immutable');
CREATE TRIGGER schedule_revision_warnings_phase4_immutable BEFORE UPDATE OR DELETE ON schedule_revision_warnings
FOR EACH ROW EXECUTE FUNCTION phase4_prevent_history_mutation('schedule expiry warning evidence is immutable');
