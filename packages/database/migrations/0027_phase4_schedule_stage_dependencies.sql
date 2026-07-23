-- Schedule precedence is broader than direct winner/loser match edges.
-- Stage-rank and manual-qualifier sources cannot be known until their source
-- stage (or the selected source pool) is complete, so the authoritative
-- schedule snapshot must include those materialised matches as dependencies.

CREATE FUNCTION phase4_match_schedule_dependencies(target_match uuid)
RETURNS TABLE(source_match_id uuid) AS $$
  SELECT DISTINCT dependency.source_match_id
  FROM (
    SELECT source.source_match_id
    FROM format_match_sources source
    WHERE source.match_id=target_match
      AND source.source_kind IN ('winner','loser')
      AND source.source_match_id IS NOT NULL

    UNION ALL

    SELECT producer.id
    FROM format_match_sources source
    JOIN matches consumer ON consumer.id=source.match_id
    JOIN matches producer
      ON producer.format_revision_id=consumer.format_revision_id
      AND producer.graph_stage_id=source.source_stage_id
      AND (
        source.source_kind='manual_qualifier'
        OR source.source_group_id IS NULL
        OR producer.graph_pool_id=source.source_group_id
      )
    WHERE source.match_id=target_match
      AND source.source_kind IN ('stage_rank','manual_qualifier')
  ) dependency
  ORDER BY dependency.source_match_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION phase4_guard_schedule_job_input_references() RETURNS trigger AS $$
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
       OR EXISTS (SELECT dependency.source_match_id FROM phase4_match_schedule_dependencies(stored_match.id) dependency
          EXCEPT SELECT item::uuid FROM jsonb_array_elements_text(match_value->'dependency_match_ids') item)
       OR EXISTS (SELECT item::uuid FROM jsonb_array_elements_text(match_value->'dependency_match_ids') item
          EXCEPT SELECT dependency.source_match_id FROM phase4_match_schedule_dependencies(stored_match.id) dependency) THEN
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
