ALTER TABLE competitions DROP CONSTRAINT competitions_sport_code_check;
ALTER TABLE competitions DROP CONSTRAINT competitions_status_check;
ALTER TABLE competitions
  ADD CONSTRAINT competitions_sport_code_check CHECK (sport_code IN (
    'canoe_polo','badminton','table_tennis','volleyball','basketball'
  )),
  ADD CONSTRAINT competitions_status_check CHECK (status IN (
    'draft','ready','published','active','live','completed','archived'
  )),
  ADD COLUMN venue text NOT NULL DEFAULT '',
  ADD COLUMN address text NOT NULL DEFAULT '',
  ADD COLUMN locality text,
  ADD COLUMN country_code text NOT NULL DEFAULT 'SG' CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN locale text NOT NULL DEFAULT 'en-SG',
  ADD COLUMN first_match_started_at timestamptz,
  ADD COLUMN archived_from_status text CHECK (archived_from_status IN ('draft','ready','published','active','live','completed')),
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN restored_at timestamptz,
  ADD COLUMN plan_tier text NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free','organiser_pro','event_pass')),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE FUNCTION phase3_lock_competition_sport() RETURNS trigger AS $$
BEGIN
  IF NEW.sport_code <> OLD.sport_code AND (
    OLD.first_match_started_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM matches WHERE competition_id=OLD.id AND state IN ('in_progress','final','corrected')
    )
  ) THEN
    RAISE EXCEPTION 'competition sport is locked after the first match starts';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER competitions_phase3_sport_lock
BEFORE UPDATE OF sport_code ON competitions
FOR EACH ROW EXECUTE FUNCTION phase3_lock_competition_sport();

ALTER TABLE divisions DROP CONSTRAINT divisions_team_limit_check;
ALTER TABLE divisions
  ADD CONSTRAINT divisions_team_limit_check CHECK (team_limit IN (8,12,16,24,48)),
  ADD COLUMN code text,
  ADD COLUMN settings_override jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE division_entries DROP CONSTRAINT division_entries_seed_check;
ALTER TABLE division_entries DROP CONSTRAINT division_entries_status_check;
ALTER TABLE division_entries DROP CONSTRAINT division_entries_division_id_seed_key;
ALTER TABLE division_entries DROP CONSTRAINT division_entries_division_id_name_key;
ALTER TABLE division_entries
  ALTER COLUMN seed DROP NOT NULL,
  ADD CONSTRAINT division_entries_seed_check CHECK (seed IS NULL OR seed BETWEEN 1 AND 48),
  ADD CONSTRAINT division_entries_status_check CHECK (status IN ('confirmed','active','withdrawn','replaced')),
  ADD COLUMN entry_type text NOT NULL DEFAULT 'team' CHECK (entry_type IN ('team','individual','placeholder')),
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN availability jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN replacement_entry_id uuid REFERENCES division_entries(id),
  ADD COLUMN replaces_entry_id uuid REFERENCES division_entries(id),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT division_entries_replacement_distinct CHECK (
    replacement_entry_id IS NULL OR replacement_entry_id <> id
  );

CREATE UNIQUE INDEX division_entries_active_seed_unique
ON division_entries(division_id,seed) WHERE status IN ('confirmed','active') AND seed IS NOT NULL;
CREATE UNIQUE INDEX division_entries_active_name_unique
ON division_entries(division_id,name) WHERE status IN ('confirmed','active');

CREATE FUNCTION phase3_enforce_free_entry_limit() RETURNS trigger AS $$
DECLARE
  target_competition uuid;
  tier text;
  active_count integer;
