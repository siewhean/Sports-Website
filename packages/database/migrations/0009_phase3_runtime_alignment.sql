-- Phase 3 runtime/domain alignment. This migration is forward-only; deployed
-- Phase 3 migrations remain immutable.

ALTER TABLE competitions
  ADD CONSTRAINT competitions_phase3_required_text CHECK (
    btrim(name) <> '' AND btrim(timezone) <> '' AND btrim(locale) <> ''
  ),
  ADD CONSTRAINT competitions_phase3_date_order CHECK (ends_on >= starts_on);

ALTER TABLE entry_imports
  ADD COLUMN rolled_back_at timestamptz,
  ADD COLUMN rolled_back_by uuid REFERENCES accounts(id),
  ADD COLUMN rollback_request_id text,
  ADD CONSTRAINT entry_imports_phase3_rollback_state CHECK (
    (rolled_back_at IS NULL AND rolled_back_by IS NULL AND rollback_request_id IS NULL)
    OR (rolled_back_at IS NOT NULL AND rolled_back_by IS NOT NULL AND btrim(rollback_request_id) <> '')
  );

ALTER TABLE division_entries
  ADD COLUMN withdrawal_reason text,
  ADD COLUMN entry_import_id uuid REFERENCES entry_imports(id);

CREATE FUNCTION phase3_unwrap_legacy_jsonb(value jsonb) RETURNS jsonb AS $$
BEGIN
  IF jsonb_typeof(value) = 'string' THEN RETURN (value #>> '{}')::jsonb; END IF;
  RETURN value;
EXCEPTION WHEN others THEN
  RETURN value;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Older Phase 3 runtime writes encoded JSON once before handing values to the
-- PostgreSQL driver. Normalize those rows before enforcing object/array shape.
UPDATE division_entries
SET metadata = phase3_unwrap_legacy_jsonb(metadata),
    availability = phase3_unwrap_legacy_jsonb(availability)
WHERE jsonb_typeof(metadata) = 'string' OR jsonb_typeof(availability) = 'string';

UPDATE division_entries
SET withdrawal_reason = 'Migrated withdrawal'
WHERE status = 'withdrawn' AND withdrawal_reason IS NULL;

ALTER TABLE division_entries
  ADD CONSTRAINT division_entries_phase3_withdrawal_reason CHECK (
    status <> 'withdrawn' OR (withdrawal_reason IS NOT NULL AND btrim(withdrawal_reason) <> '')
  );

CREATE FUNCTION phase3_guard_competition_lifecycle() RETURNS trigger AS $$
DECLARE
  division_count integer;
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
    SELECT count(*) INTO division_count FROM divisions WHERE competition_id = NEW.id;
    IF division_count = 0 THEN
      RAISE EXCEPTION 'competition needs at least one division before ready';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER competitions_phase3_lifecycle_guard
BEFORE UPDATE OF status,archived_from_status ON competitions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_competition_lifecycle();

CREATE FUNCTION phase3_assert_competition_mutable(target_competition uuid) RETURNS void AS $$
DECLARE target_status text;
BEGIN
  SELECT status INTO target_status FROM competitions WHERE id = target_competition FOR UPDATE;
  IF target_status IS NULL THEN RAISE EXCEPTION 'competition does not exist'; END IF;
  IF target_status = 'archived' THEN RAISE EXCEPTION 'archived competitions are immutable'; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION phase3_guard_nested_competition_mutation() RETURNS trigger AS $$
DECLARE
  old_value jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_value jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  old_competition uuid;
  new_competition uuid;
BEGIN
  IF old_value ? 'competition_id' THEN
    old_competition := (old_value->>'competition_id')::uuid;
  ELSIF TG_TABLE_NAME = 'division_entries' THEN
    SELECT competition_id INTO old_competition FROM divisions WHERE id = (old_value->>'division_id')::uuid;
  ELSIF TG_TABLE_NAME = 'format_validation_evidence' THEN
    SELECT competition_id INTO old_competition FROM format_revisions WHERE id = (old_value->>'format_revision_id')::uuid;
  END IF;

  IF new_value ? 'competition_id' THEN
    new_competition := (new_value->>'competition_id')::uuid;
  ELSIF TG_TABLE_NAME = 'division_entries' THEN
    SELECT competition_id INTO new_competition FROM divisions WHERE id = (new_value->>'division_id')::uuid;
  ELSIF TG_TABLE_NAME = 'format_validation_evidence' THEN
    SELECT competition_id INTO new_competition FROM format_revisions WHERE id = (new_value->>'format_revision_id')::uuid;
  END IF;

  -- PostgreSQL removes the parent competition before firing child ON DELETE CASCADE
  -- triggers. A missing parent is therefore legitimate only for a child DELETE;
  -- inserts, updates, and ordinary child deletes still require a mutable parent.
  IF old_competition IS NOT NULL AND (
    TG_OP <> 'DELETE' OR EXISTS (SELECT 1 FROM competitions WHERE id = old_competition)
  ) THEN
    PERFORM phase3_assert_competition_mutable(old_competition);
  END IF;
  IF new_competition IS NOT NULL AND new_competition IS DISTINCT FROM old_competition THEN
    PERFORM phase3_assert_competition_mutable(new_competition);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER divisions_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON divisions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER division_entries_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON division_entries
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER competition_sport_settings_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON competition_sport_settings
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER division_sport_settings_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON division_sport_settings
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER playing_areas_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON playing_areas
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER competition_availability_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON competition_availability_windows
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER playing_area_unavailable_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON playing_area_unavailable_intervals
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER format_revisions_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON format_revisions
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER format_validation_evidence_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON format_validation_evidence
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER standings_snapshots_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON standings_snapshots
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();
CREATE TRIGGER entry_imports_phase3_archive_guard BEFORE INSERT OR UPDATE OR DELETE ON entry_imports
FOR EACH ROW EXECUTE FUNCTION phase3_guard_nested_competition_mutation();

CREATE FUNCTION phase3_guard_entry_import_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'entry import records are append-only'; END IF;
  IF OLD.rolled_back_at IS NOT NULL THEN RAISE EXCEPTION 'rolled-back entry imports are immutable'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.competition_id IS DISTINCT FROM OLD.competition_id
     OR NEW.division_id IS DISTINCT FROM OLD.division_id OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.mapping IS DISTINCT FROM OLD.mapping OR NEW.row_count IS DISTINCT FROM OLD.row_count
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'entry import source records are immutable';
  END IF;
  IF NEW.rolled_back_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM division_entries WHERE entry_import_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'entry import cannot be marked rolled back while imported entries remain';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entry_imports_phase3_mutation_guard
BEFORE UPDATE OR DELETE ON entry_imports
FOR EACH ROW EXECUTE FUNCTION phase3_guard_entry_import_mutation();

CREATE FUNCTION phase3_entry_availability_valid(value jsonb) RETURNS boolean AS $$
DECLARE item jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'array' THEN RETURN false; END IF;
  FOR item IN SELECT jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item) <> 'object'
       OR (SELECT count(*) <> 2 OR NOT bool_and(key = ANY (ARRAY['start','end'])) FROM jsonb_object_keys(item) key)
       OR jsonb_typeof(item->'start') <> 'string' OR jsonb_typeof(item->'end') <> 'string'
       OR (item->>'start')::timestamptz >= (item->>'end')::timestamptz THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE division_entries
  ADD CONSTRAINT division_entries_phase3_metadata_shape CHECK (jsonb_typeof(metadata) = 'object'),
  ADD CONSTRAINT division_entries_phase3_availability_shape CHECK (phase3_entry_availability_valid(availability));

