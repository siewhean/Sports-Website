-- An entry seed is an optional organiser preference. Scheduling still needs a
-- complete deterministic graph mapping, so unseeded active entries receive the
-- lowest vacant graph seed after all explicit seeds have been retained.
CREATE OR REPLACE FUNCTION phase4_match_possible_entries(target_match uuid) RETURNS TABLE(entry_id uuid) AS $$
  WITH RECURSIVE
  format_entry_counts AS (
    SELECT revision.id AS format_revision_id,
      (revision.definition->'graph'->>'entryCount')::integer AS entry_count
    FROM format_revisions revision
  ),
  explicit_entries AS (
    SELECT match.format_revision_id, entry.id AS entry_id, entry.seed
    FROM matches match
    JOIN division_entries entry ON entry.division_id=match.division_id
      AND entry.status IN ('confirmed','active') AND entry.seed IS NOT NULL
    WHERE match.id=target_match
  ),
  unseeded_entries AS (
    SELECT match.format_revision_id, entry.id AS entry_id,
      row_number() OVER (PARTITION BY match.format_revision_id ORDER BY entry.id)::integer AS ordinal
    FROM matches match
    JOIN division_entries entry ON entry.division_id=match.division_id
      AND entry.status IN ('confirmed','active') AND entry.seed IS NULL
    WHERE match.id=target_match
  ),
  assigned_entries AS (
    SELECT format_revision_id,entry_id,seed FROM explicit_entries
    UNION ALL
    SELECT unseeded.format_revision_id,unseeded.entry_id,
      (
        ARRAY(
          SELECT candidate.seed
          FROM generate_series(1,counts.entry_count) AS candidate(seed)
          WHERE NOT EXISTS (
            SELECT 1 FROM explicit_entries explicit
            WHERE explicit.format_revision_id=unseeded.format_revision_id AND explicit.seed=candidate.seed
          )
          ORDER BY candidate.seed
        )
      )[unseeded.ordinal]
    FROM unseeded_entries unseeded
    JOIN format_entry_counts counts ON counts.format_revision_id=unseeded.format_revision_id
  ),
  reachable(match_id,entry_id) AS (
    SELECT source.match_id,entry.entry_id
    FROM format_match_sources source
    JOIN matches target ON target.id=source.match_id
    JOIN assigned_entries entry ON entry.format_revision_id=target.format_revision_id AND entry.seed=source.entry_seed
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
