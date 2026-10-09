-- 0068_public_live_revision_and_competition_lifecycle.sql
--
-- 1. Public live revision.
--    Live score updates rewrite the current public projection row in place
--    (same competition/schedule_version/result_version key), so the public
--    version token schedule:result:projection never changed and SSE viewers
--    never refreshed. live_revision is a per-row counter that the database
--    advances whenever the stored projection content changes. Application code
--    cannot set, rewind or skip it: the trigger owns the value. A content-free
--    upsert (identical projection) keeps the revision so idle viewers are not
--    told to refetch.
--
-- 2. Schedule-elapsed competition completion.
--    zz_phase6_competition_completion_guard silently keeps the previous status
--    while any match is unfinished. That is right for scoring-driven
--    completion, but it leaves competitions whose dates are long over (with an
--    abandoned live or pending match) `active` forever. The lifecycle sweeper
--    sets the transaction-local flag matchday.competition_schedule_elapsed=on;
--    the guard then permits completion only when the final competition day has
--    fully elapsed in the competition's own timezone, measured on the database
--    clock. Unfinished matches are left untouched (never auto-finalised).

ALTER TABLE public_competition_projections
  ADD COLUMN live_revision integer NOT NULL DEFAULT 1 CHECK (live_revision >= 1);

CREATE FUNCTION public_competition_projection_live_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.live_revision := 1;
  ELSIF NEW.projection IS DISTINCT FROM OLD.projection THEN
    NEW.live_revision := OLD.live_revision + 1;
  ELSE
    NEW.live_revision := OLD.live_revision;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Runs after the aa_* archive guard so archived competitions still reject the write.
CREATE TRIGGER zz_public_competition_projections_live_revision
BEFORE INSERT OR UPDATE ON public_competition_projections
FOR EACH ROW EXECUTE FUNCTION public_competition_projection_live_revision();

CREATE OR REPLACE FUNCTION phase6_guard_competition_completion()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    IF current_setting('matchday.competition_schedule_elapsed', true) IS NOT DISTINCT FROM 'on'
       AND ((NEW.ends_on + 1)::timestamp AT TIME ZONE NEW.timezone) <= now() THEN
      RETURN NEW;
    END IF;
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

-- Supports the stale-live sweep and the deployment-freeze live-match probe.
CREATE INDEX IF NOT EXISTS matches_in_progress_competition_idx
  ON matches(competition_id) WHERE state = 'in_progress';
