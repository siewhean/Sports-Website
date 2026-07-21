ALTER TABLE competitions
  ADD COLUMN capacity_revision bigint NOT NULL DEFAULT 1 CHECK (capacity_revision > 0),
  ADD COLUMN capacity_timezone text;

ALTER TABLE competition_availability_windows
  ADD COLUMN source_date date,
  ADD COLUMN source_start_time time without time zone,
  ADD COLUMN source_end_time time without time zone,
  ADD COLUMN source_cross_midnight boolean;

ALTER TABLE playing_area_unavailable_intervals
  ADD COLUMN source_date date,
  ADD COLUMN source_start_time time without time zone,
  ADD COLUMN source_end_time time without time zone,
  ADD COLUMN source_cross_midnight boolean;

ALTER TABLE competition_availability_windows DISABLE TRIGGER competition_availability_phase3_archive_guard;
UPDATE competition_availability_windows available
SET source_date = (available.starts_at AT TIME ZONE competition.timezone)::date,
    source_start_time = (available.starts_at AT TIME ZONE competition.timezone)::time,
    source_end_time = (available.ends_at AT TIME ZONE competition.timezone)::time,
    source_cross_midnight = (available.ends_at AT TIME ZONE competition.timezone)::date
      > (available.starts_at AT TIME ZONE competition.timezone)::date
FROM competitions competition
WHERE competition.id = available.competition_id;
ALTER TABLE competition_availability_windows ENABLE TRIGGER competition_availability_phase3_archive_guard;

ALTER TABLE playing_area_unavailable_intervals DISABLE TRIGGER playing_area_unavailable_phase3_archive_guard;
UPDATE playing_area_unavailable_intervals unavailable
SET source_date = (unavailable.starts_at AT TIME ZONE competition.timezone)::date,
    source_start_time = (unavailable.starts_at AT TIME ZONE competition.timezone)::time,
    source_end_time = (unavailable.ends_at AT TIME ZONE competition.timezone)::time,
    source_cross_midnight = (unavailable.ends_at AT TIME ZONE competition.timezone)::date
      > (unavailable.starts_at AT TIME ZONE competition.timezone)::date
FROM competitions competition
WHERE competition.id = unavailable.competition_id;
ALTER TABLE playing_area_unavailable_intervals ENABLE TRIGGER playing_area_unavailable_phase3_archive_guard;

ALTER TABLE competition_availability_windows
  ALTER COLUMN source_date SET NOT NULL,
  ALTER COLUMN source_start_time SET NOT NULL,
  ALTER COLUMN source_end_time SET NOT NULL,
  ALTER COLUMN source_cross_midnight SET NOT NULL;

ALTER TABLE playing_area_unavailable_intervals
  ALTER COLUMN source_date SET NOT NULL,
  ALTER COLUMN source_start_time SET NOT NULL,
  ALTER COLUMN source_end_time SET NOT NULL,
  ALTER COLUMN source_cross_midnight SET NOT NULL;

CREATE FUNCTION phase3_default_capacity_source_fields() RETURNS trigger AS $$
DECLARE source_timezone text;
BEGIN
  SELECT COALESCE(capacity_timezone, timezone) INTO source_timezone
  FROM competitions WHERE id = NEW.competition_id;
  IF source_timezone IS NULL THEN RAISE EXCEPTION 'competition does not exist'; END IF;
  NEW.source_date := COALESCE(NEW.source_date, (NEW.starts_at AT TIME ZONE source_timezone)::date);
  NEW.source_start_time := COALESCE(NEW.source_start_time, (NEW.starts_at AT TIME ZONE source_timezone)::time);
  NEW.source_end_time := COALESCE(NEW.source_end_time, (NEW.ends_at AT TIME ZONE source_timezone)::time);
  NEW.source_cross_midnight := COALESCE(
    NEW.source_cross_midnight,
    (NEW.ends_at AT TIME ZONE source_timezone)::date > (NEW.starts_at AT TIME ZONE source_timezone)::date
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER competition_availability_phase3_source_fields
BEFORE INSERT ON competition_availability_windows
FOR EACH ROW EXECUTE FUNCTION phase3_default_capacity_source_fields();

CREATE TRIGGER playing_area_unavailable_phase3_source_fields
BEFORE INSERT ON playing_area_unavailable_intervals
FOR EACH ROW EXECUTE FUNCTION phase3_default_capacity_source_fields();

DROP TRIGGER sport_pack_versions_phase3_immutable ON sport_pack_versions;

ALTER TABLE sport_pack_versions
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active')),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN activated_at timestamptz DEFAULT now(),
  ADD COLUMN activated_by uuid REFERENCES accounts(id);

ALTER TABLE sport_pack_versions
  ADD CONSTRAINT sport_pack_versions_activation_shape CHECK (
    (status = 'draft' AND activated_at IS NULL AND activated_by IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL)
  );

CREATE FUNCTION phase3_guard_sport_pack_lifecycle() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sport pack versions are append-only'; END IF;
  IF OLD.status = 'active' THEN RAISE EXCEPTION 'active sport pack versions are immutable'; END IF;
  IF NEW.sport_code IS DISTINCT FROM OLD.sport_code
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sport pack version content is immutable';
  END IF;
  IF OLD.status <> 'draft' OR NEW.status <> 'active'
     OR NEW.revision <> OLD.revision + 1
     OR NEW.activated_at IS NULL OR NEW.activated_by IS NULL THEN
    RAISE EXCEPTION 'sport pack lifecycle transition is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sport_pack_versions_phase3_lifecycle_guard
BEFORE UPDATE OR DELETE ON sport_pack_versions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_sport_pack_lifecycle();