BEGIN
  IF NEW.status NOT IN ('confirmed','active') THEN RETURN NEW; END IF;
  SELECT competition_id INTO target_competition FROM divisions WHERE id=NEW.division_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(target_competition::text, 0));
  SELECT plan_tier INTO tier FROM competitions WHERE id=target_competition FOR UPDATE;
  IF tier <> 'free' THEN RETURN NEW; END IF;
  SELECT count(*) INTO active_count
  FROM division_entries e JOIN divisions d ON d.id=e.division_id
  WHERE d.competition_id=target_competition AND e.status IN ('confirmed','active') AND e.id<>NEW.id;
  IF active_count >= 16 THEN RAISE EXCEPTION 'free plan permits at most 16 active entries per competition'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER division_entries_phase3_free_limit
BEFORE INSERT OR UPDATE OF division_id, status ON division_entries
FOR EACH ROW EXECUTE FUNCTION phase3_enforce_free_entry_limit();

CREATE TABLE entry_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('paste','csv')),
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count integer NOT NULL CHECK (row_count > 0),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, competition_id),
  FOREIGN KEY (division_id, competition_id) REFERENCES divisions(id, competition_id)
);

CREATE TABLE sport_pack_versions (
  sport_code text NOT NULL CHECK (sport_code IN ('canoe_polo','badminton','table_tennis','volleyball','basketball')),
  version text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  definition jsonb NOT NULL,
  definition_hash text NOT NULL CHECK (length(definition_hash)=64),
  created_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sport_code, version),
  UNIQUE (sport_code, definition_hash)
);

ALTER TABLE competition_sport_settings
  ADD COLUMN sport_code text NOT NULL DEFAULT 'canoe_polo',
  ADD COLUMN pack_version text,
  ADD COLUMN pack_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN recommended_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN settings_override jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE TABLE division_sport_settings (
  division_id uuid PRIMARY KEY REFERENCES divisions(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  sport_code text NOT NULL,
  pack_version text NOT NULL,
  settings_override jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (division_id, competition_id) REFERENCES divisions(id, competition_id)
);

CREATE TABLE account_sport_defaults (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sport_code text NOT NULL,
  source_pack_version text NOT NULL,
  settings jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, sport_code),
  FOREIGN KEY (sport_code,source_pack_version) REFERENCES sport_pack_versions(sport_code,version)
);

ALTER TABLE competition_sport_settings
  ADD CONSTRAINT competition_sport_settings_pack_fk FOREIGN KEY (sport_code,pack_version)
  REFERENCES sport_pack_versions(sport_code,version);
ALTER TABLE division_sport_settings
  ADD CONSTRAINT division_sport_settings_pack_fk FOREIGN KEY (sport_code,pack_version)
  REFERENCES sport_pack_versions(sport_code,version);

CREATE FUNCTION phase3_validate_settings_scope() RETURNS trigger AS $$
DECLARE expected_sport text;
BEGIN
  SELECT sport_code INTO expected_sport FROM competitions WHERE id=NEW.competition_id;
  IF expected_sport IS NULL OR NEW.sport_code<>expected_sport THEN
    RAISE EXCEPTION 'sport settings must match competition sport';
  END IF;
  IF TG_TABLE_NAME='division_sport_settings' AND NOT EXISTS (
    SELECT 1 FROM divisions WHERE id=(to_jsonb(NEW)->>'division_id')::uuid AND competition_id=NEW.competition_id
  ) THEN RAISE EXCEPTION 'division sport settings scope mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER competition_sport_settings_phase3_scope
BEFORE INSERT OR UPDATE OF competition_id,sport_code ON competition_sport_settings
FOR EACH ROW EXECUTE FUNCTION phase3_validate_settings_scope();
CREATE TRIGGER division_sport_settings_phase3_scope
BEFORE INSERT OR UPDATE OF competition_id,division_id,sport_code ON division_sport_settings
FOR EACH ROW EXECUTE FUNCTION phase3_validate_settings_scope();

