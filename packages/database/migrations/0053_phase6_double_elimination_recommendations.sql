-- Phase 6: Expand format recommendation candidates to support double elimination

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'phase4_format_recommendation_candidates'
  ) THEN
    ALTER TABLE phase4_format_recommendation_candidates
      DROP CONSTRAINT IF EXISTS phase4_format_recommendation_candidates_family_check;

    ALTER TABLE phase4_format_recommendation_candidates
      ADD CONSTRAINT phase4_format_recommendation_candidates_family_check
      CHECK (family IN ('full_placement', 'championship_focus', 'compact_knockout', 'double_elimination'));
  END IF;
END $$;
