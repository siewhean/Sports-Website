CREATE TABLE competitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  created_by uuid NOT NULL REFERENCES accounts(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  sport_code text NOT NULL DEFAULT 'canoe_polo' CHECK (sport_code = 'canoe_polo'),
  timezone text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug),
  CHECK (ends_on >= starts_on)
);

CREATE INDEX competitions_organisation_idx ON competitions(organisation_id, created_at DESC);

CREATE TABLE competition_sport_settings (
  competition_id uuid PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
  period_count smallint NOT NULL DEFAULT 2 CHECK (period_count = 2),
  period_minutes smallint NOT NULL DEFAULT 10 CHECK (period_minutes BETWEEN 1 AND 60),
  slot_minutes smallint NOT NULL DEFAULT 30 CHECK (slot_minutes = 30),
  points_win smallint NOT NULL DEFAULT 3 CHECK (points_win >= 0),
  points_draw smallint NOT NULL DEFAULT 1 CHECK (points_draw >= 0),
  points_loss smallint NOT NULL DEFAULT 0 CHECK (points_loss >= 0),
  tiebreak_order jsonb NOT NULL DEFAULT '["points","goal_difference","goals_for","head_to_head","discipline","name"]'::jsonb,
  discipline_weights jsonb NOT NULL DEFAULT '{"green":0,"yellow":1,"red":3}'::jsonb,
  customised boolean NOT NULL DEFAULT false,
  locked_at timestamptz,
  updated_by uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE divisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  team_limit smallint NOT NULL CHECK (team_limit IN (8, 16)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_id, name),
  UNIQUE (id, competition_id)
);

CREATE TABLE division_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  seed smallint NOT NULL CHECK (seed BETWEEN 1 AND 16),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id, seed),
  UNIQUE (division_id, name),
  UNIQUE (id, division_id)
);

CREATE FUNCTION enforce_division_entry_seed_limit() RETURNS trigger AS $$
DECLARE
  allowed_limit integer;
BEGIN
  SELECT team_limit INTO allowed_limit FROM divisions WHERE id = NEW.division_id;
  IF allowed_limit IS NULL OR NEW.seed > allowed_limit THEN
    RAISE EXCEPTION 'entry seed exceeds division team limit';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER division_entries_seed_limit
BEFORE INSERT OR UPDATE OF division_id, seed ON division_entries
FOR EACH ROW EXECUTE FUNCTION enforce_division_entry_seed_limit();

CREATE TABLE playing_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  sort_order smallint NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  UNIQUE (competition_id, name),
  UNIQUE (id, competition_id)
);

CREATE TABLE competition_availability_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  playing_area_id uuid NOT NULL REFERENCES playing_areas(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (playing_area_id, competition_id) REFERENCES playing_areas(id, competition_id) ON DELETE CASCADE
);

CREATE INDEX availability_competition_time_idx
ON competition_availability_windows(competition_id, starts_at, ends_at);

CREATE TABLE format_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  definition jsonb NOT NULL,
  definition_hash text NOT NULL CHECK (length(definition_hash) = 64),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (division_id, revision),
  UNIQUE (division_id, definition_hash),
  UNIQUE (id, competition_id),
  FOREIGN KEY (division_id, competition_id) REFERENCES divisions(id, competition_id),
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

