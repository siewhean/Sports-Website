-- Phase 6 FMT-004: prevent premature competition completion for conditional
-- double-elimination grand-final resets and multi-division competitions.
--
-- A ready grand-final-reset is optional only when the upper-bracket champion
-- (the GF1 home slot) actually won GF1. If the lower-bracket champion won GF1,
-- the reset is required and must reach a terminal state before completion.
-- This trigger deliberately preserves the previous competition status rather
-- than raising: scoring/finalisation must commit even when other matches remain.

CREATE OR REPLACE FUNCTION phase6_guard_competition_completion()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    IF EXISTS (
      SELECT 1
      FROM matches pending
      WHERE pending.competition_id = NEW.id
        AND pending.state NOT IN ('final', 'corrected')
        AND NOT (
          (pending.code = 'grand-final-reset' OR pending.graph_match_id = 'grand-final-reset')
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
            WHERE gf1.division_id = pending.division_id
              AND (gf1.code = 'grand-final-1' OR gf1.graph_match_id = 'grand-final-1')
              AND result.home_score >= result.away_score
          )
        )
    ) THEN
      NEW.status := OLD.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zz_phase6_competition_completion_guard ON competitions;
CREATE TRIGGER zz_phase6_competition_completion_guard
BEFORE UPDATE OF status ON competitions
FOR EACH ROW
EXECUTE FUNCTION phase6_guard_competition_completion();
