ALTER TABLE scheduled_matches
  ADD COLUMN division_id uuid;

UPDATE scheduled_matches scheduled
SET division_id=match.division_id
FROM matches match
WHERE match.id=scheduled.match_id
  AND match.competition_id=scheduled.competition_id;

DO $$
DECLARE invalid_assignments text;
BEGIN
  SELECT string_agg(
    scheduled.schedule_revision_id::text||'/'||scheduled.match_id::text,
    ',' ORDER BY scheduled.schedule_revision_id,scheduled.match_id
  )
  INTO invalid_assignments
  FROM scheduled_matches scheduled
  LEFT JOIN divisions division
    ON division.id=scheduled.division_id
   AND division.competition_id=scheduled.competition_id
  LEFT JOIN division_entries home_entry
    ON home_entry.id=scheduled.home_entry_id
   AND home_entry.division_id=scheduled.division_id
  LEFT JOIN division_entries away_entry
    ON away_entry.id=scheduled.away_entry_id
   AND away_entry.division_id=scheduled.division_id
  WHERE scheduled.division_id IS NULL
     OR division.id IS NULL
     OR (scheduled.home_entry_id IS NOT NULL AND home_entry.id IS NULL)
     OR (scheduled.away_entry_id IS NOT NULL AND away_entry.id IS NULL);

  IF invalid_assignments IS NOT NULL THEN
    RAISE EXCEPTION
      'scheduled participant snapshots must belong to the authoritative match division and competition; invalid assignments: %',
      invalid_assignments;
  END IF;
END;
$$;

ALTER TABLE scheduled_matches
  ALTER COLUMN division_id SET NOT NULL,
  DROP CONSTRAINT scheduled_matches_home_entry_id_fkey,
  DROP CONSTRAINT scheduled_matches_away_entry_id_fkey,
  ADD CONSTRAINT scheduled_matches_division_competition_fkey
    FOREIGN KEY (division_id,competition_id)
    REFERENCES divisions(id,competition_id) ON DELETE CASCADE,
  ADD CONSTRAINT scheduled_matches_home_entry_division_fkey
    FOREIGN KEY (home_entry_id,division_id)
    REFERENCES division_entries(id,division_id) ON DELETE RESTRICT,
  ADD CONSTRAINT scheduled_matches_away_entry_division_fkey
    FOREIGN KEY (away_entry_id,division_id)
    REFERENCES division_entries(id,division_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION gate_c_snapshot_schedule_participants()
RETURNS trigger AS $$
BEGIN
  SELECT match.division_id,match.home_entry_id,match.away_entry_id
  INTO NEW.division_id,NEW.home_entry_id,NEW.away_entry_id
  FROM matches match
  WHERE match.id=NEW.match_id AND match.competition_id=NEW.competition_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled match must reference an authoritative competition match';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION gate_c_guard_schedule_participant_snapshot_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.schedule_revision_id IS DISTINCT FROM OLD.schedule_revision_id
     OR NEW.match_id IS DISTINCT FROM OLD.match_id
     OR NEW.competition_id IS DISTINCT FROM OLD.competition_id
     OR NEW.division_id IS DISTINCT FROM OLD.division_id
     OR NEW.home_entry_id IS DISTINCT FROM OLD.home_entry_id
     OR NEW.away_entry_id IS DISTINCT FROM OLD.away_entry_id THEN
    RAISE EXCEPTION 'scheduled participant snapshot identity is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scheduled_matches_participant_snapshot_immutable
BEFORE UPDATE OF
  schedule_revision_id,match_id,competition_id,division_id,home_entry_id,away_entry_id
ON scheduled_matches
FOR EACH ROW EXECUTE FUNCTION gate_c_guard_schedule_participant_snapshot_update();
