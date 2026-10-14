-- Format suggestions can offer a single round robin when it fits capacity and the schedule.

DO $$
BEGIN
  -- to_regclass resolves through the migration's search_path, unlike information_schema.tables.
  IF to_regclass('phase4_format_recommendation_candidates') IS NOT NULL THEN
    ALTER TABLE phase4_format_recommendation_candidates
      DROP CONSTRAINT IF EXISTS phase4_format_recommendation_candidates_family_check;

    ALTER TABLE phase4_format_recommendation_candidates
      ADD CONSTRAINT phase4_format_recommendation_candidates_family_check
      CHECK (family IN ('full_placement', 'championship_focus', 'compact_knockout', 'double_elimination', 'round_robin'));
  END IF;
END $$;