ALTER TABLE playing_areas
  ADD COLUMN slot_minutes integer CHECK (slot_minutes BETWEEN 1 AND 1440),
  ADD COLUMN fixed_reserve_slots integer NOT NULL DEFAULT 0 CHECK (fixed_reserve_slots >= 0),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE playing_area_unavailable_intervals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  playing_area_id uuid NOT NULL REFERENCES playing_areas(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  CHECK (ends_at > starts_at),
  FOREIGN KEY (playing_area_id, competition_id) REFERENCES playing_areas(id, competition_id) ON DELETE CASCADE
);

ALTER TABLE format_revisions
  ADD COLUMN parent_revision integer,
  ADD COLUMN recommendation jsonb,
  ADD COLUMN capacity_assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN validation_contract text NOT NULL DEFAULT 'phase2' CHECK (validation_contract IN ('phase2','phase3'));

CREATE TABLE format_validation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  format_revision_id uuid NOT NULL UNIQUE REFERENCES format_revisions(id) ON DELETE CASCADE,
  definition_hash text NOT NULL CHECK (length(definition_hash)=64),
  valid boolean NOT NULL,
  graph_acyclic boolean NOT NULL,
  graph_reachable boolean NOT NULL,
  slots_unambiguous boolean NOT NULL,
  deterministic_match_count integer NOT NULL CHECK (deterministic_match_count >= 0),
  available_match_slots integer NOT NULL CHECK (available_match_slots >= 0),
  required_match_slots integer NOT NULL CHECK (required_match_slots >= 0),
  recommendation_fits_capacity boolean NOT NULL,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  validated_at timestamptz NOT NULL DEFAULT now(),
  validated_by uuid NOT NULL REFERENCES accounts(id)
);

CREATE FUNCTION phase3_available_match_slots(target_competition uuid) RETURNS integer AS $$
DECLARE result integer;
BEGIN
  SELECT GREATEST(0,
    COALESCE(sum(floor(extract(epoch FROM (upper(usable.slot)-lower(usable.slot)))/60/COALESCE(a.slot_minutes,30)))::integer,0)
    - COALESCE((SELECT sum(fixed_reserve_slots)::integer FROM playing_areas WHERE competition_id=target_competition),0))
  INTO result
  FROM playing_areas a
  CROSS JOIN LATERAL unnest(
    COALESCE((SELECT range_agg(tstzrange(w.starts_at,w.ends_at,'[)')) FROM competition_availability_windows w WHERE w.playing_area_id=a.id),'{}'::tstzmultirange)
    - COALESCE((SELECT range_agg(tstzrange(u.starts_at,u.ends_at,'[)')) FROM playing_area_unavailable_intervals u WHERE u.playing_area_id=a.id),'{}'::tstzmultirange)
  ) AS usable(slot)
  WHERE a.competition_id=target_competition;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase3_format_definition_db_valid(definition jsonb) RETURNS boolean AS $$
DECLARE
  duplicate_count integer;
  invalid_count integer;
BEGIN
  IF definition->>'schemaVersion' <> '1'
     OR (definition->>'entryCount')::integer NOT IN (8,12,16,24,48)
     OR jsonb_typeof(definition->'stages') <> 'array'
     OR jsonb_typeof(definition->'matches') <> 'array'
     OR jsonb_array_length(definition->'stages') = 0
     OR jsonb_array_length(definition->'matches') = 0 THEN RETURN false; END IF;
  SELECT count(*)-count(DISTINCT item->>'id') INTO duplicate_count FROM jsonb_array_elements(definition->'matches') item;
  IF duplicate_count <> 0 THEN RETURN false; END IF;
  SELECT count(*) INTO invalid_count
  FROM jsonb_array_elements(definition->'matches') match
  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'stages') stage WHERE stage->>'id'=match->>'stageId')
     OR EXISTS (
       SELECT 1 FROM (VALUES (match->'home'),(match->'away')) source(value)
       WHERE source.value->>'type' IN ('winner','loser') AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(definition->'matches') parent
         WHERE parent->>'id'=source.value->>'matchId'
           AND (parent->>'order')::integer < (match->>'order')::integer
       )
     );
  RETURN invalid_count=0;
