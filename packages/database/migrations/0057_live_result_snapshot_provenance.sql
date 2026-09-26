-- Keep live public score snapshots out of standings provenance.
--
-- Live scoring records in-progress result snapshots so anonymous public
-- projections can update before finalisation. Standings and bracket outcomes
-- remain final-only, so the persisted provenance hash uses the same boundary.

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
          AND s.state IN ('final','corrected')
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
