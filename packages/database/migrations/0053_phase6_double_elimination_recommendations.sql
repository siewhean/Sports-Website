-- Phase 6: Expand format recommendation candidates to support double elimination

ALTER TABLE phase4_format_recommendation_candidates
  DROP CONSTRAINT IF EXISTS phase4_format_recommendation_candidates_family_check;

ALTER TABLE phase4_format_recommendation_candidates
  ADD CONSTRAINT phase4_format_recommendation_candidates_family_check
  CHECK (family IN ('full_placement', 'championship_focus', 'compact_knockout', 'double_elimination'));
