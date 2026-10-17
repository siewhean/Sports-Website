-- Redesign Phase 3: Division short codes (1-4 characters, letters/digits, unique per competition)
-- Auto-suggested and backfilled for non-archived competitions only; archived rows remain untouched.

ALTER TABLE divisions
  ADD COLUMN short_code varchar(4)
  CHECK (short_code IS NULL OR short_code ~ '^[A-Z0-9]{1,4}$');

CREATE UNIQUE INDEX divisions_competition_short_code_unique
  ON divisions (competition_id, short_code)
  WHERE short_code IS NOT NULL;

DO $$
DECLARE
  comp RECORD;
  div RECORD;
  base_code text;
  candidate text;
  suffix int;
  taken text[];
BEGIN
  FOR comp IN
    SELECT id FROM competitions WHERE status <> 'archived' ORDER BY created_at
  LOOP
    taken := ARRAY[]::text[];
    FOR div IN
      SELECT id, name FROM divisions WHERE competition_id = comp.id ORDER BY created_at, id
    LOOP
      IF div.name ~* '^under\s*([0-9]+)' THEN
        base_code := 'U' || substring(div.name from '(?i)^under\s*([0-9]+)');
      ELSIF div.name ~* '^u([0-9]+)' THEN
        base_code := 'U' || substring(div.name from '(?i)^u([0-9]+)');
      ELSIF div.name ~* '^men' THEN
        base_code := 'M';
      ELSIF div.name ~* '^women' THEN
        base_code := 'W';
      ELSIF div.name ~* '^mixed' THEN
        base_code := 'X';
      ELSIF div.name ~* '^open' THEN
        base_code := 'O';
      ELSIF div.name ~* '^boys' THEN
        base_code := 'B';
      ELSIF div.name ~* '^girls' THEN
        base_code := 'G';
      ELSE
        base_code := upper(substring(regexp_replace(div.name, '[^a-zA-Z0-9]', '', 'g') from 1 for 1));
        IF base_code IS NULL OR base_code = '' THEN
          base_code := 'D';
        END IF;
      END IF;

      base_code := upper(substring(base_code from 1 for 4));
      candidate := base_code;
      suffix := 2;

      WHILE candidate = ANY(taken) LOOP
        candidate := substring(base_code from 1 for (4 - length(suffix::text))) || suffix::text;
        suffix := suffix + 1;
      END LOOP;

      taken := array_append(taken, candidate);

      UPDATE divisions
      SET short_code = candidate
      WHERE id = div.id;
    END LOOP;
  END LOOP;
END;
$$;
