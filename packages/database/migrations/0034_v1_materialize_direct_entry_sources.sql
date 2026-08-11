-- A V1 division may leave a team unseeded.  The scheduler and the database
-- authority map it to the lowest vacant seed, but the materialiser previously
-- only projected the source rows and left direct round-robin matches as TBD.
-- Keep the projection on the same explicit-seed / stable-unseeded authority
-- mapping as phase4_match_possible_entries (0033).
CREATE OR REPLACE FUNCTION phase4_materialize_format_revision(target_revision uuid) RETURNS integer AS $$
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

  WITH explicit_entries AS (
    SELECT entry.id AS entry_id,entry.seed
    FROM division_entries entry
    WHERE entry.division_id=revision_row.division_id
      AND entry.status IN ('confirmed','active') AND entry.seed IS NOT NULL
  ), unseeded_entries AS (
    SELECT entry.id AS entry_id,row_number() OVER (ORDER BY entry.id)::integer AS ordinal
    FROM division_entries entry
    WHERE entry.division_id=revision_row.division_id
      AND entry.status IN ('confirmed','active') AND entry.seed IS NULL
  ), assigned_entries AS (
    SELECT entry_id,seed FROM explicit_entries
    UNION ALL
    SELECT unseeded.entry_id,
      (ARRAY(SELECT candidate.seed FROM generate_series(1,(revision_row.definition->>'entryCount')::integer) AS candidate(seed)
        WHERE NOT EXISTS (SELECT 1 FROM explicit_entries explicit WHERE explicit.seed=candidate.seed)
        ORDER BY candidate.seed))[unseeded.ordinal]
    FROM unseeded_entries unseeded
  ), direct_slots AS (
    SELECT source.match_id,
      (array_agg(assigned.entry_id) FILTER (WHERE source.slot='home'))[1] AS home_entry_id,
      (array_agg(assigned.entry_id) FILTER (WHERE source.slot='away'))[1] AS away_entry_id
    FROM format_match_sources source
    JOIN assigned_entries assigned ON assigned.seed=source.entry_seed
    WHERE source.format_revision_id=target_revision AND source.source_kind='entry_seed'
    GROUP BY source.match_id
  )
  UPDATE matches match
  SET home_entry_id=direct.home_entry_id,
      away_entry_id=direct.away_entry_id,
      state=CASE WHEN direct.home_entry_id IS NOT NULL AND direct.away_entry_id IS NOT NULL THEN 'ready' ELSE match.state END
  FROM direct_slots direct
  WHERE match.id=direct.match_id;

  UPDATE format_revisions SET graph_materialized_at=now(),graph_match_count=inserted_count,
    graph_materialization_hash=phase4_sha256_json(jsonb_build_object(
      'definitionHash',definition_hash,'matchIds',(SELECT jsonb_agg(graph_match_id ORDER BY ordinal) FROM matches WHERE format_revision_id=target_revision)
    )) WHERE id=target_revision;
  RETURN inserted_count;
END;
$$ LANGUAGE plpgsql;
