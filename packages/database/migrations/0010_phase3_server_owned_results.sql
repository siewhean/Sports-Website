-- Server-owned Phase 3 standings provenance and controlled advancement.
-- Forward-only: earlier Phase 3 migrations remain immutable.

-- The Phase 2 scoring vertical slice still persists its legacy balanced-format
-- document under the explicit phase2 validation contract. Keep that deployed
-- contract readable while the strict Phase 3 graph guard remains mandatory for
-- every Phase 3 revision.
CREATE OR REPLACE FUNCTION phase3_reject_invalid_format_revision() RETURNS trigger AS $$
BEGIN
  IF jsonb_typeof(NEW.definition) = 'string' THEN
    NEW.definition := (NEW.definition #>> '{}')::jsonb;
  END IF;
  IF NEW.validation_contract = 'phase2' THEN RETURN NEW; END IF;
  IF NOT phase3_format_definition_db_valid(NEW.definition) THEN
    RAISE EXCEPTION 'format revision definition is structurally invalid';
  END IF;
  IF NEW.definition_hash <> encode(pg_catalog.sha256(convert_to(phase3_canonical_jsonb(NEW.definition), 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'format revision definition hash does not match definition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Preserve the deployed Phase 2 publication transition, but only after a real
-- schedule revision has been published. Phase 3 API lifecycle commands still
-- cannot move a draft directly to the legacy active state.
CREATE OR REPLACE FUNCTION phase3_guard_competition_lifecycle() RETURNS trigger AS $$
DECLARE division_count integer;
BEGIN
  IF NEW.status = OLD.status THEN
    IF NEW.archived_from_status IS DISTINCT FROM OLD.archived_from_status THEN
      RAISE EXCEPTION 'archived lifecycle state cannot change without a status transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'archived' AND OLD.status <> 'archived' THEN
    IF NEW.archived_from_status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'archive must preserve the prior competition status';
    END IF;
  ELSIF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    IF OLD.archived_from_status IS NULL OR NEW.status IS DISTINCT FROM OLD.archived_from_status
       OR NEW.archived_from_status IS NOT NULL THEN
      RAISE EXCEPTION 'restore must return to the archived competition status';
    END IF;
  ELSIF OLD.status = 'draft' AND NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM competition_publications
    WHERE competition_id=NEW.id AND published_schedule_revision_id IS NOT NULL
  ) THEN
    NULL;
  ELSIF NOT (
    (OLD.status = 'draft' AND NEW.status = 'ready')
    OR (OLD.status = 'ready' AND NEW.status IN ('draft','published'))
    OR (OLD.status = 'published' AND NEW.status = 'live')
    OR (OLD.status = 'active' AND NEW.status IN ('live','completed'))
    OR (OLD.status = 'live' AND NEW.status = 'completed')
  ) THEN
    RAISE EXCEPTION 'competition lifecycle transition is not allowed';
  END IF;
  IF NEW.status = 'ready' THEN
    SELECT count(*) INTO division_count FROM divisions WHERE competition_id=NEW.id;
    IF division_count = 0 THEN RAISE EXCEPTION 'competition needs at least one division before ready'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE standings_snapshots
  DROP CONSTRAINT standings_snapshots_calculation_provenance_check;

ALTER TABLE standings_snapshots
  ALTER COLUMN calculation_provenance DROP DEFAULT,
  ADD COLUMN source_result_hash text,
  ADD COLUMN settings_version text,
  ADD COLUMN snapshot_fingerprint text,
  ADD CONSTRAINT standings_snapshots_phase3_provenance_check CHECK (
    (calculation_provenance = 'client_supplied_unverified'
      AND source_result_hash IS NULL AND settings_version IS NULL AND snapshot_fingerprint IS NULL)
    OR
    (calculation_provenance = 'server_calculated'
      AND length(source_result_hash) = 64
      AND btrim(settings_version) <> ''
      AND length(snapshot_fingerprint) >= 16)
  );

CREATE FUNCTION phase3_standings_source_hash(
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
      SELECT string_agg(concat_ws(':', e.id::text, e.status, COALESCE(e.seed::text,''), e.updated_at::text), ',' ORDER BY e.id)
      FROM division_entries e WHERE e.division_id = target_division
    ), ''),
    COALESCE((
      SELECT string_agg(concat_ws(':', latest.match_id::text, latest.result_version::text,
        latest.through_sequence::text, latest.home_score::text, latest.away_score::text,
        latest.state, pg_catalog.md5(latest.snapshot::text)), ',' ORDER BY latest.match_id)
      FROM (
        SELECT DISTINCT ON (m.id) s.match_id,s.result_version,s.through_sequence,
          s.home_score,s.away_score,s.state,s.snapshot
        FROM matches m JOIN match_result_snapshots s ON s.match_id=m.id
        WHERE m.competition_id=target_competition AND m.division_id=target_division
          AND s.result_version <= target_result_version
        ORDER BY m.id,s.result_version DESC
      ) latest
    ), ''),
    COALESCE((
      SELECT concat_ws(':', sport_code, pack_version, pack_schema_version::text,
        pg_catalog.md5(recommended_snapshot::text),
        pg_catalog.md5(settings_override::text))
      FROM competition_sport_settings WHERE competition_id=target_competition
    ), ''),
    COALESCE((
      SELECT concat_ws(':', pack_version, pg_catalog.md5(settings_override::text))
      FROM division_sport_settings WHERE division_id=target_division
    ), '')
  ) INTO material;
  RETURN pg_catalog.md5(material) || pg_catalog.md5('phase3:' || material);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION phase3_verify_server_standings_snapshot() RETURNS trigger AS $$
DECLARE published_version integer;
DECLARE expected_hash text;
BEGIN
  IF NEW.calculation_provenance IS DISTINCT FROM 'server_calculated' THEN
    RAISE EXCEPTION 'new standings snapshots must be server calculated';
  END IF;
  IF current_setting('matchday.server_results', true) <> 'on' THEN
    RAISE EXCEPTION 'standings snapshots require the server results transaction';
  END IF;
  SELECT result_version INTO published_version FROM competition_publications
    WHERE competition_id=NEW.competition_id FOR UPDATE;
  IF published_version IS NULL OR NEW.result_version <> published_version THEN
    RAISE EXCEPTION 'standings snapshot result version is not the current persisted result state';
  END IF;
  expected_hash := phase3_standings_source_hash(NEW.competition_id,NEW.division_id,NEW.result_version);
  IF NEW.source_result_hash IS DISTINCT FROM expected_hash
     OR NEW.calculation_input_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION 'standings snapshot provenance does not match persisted result state';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER standings_snapshots_phase3_server_provenance
BEFORE INSERT ON standings_snapshots
FOR EACH ROW EXECUTE FUNCTION phase3_verify_server_standings_snapshot();

CREATE TABLE advancement_slots (
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('home','away')),
  entry_id uuid REFERENCES division_entries(id),
  control text NOT NULL CHECK (control IN ('manual','automatic')),
  controlled_by_rule_id text,
  source_snapshot_id uuid REFERENCES standings_snapshots(id) ON DELETE RESTRICT,
  source_fingerprint text,
  result_version integer NOT NULL CHECK (result_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id,slot),
  FOREIGN KEY (division_id,competition_id) REFERENCES divisions(id,competition_id),
  FOREIGN KEY (match_id,competition_id) REFERENCES matches(id,competition_id),
  FOREIGN KEY (entry_id,division_id) REFERENCES division_entries(id,division_id),
  CHECK (
    (control='manual' AND controlled_by_rule_id IS NULL AND source_snapshot_id IS NULL AND source_fingerprint IS NULL)
    OR
    (control='automatic' AND btrim(controlled_by_rule_id) <> ''
      AND ((entry_id IS NULL AND source_snapshot_id IS NULL AND source_fingerprint IS NULL)
        OR (entry_id IS NOT NULL AND source_snapshot_id IS NOT NULL AND length(source_fingerprint)>=16)))
  )
);

CREATE INDEX advancement_slots_division_idx ON advancement_slots(division_id,result_version);

CREATE TABLE advancement_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  result_version integer NOT NULL CHECK (result_version > 0),
  rule_id text NOT NULL,
  target_slot_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id,result_version,rule_id,target_slot_id,reason),
  FOREIGN KEY (division_id,competition_id) REFERENCES divisions(id,competition_id)
);

CREATE FUNCTION phase3_prevent_advancement_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'advancement conflict history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER advancement_conflicts_phase3_immutable
BEFORE UPDATE OR DELETE ON advancement_conflicts
FOR EACH ROW EXECUTE FUNCTION phase3_prevent_advancement_history_mutation();

CREATE TRIGGER advancement_slots_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON advancement_slots
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER advancement_conflicts_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON advancement_conflicts
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
