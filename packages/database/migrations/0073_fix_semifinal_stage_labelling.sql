-- Track R2.4: Fix semifinal stage labelling.
-- Redefines phase4_materialize_format_revision exactly as 0034 left it, except the stage label:
-- a single_elimination progression match in the penultimate round of its stage's championship
-- path (round = max round - 1) is now 'semifinal' instead of 'quarterfinal'. The label is derived
-- purely from graph structure (stage kind, purpose, round), never from match ID text.

CREATE OR REPLACE FUNCTION phase4_materialize_format_revision(target_revision uuid) RETURNS integer AS $$
DECLARE revision_row format_revisions%ROWTYPE; graph_match jsonb; source jsonb; new_match_id uuid; source_uuid uuid;
DECLARE stage_kind text; ordinal_value integer; inserted_count integer:=0; slot_name text; stage_max_round integer;
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

    -- Championship-path depth of this stage; placement/classification matches are excluded so a
    -- bronze or classification match can never shift which round counts as the semifinal.
    SELECT max((m->>'round')::integer) INTO stage_max_round
    FROM jsonb_array_elements(revision_row.definition->'matches') m
    WHERE m->>'stageId'=graph_match->>'stageId' AND m->>'purpose' IN ('progression','championship');

    INSERT INTO matches(id,competition_id,division_id,format_revision_id,code,stage,round_number,ordinal,
      graph_match_id,graph_stage_id,graph_pool_id,graph_purpose)
    VALUES(new_match_id,revision_row.competition_id,revision_row.division_id,target_revision,
      left(graph_match->>'id',40),
      CASE
        WHEN graph_match->>'purpose'='championship' THEN 'final'
        WHEN graph_match->>'purpose'='placement' THEN 'bronze'
        WHEN stage_kind='single_elimination' THEN
          CASE
            WHEN graph_match->>'purpose'='progression'
                 AND (graph_match->>'round')::integer = stage_max_round - 1 THEN 'semifinal'
            ELSE 'quarterfinal'
          END
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

-- Backfill already-materialised projections from the same structural rule, reading the
-- authoritative graph (format_revisions.definition) rather than the denormalised columns.
-- aa_matches_phase4_projection_guard rejects any stage change on a materialised projection, so
-- the guard is disabled for this single statement only, following the sanctioned migration
-- precedent in 0011 (DISABLE/ENABLE around a deterministic backfill). The migrator runs this file
-- in one transaction under an ACCESS EXCLUSIVE lock taken by ALTER TABLE, so no concurrent writer
-- can observe or exploit the window, and a failure rolls the trigger state back too.
-- Only `stage` changes; every other guarded projection column is untouched, so
-- phase4_materialization_is_exact stays true for every revision.
ALTER TABLE matches DISABLE TRIGGER aa_matches_phase4_projection_guard;

WITH graph_stage AS (
  SELECT revision.id AS format_revision_id, stage->>'id' AS stage_id
  FROM format_revisions revision
  CROSS JOIN LATERAL jsonb_array_elements(revision.definition->'stages') stage
  WHERE revision.graph_materialized_at IS NOT NULL
    AND stage->>'kind'='single_elimination'
), stage_depth AS (
  SELECT graph_stage.format_revision_id, graph_stage.stage_id,
    max((graph_match->>'round')::integer) AS max_round
  FROM graph_stage
  JOIN format_revisions revision ON revision.id=graph_stage.format_revision_id
  CROSS JOIN LATERAL jsonb_array_elements(revision.definition->'matches') graph_match
  WHERE graph_match->>'stageId'=graph_stage.stage_id
    AND graph_match->>'purpose' IN ('progression','championship')
  GROUP BY graph_stage.format_revision_id, graph_stage.stage_id
)
UPDATE matches match
SET stage='semifinal'
FROM stage_depth depth
WHERE match.format_revision_id=depth.format_revision_id
  AND match.graph_stage_id=depth.stage_id
  AND match.graph_purpose='progression'
  AND match.round_number=depth.max_round-1
  AND match.stage='quarterfinal';

ALTER TABLE matches ENABLE TRIGGER aa_matches_phase4_projection_guard;