EXCEPTION WHEN others THEN RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION phase3_validate_format_evidence() RETURNS trigger AS $$
DECLARE
  revision format_revisions%ROWTYPE;
  actual_slots integer;
  required_slots integer;
BEGIN
  SELECT * INTO revision FROM format_revisions WHERE id=NEW.format_revision_id;
  actual_slots := phase3_available_match_slots(revision.competition_id);
  required_slots := jsonb_array_length(revision.definition->'matches');
  IF NEW.definition_hash<>revision.definition_hash
     OR NOT phase3_format_definition_db_valid(revision.definition)
     OR NOT NEW.valid OR NOT NEW.graph_acyclic OR NOT NEW.graph_reachable OR NOT NEW.slots_unambiguous
     OR NEW.deterministic_match_count<>required_slots OR NEW.required_match_slots<>required_slots
     OR NEW.available_match_slots<>actual_slots
     OR NEW.recommendation_fits_capacity<>(actual_slots>=required_slots) THEN
    RAISE EXCEPTION 'format validation evidence does not match immutable definition and capacity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER format_validation_evidence_phase3_validate
BEFORE INSERT ON format_validation_evidence
FOR EACH ROW EXECUTE FUNCTION phase3_validate_format_evidence();

CREATE TRIGGER format_validation_evidence_phase3_immutable
BEFORE UPDATE OR DELETE ON format_validation_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

CREATE FUNCTION phase3_prevent_format_revision_content_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
     OR NEW.division_id IS DISTINCT FROM OLD.division_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.validation_contract IS DISTINCT FROM OLD.validation_contract THEN
    RAISE EXCEPTION 'format revision content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER format_revisions_phase3_content_immutable
BEFORE UPDATE ON format_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_format_revision_content_mutation();

CREATE FUNCTION phase3_require_validated_format_publish() RETURNS trigger AS $$
BEGIN
  IF NEW.status='published' AND (NEW.validation_contract='phase3' OR NEW.definition ? 'schemaVersion')
     AND (TG_OP='INSERT' OR OLD.status<>'published') AND NOT EXISTS (
    SELECT 1 FROM format_validation_evidence e
    WHERE e.format_revision_id=NEW.id
      AND e.definition_hash=NEW.definition_hash
      AND e.valid AND e.graph_acyclic AND e.graph_reachable
      AND e.slots_unambiguous AND e.recommendation_fits_capacity
      AND e.available_match_slots=phase3_available_match_slots(NEW.competition_id)
      AND phase3_format_definition_db_valid(NEW.definition)
  ) THEN
    RAISE EXCEPTION 'format publish requires matching structural validation evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER format_revisions_phase3_publish_guard
BEFORE INSERT OR UPDATE ON format_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_require_validated_format_publish();

ALTER TABLE standings_snapshots ADD COLUMN calculation_input_hash text;
UPDATE standings_snapshots
SET calculation_input_hash=pg_catalog.md5(standings::text || ':' || result_version::text)
  || pg_catalog.md5('phase3:' || standings::text || ':' || result_version::text)
WHERE calculation_input_hash IS NULL;
ALTER TABLE standings_snapshots
  ALTER COLUMN calculation_input_hash SET NOT NULL,
  ADD CONSTRAINT standings_snapshots_input_hash_check CHECK (length(calculation_input_hash)=64);

CREATE FUNCTION phase3_default_standings_input_hash() RETURNS trigger AS $$
BEGIN
  IF NEW.calculation_input_hash IS NULL THEN
    NEW.calculation_input_hash := pg_catalog.md5(NEW.standings::text || ':' || NEW.result_version::text)
      || pg_catalog.md5('phase3:' || NEW.standings::text || ':' || NEW.result_version::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER standings_snapshots_phase3_default_hash
BEFORE INSERT ON standings_snapshots
FOR EACH ROW EXECUTE FUNCTION phase3_default_standings_input_hash();
