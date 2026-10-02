CREATE TABLE casual_games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  sport_id text NOT NULL CHECK (sport_id IN ('canoe_polo','badminton','table_tennis','volleyball','basketball')),
  home_name text NOT NULL CHECK (length(home_name) BETWEEN 1 AND 60),
  away_name text NOT NULL CHECK (length(away_name) BETWEEN 1 AND 60),
  target_points integer CHECK (target_points BETWEEN 1 AND 99),
  best_of_sets integer CHECK (best_of_sets IN (1,3,5,7)),
  period_minutes integer CHECK (period_minutes BETWEEN 1 AND 120),
  home_score integer NOT NULL DEFAULT 0 CHECK (home_score >= 0),
  away_score integer NOT NULL DEFAULT 0 CHECK (away_score >= 0),
  home_sets integer NOT NULL DEFAULT 0 CHECK (home_sets >= 0),
  away_sets integer NOT NULL DEFAULT 0 CHECK (away_sets >= 0),
  current_set integer NOT NULL DEFAULT 1,
  sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  elapsed_seconds integer NOT NULL DEFAULT 0 CHECK (elapsed_seconds >= 0),
  timer_started_at timestamptz,
  status text NOT NULL DEFAULT 'live' CHECK (status IN ('live','final')),
  host_token_hash text NOT NULL UNIQUE,
  viewer_token_hash text NOT NULL UNIQUE,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX casual_games_owner_created_idx ON casual_games(owner_account_id, created_at DESC) WHERE owner_account_id IS NOT NULL;
CREATE TABLE casual_game_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES casual_games(id) ON DELETE CASCADE,
  version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('score','undo','timer','finish')),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id,version)
);
CREATE INDEX casual_game_actions_game_idx ON casual_game_actions(game_id,version DESC);
CREATE TABLE casual_game_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX casual_game_presets_owner_idx ON casual_game_presets(owner_account_id,created_at DESC);
CREATE TABLE casual_friend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id),
  UNIQUE (sender_id,recipient_id)
);
CREATE TABLE casual_game_shares (
  game_id uuid NOT NULL REFERENCES casual_games(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id,recipient_id)
);
