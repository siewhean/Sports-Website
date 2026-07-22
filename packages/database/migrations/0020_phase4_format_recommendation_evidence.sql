-- Migration 0015 is checksum-pinned, so correct its overlapping entry-count
-- categories with a forward-only wrapper. This also repairs populated drafts
-- before recommendation evidence can be generated from them.
ALTER FUNCTION phase4_setup_seed_values(uuid)
  RENAME TO phase4_setup_seed_values_pre_recommendation_evidence;

CREATE FUNCTION phase4_normalize_setup_entry_references(
  target_competition uuid,
  setup_values jsonb
) RETURNS jsonb AS $$
DECLARE
  normalized_divisions jsonb;
BEGIN
  IF setup_values->'entries' IS NULL THEN RETURN setup_values; END IF;

  SELECT COALESCE(jsonb_agg(
    division_value || jsonb_build_object(
      'entry_ids',COALESCE(actual.entry_ids,'[]'::jsonb),
      'confirmed_count',actual.confirmed_count,
      'placeholder_count',actual.placeholder_count
    ) ORDER BY division_value->>'division_id'
  ),'[]'::jsonb)
  INTO normalized_divisions
  FROM jsonb_array_elements(setup_values->'entries'->'divisions') division_value
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(jsonb_agg(entry.id ORDER BY entry.id)
        FILTER (WHERE entry.status IN ('confirmed','active')),'[]'::jsonb) entry_ids,
      count(entry.id) FILTER (
        WHERE entry.status IN ('confirmed','active') AND entry.entry_type<>'placeholder'
      ) confirmed_count,
      count(entry.id) FILTER (
        WHERE entry.status IN ('confirmed','active') AND entry.entry_type='placeholder'
      ) placeholder_count
    FROM division_entries entry
    WHERE entry.division_id=(division_value->>'division_id')::uuid
  ) actual ON true;

  RETURN jsonb_set(setup_values,'{entries,divisions}',normalized_divisions);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase4_setup_seed_values(target_competition uuid) RETURNS jsonb AS $$
  SELECT phase4_normalize_setup_entry_references(
    target_competition,
    phase4_setup_seed_values_pre_recommendation_evidence(target_competition)
  );
$$ LANGUAGE sql STABLE;

UPDATE setup_drafts
SET steps=phase4_normalize_setup_entry_references(competition_id,steps),
    revision=revision+1,
    updated_at=clock_timestamp()
WHERE steps->'entries' IS NOT NULL;

CREATE TABLE phase4_format_recommendation_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE RESTRICT,
  setup_draft_id uuid NOT NULL REFERENCES setup_drafts(id) ON DELETE RESTRICT,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  source_evidence jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (setup_draft_id, source_hash)
);

CREATE TABLE phase4_format_recommendation_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_set_id uuid NOT NULL REFERENCES phase4_format_recommendation_sets(id) ON DELETE RESTRICT,
  family text NOT NULL CHECK (family IN ('full_placement','championship_focus','compact_knockout')),
  category text NOT NULL CHECK (category IN ('normal','requires_changes')),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 4),
  aggregate_metrics jsonb NOT NULL,
  UNIQUE (recommendation_set_id, family),
  UNIQUE (recommendation_set_id, category, ordinal)
);

CREATE TABLE phase4_format_recommendation_candidate_divisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES phase4_format_recommendation_candidates(id) ON DELETE RESTRICT,
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE RESTRICT,
  definition jsonb NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  layout jsonb NOT NULL,
  metrics jsonb NOT NULL,
  UNIQUE (candidate_id, division_id)
);

