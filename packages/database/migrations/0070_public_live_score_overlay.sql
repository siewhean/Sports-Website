-- 0070_public_live_score_overlay.sql
--
-- 1. Per-match live score overlay.
--    Every scored point used to rebuild the whole competition public projection
--    (schedule, all results, every live match's full event replay, standings)
--    and upsert a large JSONB row while holding competition_publications FOR
--    UPDATE, so every court of a competition serialised on one row and point
--    latency grew with competition size. A point now upserts one small row
--    keyed by its match. The public read path overlays visible rows onto the
--    last full projection; the full projection is rebuilt only on publication,
--    finalisation, correction, reopening and lifecycle changes.
--
--    revision comes from a sequence, so every write of a row (point, or a
--    rebuild refreshing it) gets a new, never-reused value. The public version
--    token digests (match_id, revision) of the visible rows, so every point
--    changes the SSE version and the ETag without a competition-wide counter.
--
-- 2. public_competition_projections.live_overlay_cutoff_at records the stale
--    cut-off the full projection was built with. Overlay rows last updated at
--    or before it are hidden, matching the rebuilt projection, so the stale
--    live-match sweep keeps working and content never changes with wall time.
--
-- 3. public_competition_projections.projection_digest is computed by the
--    existing trigger whenever the stored projection changes. The read path
--    uses it as the content fingerprint instead of re-hashing the payload on
--    every request. Existing rows keep NULL until their next write (the reader
--    falls back to hashing); no backfill, because archived rows reject UPDATE.
--
-- 4. canonical_score_events_match_version_idx duplicated the
--    UNIQUE(match_id,aggregate_version) index. A plain DROP INDEX takes an
--    ACCESS EXCLUSIVE lock briefly; CONCURRENTLY cannot run inside the
--    transactional migration runner, and the runner's lock_timeout makes the
--    drop fail fast (and retry) instead of queueing behind live scoring.

CREATE SEQUENCE public_live_match_score_revision_seq AS bigint;

CREATE TABLE public_live_match_scores (
  match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 0),
  revision bigint NOT NULL,
  live_result jsonb NOT NULL CHECK (jsonb_typeof(live_result) = 'object'),
  updated_at timestamptz NOT NULL
);

ALTER SEQUENCE public_live_match_score_revision_seq OWNED BY public_live_match_scores.revision;

CREATE INDEX public_live_match_scores_competition_idx
  ON public_live_match_scores(competition_id, match_id);

-- Every write takes a fresh revision; application code cannot pin or rewind it.
CREATE FUNCTION public_live_match_score_revision() RETURNS trigger AS $$
BEGIN
  NEW.revision := nextval('public_live_match_score_revision_seq');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER zz_public_live_match_scores_revision
BEFORE INSERT OR UPDATE ON public_live_match_scores
FOR EACH ROW EXECUTE FUNCTION public_live_match_score_revision();

-- Archived competitions stay immutable, like their public projection rows.
CREATE TRIGGER aa_public_live_match_scores_phase3_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON public_live_match_scores
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();

ALTER TABLE public_competition_projections
  ADD COLUMN live_overlay_cutoff_at timestamptz,
  ADD COLUMN projection_digest text CHECK (projection_digest IS NULL OR projection_digest ~ '^[0-9a-f]{32}$');

CREATE OR REPLACE FUNCTION public_competition_projection_live_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.live_revision := 1;
    NEW.projection_digest := md5(NEW.projection::text);
  ELSIF NEW.projection IS DISTINCT FROM OLD.projection THEN
    NEW.live_revision := OLD.live_revision + 1;
    NEW.projection_digest := md5(NEW.projection::text);
  ELSE
    NEW.live_revision := OLD.live_revision;
    NEW.projection_digest := COALESCE(OLD.projection_digest, md5(NEW.projection::text));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS canonical_score_events_match_version_idx;