CREATE TABLE matches (
  id uuid PRIMARY KEY,
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  format_revision_id uuid NOT NULL REFERENCES format_revisions(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 40),
  stage text NOT NULL CHECK (stage IN ('group', 'quarterfinal', 'semifinal', 'bronze', 'final')),
  round_number smallint NOT NULL CHECK (round_number > 0),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  home_entry_id uuid REFERENCES division_entries(id),
  away_entry_id uuid REFERENCES division_entries(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'in_progress', 'final', 'corrected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (format_revision_id, code),
  UNIQUE (format_revision_id, ordinal),
  UNIQUE (id, competition_id),
  UNIQUE (id, format_revision_id),
  FOREIGN KEY (division_id, competition_id) REFERENCES divisions(id, competition_id),
  FOREIGN KEY (format_revision_id, competition_id) REFERENCES format_revisions(id, competition_id),
  FOREIGN KEY (home_entry_id, division_id) REFERENCES division_entries(id, division_id),
  FOREIGN KEY (away_entry_id, division_id) REFERENCES division_entries(id, division_id),
  CHECK (home_entry_id IS NULL OR away_entry_id IS NULL OR home_entry_id <> away_entry_id)
);

CREATE INDEX matches_competition_state_idx ON matches(competition_id, state, ordinal);

CREATE TABLE match_dependencies (
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  format_revision_id uuid NOT NULL,
  slot text CHECK (slot IN ('home', 'away')),
  source_match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
  outcome text CHECK (outcome IN ('winner', 'loser')),
  PRIMARY KEY (match_id, source_match_id),
  FOREIGN KEY (match_id, format_revision_id) REFERENCES matches(id, format_revision_id) ON DELETE CASCADE,
  FOREIGN KEY (source_match_id, format_revision_id) REFERENCES matches(id, format_revision_id) ON DELETE RESTRICT,
  CHECK (match_id <> source_match_id),
  CHECK ((slot IS NULL AND outcome IS NULL) OR (slot IS NOT NULL AND outcome IS NOT NULL))
);

CREATE TABLE schedule_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  format_revision_id uuid NOT NULL REFERENCES format_revisions(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  input_hash text NOT NULL CHECK (length(input_hash) = 64),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'superseded')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (competition_id, revision),
  UNIQUE (competition_id, input_hash),
  UNIQUE (id, competition_id),
  FOREIGN KEY (format_revision_id, competition_id) REFERENCES format_revisions(id, competition_id),
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

CREATE TABLE scheduled_matches (
  schedule_revision_id uuid NOT NULL REFERENCES schedule_revisions(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  playing_area_id uuid NOT NULL REFERENCES playing_areas(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  PRIMARY KEY (schedule_revision_id, match_id),
  FOREIGN KEY (schedule_revision_id, competition_id) REFERENCES schedule_revisions(id, competition_id) ON DELETE CASCADE,
  FOREIGN KEY (match_id, competition_id) REFERENCES matches(id, competition_id) ON DELETE CASCADE,
  FOREIGN KEY (playing_area_id, competition_id) REFERENCES playing_areas(id, competition_id) ON DELETE RESTRICT,
  CHECK (ends_at > starts_at)
);

CREATE INDEX scheduled_matches_area_time_idx
ON scheduled_matches(schedule_revision_id, playing_area_id, starts_at);

CREATE TABLE competition_publications (
  competition_id uuid PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
  published_schedule_revision_id uuid REFERENCES schedule_revisions(id) ON DELETE RESTRICT,
  schedule_version integer NOT NULL DEFAULT 0 CHECK (schedule_version >= 0),
  result_version integer NOT NULL DEFAULT 0 CHECK (result_version >= 0),
  schedule_published_at timestamptz,
  results_published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (published_schedule_revision_id, competition_id)
    REFERENCES schedule_revisions(id, competition_id) ON DELETE RESTRICT
);

CREATE TABLE scoring_access_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'scorekeeper' CHECK (role IN ('scorekeeper', 'viewer')),
  scope jsonb NOT NULL DEFAULT '["score:read","score:write","score:finalise"]'::jsonb,
  secret_hash bytea NOT NULL UNIQUE,
  short_code_hash bytea,
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES accounts(id),
  CHECK (expires_at > created_at),
  CHECK (octet_length(secret_hash) = 32),
  CHECK (short_code_hash IS NULL OR octet_length(short_code_hash) = 32),
  UNIQUE (id, match_id)
);

CREATE INDEX scoring_access_pass_match_idx ON scoring_access_passes(match_id, expires_at DESC);
CREATE UNIQUE INDEX scoring_access_pass_active_code_unique
ON scoring_access_passes(short_code_hash) WHERE short_code_hash IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE scoring_access_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_pass_id uuid NOT NULL REFERENCES scoring_access_passes(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  session_token_hash bytea NOT NULL UNIQUE,
  generation integer NOT NULL CHECK (generation > 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  transferred_to_session_id uuid,
  CHECK (expires_at > issued_at),
  FOREIGN KEY (access_pass_id, match_id) REFERENCES scoring_access_passes(id, match_id) ON DELETE CASCADE,
  FOREIGN KEY (transferred_to_session_id, match_id) REFERENCES scoring_access_sessions(id, match_id),
  CHECK (octet_length(session_token_hash) = 32),
  UNIQUE (id, match_id),
  UNIQUE (id, match_id, generation),
  UNIQUE (match_id, generation)
);

CREATE TABLE match_writer_leases (
  match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  access_session_id uuid NOT NULL REFERENCES scoring_access_sessions(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > acquired_at),
  FOREIGN KEY (access_session_id, match_id, generation)
    REFERENCES scoring_access_sessions(id, match_id, generation) ON DELETE CASCADE
);

CREATE TABLE score_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  client_event_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  writer_generation integer NOT NULL CHECK (writer_generation > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'match_started','period_changed','goal_added','goal_reversed','card_added','card_reversed',
    'timeout_added','incident_added','match_finalised','match_reopened','correction'
  )),
  team_slot text CHECK (team_slot IN ('home', 'away')),
  scorer text,
  manual_period smallint CHECK (manual_period BETWEEN 1 AND 2),
  manual_event_seconds integer CHECK (manual_event_seconds BETWEEN 0 AND 3599),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_access_session_id uuid REFERENCES scoring_access_sessions(id),
  actor_account_id uuid REFERENCES accounts(id),
  correction_reason text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, client_event_id),
  UNIQUE (match_id, sequence),
  CHECK (event_type <> 'goal_added' OR (team_slot IS NOT NULL AND scorer IS NOT NULL AND length(trim(scorer)) > 0)),
  CHECK (event_type = 'correction' OR (manual_period IS NOT NULL AND manual_event_seconds IS NOT NULL)),
  CHECK (event_type <> 'correction' OR length(trim(correction_reason)) >= 3),
  CHECK ((actor_access_session_id IS NOT NULL)::integer + (actor_account_id IS NOT NULL)::integer = 1),
  FOREIGN KEY (actor_access_session_id, match_id) REFERENCES scoring_access_sessions(id, match_id)
);