CREATE FUNCTION phase4_prevent_recommendation_evidence_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'format recommendation evidence is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_validate_recommendation_set() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM competitions c JOIN setup_drafts s ON s.competition_id=c.id
    WHERE c.id=NEW.competition_id AND c.organisation_id=NEW.organisation_id AND s.id=NEW.setup_draft_id
      AND NEW.source_evidence->>'sport_code'=c.sport_code
      AND (NEW.source_evidence->'capacity'->>'revision')::bigint=c.capacity_revision
      AND NEW.source_evidence->'capacity'->>'source_hash'=phase4_capacity_hash(c.id)
      AND (NEW.source_evidence->'capacity'->>'available_match_slots')::int=phase3_available_match_slots(c.id)
  ) OR jsonb_typeof(NEW.source_evidence)<>'object'
    OR NOT (NEW.source_evidence ?& ARRAY['sport_code','capacity','entries','preferences'])
    OR jsonb_typeof(NEW.source_evidence->'capacity')<>'object'
    OR NOT (NEW.source_evidence->'capacity' ?& ARRAY['revision','source_hash','available_match_slots'])
    OR jsonb_typeof(NEW.source_evidence->'entries')<>'array'
    OR jsonb_typeof(NEW.source_evidence->'preferences')<>'object'
    OR phase4_sha256_json(NEW.source_evidence)<>NEW.source_hash THEN
    RAISE EXCEPTION 'format recommendation set provenance is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_validate_recommendation_candidate_division() RETURNS trigger AS $$
BEGIN
  IF jsonb_typeof(NEW.metrics)<>'object'
     OR NOT (NEW.metrics ?& ARRAY['match_count','guaranteed_matches','ranking_coverage'])
     OR jsonb_typeof(NEW.metrics->'match_count')<>'number'
     OR jsonb_typeof(NEW.metrics->'guaranteed_matches')<>'number'
     OR jsonb_typeof(NEW.metrics->'ranking_coverage')<>'string'
     OR NEW.definition_hash<>phase4_sha256_json(NEW.definition)
     OR NOT phase3_format_definition_db_valid(NEW.definition)
     OR NOT phase3_format_entry_count_matches_division(NEW.definition,NEW.division_id)
     OR NOT phase4_layout_valid(NEW.definition,NEW.layout)
     OR (NEW.metrics->>'match_count')::int<>jsonb_array_length(NEW.definition->'matches')
     OR COALESCE((NEW.metrics->>'guaranteed_matches')::int,0)<1
     OR COALESCE(NEW.metrics->>'ranking_coverage','') NOT IN ('all_entries','podium','champion')
     OR NOT EXISTS (
       SELECT 1 FROM phase4_format_recommendation_candidates candidate
       JOIN phase4_format_recommendation_sets recommendation_set ON recommendation_set.id=candidate.recommendation_set_id
       JOIN divisions division ON division.id=NEW.division_id
       WHERE candidate.id=NEW.candidate_id AND division.competition_id=recommendation_set.competition_id
     ) THEN RAISE EXCEPTION 'format recommendation candidate division evidence is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase4_validate_recommendation_candidate_totals() RETURNS trigger AS $$
DECLARE candidate_id_value uuid; candidate_row phase4_format_recommendation_candidates%ROWTYPE;
DECLARE source_slots integer; expected_divisions integer; actual_divisions integer; total_matches integer;
BEGIN
  candidate_id_value:=NEW.id;
  SELECT * INTO candidate_row FROM phase4_format_recommendation_candidates WHERE id=candidate_id_value;
  IF jsonb_typeof(candidate_row.aggregate_metrics)<>'object'
     OR NOT (candidate_row.aggregate_metrics ?& ARRAY['name','structure','advantage','match_count','guaranteed_matches',
       'ranking_coverage','available_match_slots','capacity_status','scheduling_status','warning_codes'])
     OR jsonb_typeof(candidate_row.aggregate_metrics->'match_count')<>'number'
     OR jsonb_typeof(candidate_row.aggregate_metrics->'guaranteed_matches')<>'number'
     OR jsonb_typeof(candidate_row.aggregate_metrics->'available_match_slots')<>'number'
     OR jsonb_typeof(candidate_row.aggregate_metrics->'warning_codes')<>'array' THEN
    RAISE EXCEPTION 'format recommendation candidate aggregate evidence is invalid';
  END IF;
  SELECT (recommendation_set.source_evidence->'capacity'->>'available_match_slots')::int,
         jsonb_array_length(recommendation_set.source_evidence->'entries')
    INTO source_slots,expected_divisions
    FROM phase4_format_recommendation_sets recommendation_set WHERE recommendation_set.id=candidate_row.recommendation_set_id;
  SELECT count(*)::int,COALESCE(sum((metrics->>'match_count')::int),0)::int INTO actual_divisions,total_matches
    FROM phase4_format_recommendation_candidate_divisions WHERE candidate_id=candidate_id_value;
  IF actual_divisions<>expected_divisions OR total_matches<>(candidate_row.aggregate_metrics->>'match_count')::int
     OR source_slots<>(candidate_row.aggregate_metrics->>'available_match_slots')::int
     OR ((candidate_row.category='normal')<>(total_matches<=source_slots))
     OR ((candidate_row.aggregate_metrics->>'guaranteed_matches')::int<>(
       SELECT min((metrics->>'guaranteed_matches')::int) FROM phase4_format_recommendation_candidate_divisions WHERE candidate_id=candidate_id_value
     )) THEN RAISE EXCEPTION 'format recommendation candidate aggregate evidence is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER phase4_recommendation_set_guard BEFORE INSERT ON phase4_format_recommendation_sets
