-- Migration 0063: SCH-006 Official Availability Constraints

CREATE TABLE competition_officials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL,
  organisation_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  default_role text NULL CHECK (default_role IS NULL OR length(trim(default_role)) BETWEEN 1 AND 40),
  archived_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, competition_id, organisation_id),
  FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX competition_officials_active_name_uidx
ON competition_officials(competition_id, lower(trim(name)))
WHERE archived_at IS NULL;

CREATE INDEX competition_officials_competition_all_idx
ON competition_officials(competition_id, created_at);

CREATE TABLE official_availability_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL,
  organisation_id uuid NOT NULL,
  official_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (official_id, starts_at, ends_at),
  FOREIGN KEY (official_id, competition_id, organisation_id) REFERENCES competition_officials(id, competition_id, organisation_id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE
);

CREATE INDEX official_availability_windows_official_idx
ON official_availability_windows(competition_id, official_id, starts_at);

CREATE TABLE match_official_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id uuid NOT NULL,
  organisation_id uuid NOT NULL,
  match_id uuid NOT NULL,
  official_id uuid NOT NULL,
  assigned_role text NULL CHECK (assigned_role IS NULL OR length(trim(assigned_role)) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, official_id),
  FOREIGN KEY (match_id, competition_id) REFERENCES matches(id, competition_id) ON DELETE CASCADE,
  FOREIGN KEY (official_id, competition_id, organisation_id) REFERENCES competition_officials(id, competition_id, organisation_id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id, organisation_id) REFERENCES competitions(id, organisation_id) ON DELETE CASCADE
);

CREATE INDEX match_official_assignments_match_idx
ON match_official_assignments(match_id);

CREATE INDEX match_official_assignments_official_idx
ON match_official_assignments(competition_id, official_id);