CREATE INDEX score_events_match_sequence_idx ON score_events(match_id, sequence);

CREATE TABLE match_result_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  result_version integer NOT NULL CHECK (result_version > 0),
  through_sequence integer NOT NULL CHECK (through_sequence > 0),
  home_score integer NOT NULL CHECK (home_score >= 0),
  away_score integer NOT NULL CHECK (away_score >= 0),
  state text NOT NULL CHECK (state IN ('in_progress', 'final', 'corrected')),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, result_version)
);

CREATE TABLE standings_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  result_version integer NOT NULL CHECK (result_version > 0),
  standings jsonb NOT NULL,
  explanation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id, result_version),
  FOREIGN KEY (division_id, competition_id) REFERENCES divisions(id, competition_id)
);

CREATE TABLE bracket_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  division_id uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  result_version integer NOT NULL CHECK (result_version > 0),
  bracket jsonb NOT NULL,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division_id, result_version),
  FOREIGN KEY (division_id, competition_id) REFERENCES divisions(id, competition_id)
);

CREATE TABLE public_competition_projections (
  competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  schedule_version integer NOT NULL CHECK (schedule_version >= 0),
  result_version integer NOT NULL CHECK (result_version >= 0),
  projection jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, schedule_version, result_version)
);

CREATE FUNCTION prevent_published_revision_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'superseded'
     OR (OLD.status = 'published' AND (
       TG_OP = 'DELETE'
       OR NEW.status <> 'superseded'
       OR (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status')
     )) THEN
    RAISE EXCEPTION 'published revisions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER format_revisions_immutable
BEFORE UPDATE OR DELETE ON format_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_published_revision_mutation();

CREATE TRIGGER schedule_revisions_immutable
BEFORE UPDATE OR DELETE ON schedule_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_published_revision_mutation();

CREATE FUNCTION protect_published_match_graph() RETURNS trigger AS $$
DECLARE
  revision_id uuid;
  revision_status text;
BEGIN
  revision_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.format_revision_id ELSE NEW.format_revision_id END;
  SELECT status INTO revision_status FROM format_revisions WHERE id = revision_id;
  IF revision_status IN ('published', 'superseded') THEN
    IF TG_OP <> 'UPDATE'
       OR NEW.format_revision_id <> OLD.format_revision_id
       OR NEW.code <> OLD.code
       OR NEW.stage <> OLD.stage
       OR NEW.round_number <> OLD.round_number
       OR NEW.ordinal <> OLD.ordinal THEN
      RAISE EXCEPTION 'published match graphs are immutable';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER matches_published_graph_immutable
BEFORE INSERT OR UPDATE OR DELETE ON matches
FOR EACH ROW EXECUTE FUNCTION protect_published_match_graph();

CREATE FUNCTION protect_published_match_dependency() RETURNS trigger AS $$
DECLARE
  revision_id uuid;
  revision_status text;
BEGIN
  revision_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.format_revision_id ELSE NEW.format_revision_id END;
  SELECT status INTO revision_status FROM format_revisions WHERE id = revision_id;
  IF revision_status IN ('published', 'superseded') THEN
    RAISE EXCEPTION 'published match dependencies are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER match_dependencies_published_graph_immutable
BEFORE INSERT OR UPDATE OR DELETE ON match_dependencies
FOR EACH ROW EXECUTE FUNCTION protect_published_match_dependency();

CREATE FUNCTION protect_published_schedule_assignment() RETURNS trigger AS $$
DECLARE
  revision_id uuid;
  revision_status text;
BEGIN
  revision_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.schedule_revision_id ELSE NEW.schedule_revision_id END;
  SELECT status INTO revision_status FROM schedule_revisions WHERE id = revision_id;
  IF revision_status IN ('published', 'superseded') THEN
    RAISE EXCEPTION 'published schedule assignments are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scheduled_matches_published_immutable
BEFORE INSERT OR UPDATE OR DELETE ON scheduled_matches
FOR EACH ROW EXECUTE FUNCTION protect_published_schedule_assignment();

CREATE FUNCTION prevent_score_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'score_events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER score_events_no_update
BEFORE UPDATE OR DELETE ON score_events
FOR EACH ROW EXECUTE FUNCTION prevent_score_event_mutation();
