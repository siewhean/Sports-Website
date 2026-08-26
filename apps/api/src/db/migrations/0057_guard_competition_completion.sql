-- FMT-004: prevent application code or concurrent writers from completing a
-- competition while any required match remains non-terminal. Optional GF2 is
-- ignored only when GF1 proves the upper-bracket champion already won.

CREATE OR REPLACE FUNCTION guard_required_matches_before_competition_completion()
RETURNS TRIGGER AS $$
DECLARE
  pending_count integer;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer INTO pending_count
  FROM matches m
  WHERE m.competition_id = NEW.id
    AND m.state NOT IN ('final', 'corrected')
    AND NOT (
      (m.graph_match_id = 'grand-final-reset' OR m.code = 'grand-final-reset')
      AND m.state IN ('pending', 'ready')
      AND EXISTS (
        SELECT 1
        FROM matches gf1
        JOIN LATERAL (
          SELECT snapshot.home_score, snapshot.away_score
          FROM match_result_snapshots snapshot
          WHERE snapshot.match_id = gf1.id
            AND snapshot.state IN ('final', 'corrected')
          ORDER BY snapshot.result_version DESC
          LIMIT 1
        ) result ON true
        WHERE gf1.competition_id = m.competition_id
          AND gf1.division_id = m.division_id
          AND (gf1.graph_match_id = 'grand-final-1' OR gf1.code = 'grand-final-1')
          AND result.home_score >= result.away_score
      )
    );

  IF pending_count > 0 THEN
    -- A stale runtime must not be allowed to bypass the required-match fence.
    -- Preserve the prior lifecycle state; the terminal-match trigger will
    -- promote the competition once the final required match is complete.
    NEW.status := OLD.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS competitions_required_completion_guard ON competitions;
CREATE TRIGGER competitions_required_completion_guard
BEFORE UPDATE OF status ON competitions
FOR EACH ROW
EXECUTE FUNCTION guard_required_matches_before_competition_completion();