CREATE UNIQUE INDEX division_entries_phase3_replacement_unique
ON division_entries(replacement_entry_id) WHERE replacement_entry_id IS NOT NULL;
CREATE UNIQUE INDEX division_entries_phase3_replaces_unique
ON division_entries(replaces_entry_id) WHERE replaces_entry_id IS NOT NULL;

CREATE FUNCTION phase3_validate_replacement_lineage() RETURNS trigger AS $$
DECLARE affected uuid;
BEGIN
  FOREACH affected IN ARRAY ARRAY[
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.replacement_entry_id ELSE NEW.replacement_entry_id END,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.replaces_entry_id ELSE NEW.replaces_entry_id END
  ] LOOP
    IF affected IS NULL THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM division_entries source
      LEFT JOIN division_entries replacement ON replacement.id = source.replacement_entry_id
      WHERE source.id = affected AND source.replacement_entry_id IS NOT NULL
        AND (source.status <> 'replaced' OR replacement.id IS NULL
             OR replacement.division_id <> source.division_id OR replacement.replaces_entry_id <> source.id)
    ) OR EXISTS (
      SELECT 1 FROM division_entries replacement
      LEFT JOIN division_entries source ON source.id = replacement.replaces_entry_id
      WHERE replacement.id = affected AND replacement.replaces_entry_id IS NOT NULL
        AND (source.id IS NULL OR source.status <> 'replaced'
             OR source.division_id <> replacement.division_id OR source.replacement_entry_id <> replacement.id)
    ) THEN
      RAISE EXCEPTION 'entry replacement lineage is inconsistent';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER division_entries_phase3_lineage_guard
AFTER INSERT OR UPDATE OR DELETE ON division_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION phase3_validate_replacement_lineage();

-- Before Phase 3 alignment, playing-area slot duration was nullable and the
-- capacity query treated NULL as 30 minutes. Preserve that deployed behavior,
-- preferring the competition's stored sport setting when one exists, then fail
-- the migration deterministically if legacy explicit durations conflict.
UPDATE playing_areas area
SET slot_minutes = COALESCE(
  (SELECT settings.slot_minutes FROM competition_sport_settings settings
   WHERE settings.competition_id = area.competition_id),
  (SELECT min(peer.slot_minutes) FROM playing_areas peer
   WHERE peer.competition_id = area.competition_id AND peer.slot_minutes IS NOT NULL),
  30
)
WHERE area.slot_minutes IS NULL;

DO $$
DECLARE conflicting_competition uuid;
BEGIN
  SELECT competition_id INTO conflicting_competition
  FROM playing_areas
  GROUP BY competition_id
  HAVING count(DISTINCT slot_minutes) > 1
  ORDER BY competition_id
  LIMIT 1;

  IF conflicting_competition IS NOT NULL THEN
    RAISE EXCEPTION 'playing areas have conflicting slot durations for competition %', conflicting_competition;
  END IF;
END;
$$;

ALTER TABLE playing_areas ALTER COLUMN slot_minutes SET NOT NULL;

CREATE FUNCTION phase3_enforce_competition_slot_minutes() RETURNS trigger AS $$
BEGIN
  PERFORM phase3_assert_competition_mutable(NEW.competition_id);
  IF NEW.slot_minutes IS NULL THEN RAISE EXCEPTION 'slot duration is required'; END IF;
  IF EXISTS (
    SELECT 1 FROM playing_areas
    WHERE competition_id = NEW.competition_id AND id <> NEW.id AND slot_minutes <> NEW.slot_minutes
  ) THEN
    RAISE EXCEPTION 'all playing areas must use one competition slot duration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER playing_areas_phase3_slot_duration_guard
BEFORE INSERT OR UPDATE OF competition_id,slot_minutes ON playing_areas
FOR EACH ROW EXECUTE FUNCTION phase3_enforce_competition_slot_minutes();