FOR EACH ROW EXECUTE FUNCTION phase4_validate_recommendation_set();
CREATE TRIGGER phase4_recommendation_candidate_division_guard BEFORE INSERT ON phase4_format_recommendation_candidate_divisions
FOR EACH ROW EXECUTE FUNCTION phase4_validate_recommendation_candidate_division();
CREATE CONSTRAINT TRIGGER phase4_recommendation_candidate_totals_guard
AFTER INSERT ON phase4_format_recommendation_candidates DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION phase4_validate_recommendation_candidate_totals();

CREATE FUNCTION phase4_validate_recommendation_division_totals() RETURNS trigger AS $$
DECLARE candidate_row phase4_format_recommendation_candidates%ROWTYPE;
DECLARE source_slots integer; expected_divisions integer; actual_divisions integer; total_matches integer;
BEGIN
  SELECT * INTO candidate_row FROM phase4_format_recommendation_candidates WHERE id=NEW.candidate_id;
  SELECT (recommendation_set.source_evidence->'capacity'->>'available_match_slots')::int,
         jsonb_array_length(recommendation_set.source_evidence->'entries')
    INTO source_slots,expected_divisions
    FROM phase4_format_recommendation_sets recommendation_set WHERE recommendation_set.id=candidate_row.recommendation_set_id;
  SELECT count(*)::int,COALESCE(sum((metrics->>'match_count')::int),0)::int INTO actual_divisions,total_matches
    FROM phase4_format_recommendation_candidate_divisions WHERE candidate_id=NEW.candidate_id;
  IF actual_divisions<>expected_divisions OR total_matches<>(candidate_row.aggregate_metrics->>'match_count')::int
     OR source_slots<>(candidate_row.aggregate_metrics->>'available_match_slots')::int
     OR ((candidate_row.category='normal')<>(total_matches<=source_slots)) THEN
    RAISE EXCEPTION 'format recommendation candidate aggregate evidence is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER phase4_recommendation_division_totals_guard
AFTER INSERT ON phase4_format_recommendation_candidate_divisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION phase4_validate_recommendation_division_totals();

CREATE TRIGGER phase4_recommendation_sets_immutable BEFORE UPDATE OR DELETE ON phase4_format_recommendation_sets
FOR EACH ROW EXECUTE FUNCTION phase4_prevent_recommendation_evidence_mutation();
CREATE TRIGGER phase4_recommendation_candidates_immutable BEFORE UPDATE OR DELETE ON phase4_format_recommendation_candidates
FOR EACH ROW EXECUTE FUNCTION phase4_prevent_recommendation_evidence_mutation();
CREATE TRIGGER phase4_recommendation_candidate_divisions_immutable BEFORE UPDATE OR DELETE ON phase4_format_recommendation_candidate_divisions
FOR EACH ROW EXECUTE FUNCTION phase4_prevent_recommendation_evidence_mutation();
