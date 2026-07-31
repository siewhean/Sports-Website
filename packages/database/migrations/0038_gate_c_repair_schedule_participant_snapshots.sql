-- Gate C4 repair-derived schedule revisions.
--
-- Published repair schedules must retain the participant decisions that were
-- reviewed by the organiser. The ordinary Gate C trigger snapshots participants
-- from the immutable format match, which is correct for initial schedules but
-- would otherwise discard a repair revision's resolved downstream participants.

ALTER TABLE schedule_revisions
  ADD COLUMN source_repair_revision_id uuid,
  ADD CONSTRAINT schedule_revisions_repair_source_fkey
    FOREIGN KEY (source_repair_revision_id,competition_id)
    REFERENCES schedule_repair_revisions(id,competition_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX schedule_revisions_one_per_repair_revision
ON schedule_revisions(source_repair_revision_id)
WHERE source_repair_revision_id IS NOT NULL;

CREATE FUNCTION gate_c_resolved_repair_entry(
  target_repair_revision uuid,
  target_match uuid,
  target_slot text,
  fallback_entry uuid
) RETURNS uuid AS $$
DECLARE
  action_row schedule_repair_actions%ROWTYPE;
  decision_row schedule_repair_decisions%ROWTYPE;
BEGIN
  SELECT * INTO action_row
  FROM schedule_repair_actions
  WHERE repair_revision_id=target_repair_revision
    AND match_id=target_match
    AND slot=target_slot;

  IF NOT FOUND THEN
    RETURN fallback_entry;
  END IF;

  SELECT * INTO decision_row
  FROM schedule_repair_decisions
  WHERE repair_action_id=action_row.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'repair-derived schedule requires a retained decision for every affected participant slot';
  END IF;

  IF decision_row.decision='accept_proposed' THEN
    RETURN action_row.proposed_entry_id;
  ELSIF decision_row.decision='set_manual_entry' THEN
    RETURN decision_row.selected_entry_id;
  ELSIF decision_row.decision IN ('keep_current','leave_protected') THEN
    RETURN action_row.current_entry_id;
  END IF;

  RAISE EXCEPTION 'repair-derived schedule contains an unsupported participant decision';
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION gate_c_snapshot_schedule_participants()
RETURNS trigger AS $$
DECLARE
  authoritative_match matches%ROWTYPE;
  schedule_revision schedule_revisions%ROWTYPE;
  repair_revision schedule_repair_revisions%ROWTYPE;
  resolved_home uuid;
  resolved_away uuid;
BEGIN
  SELECT * INTO authoritative_match
  FROM matches match
  WHERE match.id=NEW.match_id AND match.competition_id=NEW.competition_id;

  IF authoritative_match.id IS NULL THEN
    RAISE EXCEPTION 'scheduled match must reference an authoritative competition match';
  END IF;

  SELECT * INTO schedule_revision
  FROM schedule_revisions revision
  WHERE revision.id=NEW.schedule_revision_id
    AND revision.competition_id=NEW.competition_id;

  IF schedule_revision.id IS NULL THEN
    RAISE EXCEPTION 'scheduled match must reference a competition schedule revision';
  END IF;

  NEW.division_id:=authoritative_match.division_id;

  IF schedule_revision.source_repair_revision_id IS NULL THEN
    NEW.home_entry_id:=authoritative_match.home_entry_id;
    NEW.away_entry_id:=authoritative_match.away_entry_id;
    RETURN NEW;
  END IF;

  SELECT * INTO repair_revision
  FROM schedule_repair_revisions revision
  WHERE revision.id=schedule_revision.source_repair_revision_id
    AND revision.competition_id=NEW.competition_id;

  IF repair_revision.id IS NULL OR repair_revision.status<>'ready' OR repair_revision.publication_fingerprint IS NULL THEN
    RAISE EXCEPTION 'repair-derived schedule requires a ready fingerprinted repair revision';
  END IF;

  resolved_home:=gate_c_resolved_repair_entry(
    repair_revision.id,
    authoritative_match.id,
    'home',
    authoritative_match.home_entry_id
  );
  resolved_away:=gate_c_resolved_repair_entry(
    repair_revision.id,
    authoritative_match.id,
    'away',
    authoritative_match.away_entry_id
  );

  IF authoritative_match.state IN ('in_progress','final','corrected')
     AND (resolved_home IS DISTINCT FROM authoritative_match.home_entry_id
       OR resolved_away IS DISTINCT FROM authoritative_match.away_entry_id) THEN
    RAISE EXCEPTION 'started or finalised match participants cannot be changed by schedule repair';
  END IF;

  IF resolved_home IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM division_entries entry
    WHERE entry.id=resolved_home AND entry.division_id=authoritative_match.division_id
  ) THEN
    RAISE EXCEPTION 'repair-resolved home participant is outside the match division';
  END IF;

  IF resolved_away IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM division_entries entry
    WHERE entry.id=resolved_away AND entry.division_id=authoritative_match.division_id
  ) THEN
    RAISE EXCEPTION 'repair-resolved away participant is outside the match division';
  END IF;

  NEW.home_entry_id:=resolved_home;
  NEW.away_entry_id:=resolved_away;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION gate_c_guard_schedule_repair_source_update() RETURNS trigger AS $$
BEGIN
  IF NEW.source_repair_revision_id IS DISTINCT FROM OLD.source_repair_revision_id THEN
    RAISE EXCEPTION 'schedule repair source lineage is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedule_revisions_repair_source_immutable
BEFORE UPDATE OF source_repair_revision_id ON schedule_revisions
FOR EACH ROW EXECUTE FUNCTION gate_c_guard_schedule_repair_source_update();
