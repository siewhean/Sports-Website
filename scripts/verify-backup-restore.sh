#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/local/compose.yaml"
RUN_SUFFIX="$(date -u +%s)_$$_${RANDOM}"
SOURCE_DB="matchday_backup_test_${RUN_SUFFIX}"
RESTORE_DB="matchday_restore_test_${RUN_SUFFIX}"
BACKUP_FILE="/tmp/${SOURCE_DB}.dump"
LOCAL_ADMIN_DATABASE_URL="${BACKUP_VERIFY_ADMIN_DATABASE_URL:-postgres://matchday:matchday@127.0.0.1:5432/postgres}"
POSTGRES_MODE="${BACKUP_VERIFY_POSTGRES_MODE:-local}"
VERIFY_MODE="${BACKUP_VERIFY_MODE:-local}"
DIRECT_CLIENT_IMAGE="${BACKUP_VERIFY_DIRECT_CLIENT_IMAGE:-postgres:18.4-alpine}"
POSTGRES_CONTAINER_ID=""
DIRECT_BACKUP_DIRECTORY=""

assert_disposable_name() {
  local database_name="$1"
  if [[ ! "$database_name" =~ ^matchday_(backup|restore)_test_[0-9]+_[0-9]+_[0-9]+$ ]]; then
    echo "Refusing to operate on non-disposable database name: ${database_name}" >&2
    exit 1
  fi
}

assert_loopback_admin_url() {
  node - "$LOCAL_ADMIN_DATABASE_URL" <<'NODE'
const value = process.argv[2];
let url;

try {
  url = new URL(value);
} catch {
  process.stderr.write("BACKUP_VERIFY_ADMIN_DATABASE_URL must be a valid PostgreSQL URL.\n");
  process.exit(1);
}

if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
  process.stderr.write("BACKUP_VERIFY_ADMIN_DATABASE_URL must use postgres or postgresql.\n");
  process.exit(1);
}

if (!new Set(["", "localhost", "127.0.0.1", "::1"]).has(url.hostname)) {
  process.stderr.write("Backup verification only permits a local PostgreSQL admin URL.\n");
  process.exit(1);
}

if (url.pathname !== "/postgres") {
  process.stderr.write("BACKUP_VERIFY_ADMIN_DATABASE_URL must connect to the postgres maintenance database.\n");
  process.exit(1);
}

if ([...url.searchParams].length > 0) {
  process.stderr.write("BACKUP_VERIFY_ADMIN_DATABASE_URL must not contain query parameters.\n");
  process.exit(1);
}
NODE
}

database_url() {
  local database_name="$1"
  assert_disposable_name "$database_name"
  node - "$LOCAL_ADMIN_DATABASE_URL" "$database_name" <<'NODE'
const url = new URL(process.argv[2]);
url.pathname = `/${process.argv[3]}`;
process.stdout.write(url.toString());
NODE
}

assert_direct_client_image() {
  # Keep the client image versioned and Alpine-based. The verification client is
  # deliberately isolated from the runner's installed PostgreSQL tools so CI
  # uses a client compatible with its PostgreSQL service.
  if [[ ! "$DIRECT_CLIENT_IMAGE" =~ ^postgres:[0-9]+\.[0-9]+(\.[0-9]+)?-alpine$ ]]; then
    echo "BACKUP_VERIFY_DIRECT_CLIENT_IMAGE must be a pinned PostgreSQL Alpine image." >&2
    exit 1
  fi
}

direct_postgres_tool() {
  # GitHub Actions service containers expose PostgreSQL on loopback. Docker's
  # host network lets this short-lived client reach only that guarded URL.
  docker run --rm --network host --volume "$DIRECT_BACKUP_DIRECTORY:/work" "$DIRECT_CLIENT_IMAGE" "$@"
}

direct_backup_file() {
  printf '/work/%s.dump' "$SOURCE_DB"
}

configure_postgres_mode() {
  if [[ "$VERIFY_MODE" == "direct" ]]; then
    if ! command -v docker >/dev/null 2>&1; then
      echo "Direct backup verification requires Docker." >&2
      exit 1
    fi
    assert_loopback_admin_url
    assert_direct_client_image
    DIRECT_BACKUP_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/matchday-backup-verify.XXXXXX")"
    echo "Backup restore verification using a guarded direct PostgreSQL Docker client."
    return
  fi

  if [[ "$VERIFY_MODE" != "local" ]]; then
    echo "BACKUP_VERIFY_MODE must be local or direct." >&2
    exit 1
  fi

  if [[ "$POSTGRES_MODE" == "docker" ]]; then
    if ! command -v docker >/dev/null 2>&1; then
      echo "Docker mode requested but Docker is not installed." >&2
      exit 1
    fi
    POSTGRES_CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null || true)"
    if [[ -n "$POSTGRES_CONTAINER_ID" ]]; then
      return
    fi
    echo "Docker mode requested but the local PostgreSQL compose service is not running." >&2
    exit 1
  fi

  if [[ "$POSTGRES_MODE" != "local" ]]; then
    echo "BACKUP_VERIFY_POSTGRES_MODE must be local or docker." >&2
    exit 1
  fi
  assert_loopback_admin_url
  echo "Backup restore verification using local loopback PostgreSQL."
}

postgres_createdb() {
  local database_name="$1"
  assert_disposable_name "$database_name"
  if [[ "$VERIFY_MODE" == "direct" ]]; then
    direct_postgres_tool createdb --maintenance-db="$LOCAL_ADMIN_DATABASE_URL" "$database_name"
  elif [[ "$POSTGRES_MODE" == "docker" ]]; then
    docker exec "$POSTGRES_CONTAINER_ID" createdb -U matchday "$database_name"
  else
    psql "$LOCAL_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${database_name};"
  fi
}

postgres_dropdb() {
  local database_name="$1"
  assert_disposable_name "$database_name"
  if [[ "$VERIFY_MODE" == "direct" ]]; then
    direct_postgres_tool dropdb --if-exists --force --maintenance-db="$LOCAL_ADMIN_DATABASE_URL" "$database_name"
  elif [[ "$POSTGRES_MODE" == "docker" ]]; then
    docker exec "$POSTGRES_CONTAINER_ID" dropdb --if-exists --force -U matchday "$database_name"
  else
    psql "$LOCAL_ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${database_name} WITH (FORCE);"
  fi
}

postgres_psql() {
  local database_name="$1"
  shift
  if [[ "$VERIFY_MODE" == "direct" ]]; then
    direct_postgres_tool psql --dbname="$(database_url "$database_name")" "$@"
  elif [[ "$POSTGRES_MODE" == "docker" ]]; then
    docker exec "$POSTGRES_CONTAINER_ID" psql -U matchday -d "$database_name" "$@"
  else
    psql "$(database_url "$database_name")" "$@"
  fi
}

postgres_dump() {
  local database_name="$1"
  if [[ "$VERIFY_MODE" == "direct" ]]; then
    direct_postgres_tool pg_dump --dbname="$(database_url "$database_name")" --format=custom --file="$(direct_backup_file)"
  elif [[ "$POSTGRES_MODE" == "docker" ]]; then
    docker exec "$POSTGRES_CONTAINER_ID" pg_dump -U matchday -d "$database_name" --format=custom --file="$BACKUP_FILE"
  else
    pg_dump "$(database_url "$database_name")" --format=custom --file="$BACKUP_FILE"
  fi
}

postgres_restore() {
  local database_name="$1"
  if [[ "$VERIFY_MODE" == "direct" ]]; then
    direct_postgres_tool pg_restore --dbname="$(database_url "$database_name")" --exit-on-error "$(direct_backup_file)"
  elif [[ "$POSTGRES_MODE" == "docker" ]]; then
    docker exec "$POSTGRES_CONTAINER_ID" pg_restore -U matchday -d "$database_name" --exit-on-error "$BACKUP_FILE"
  else
    pg_restore --dbname="$(database_url "$database_name")" --exit-on-error "$BACKUP_FILE"
  fi
}

remove_backup_file() {
  if [[ "$VERIFY_MODE" == "direct" ]]; then
    rm -rf "$DIRECT_BACKUP_DIRECTORY"
  elif [[ "$POSTGRES_MODE" == "docker" ]]; then
    docker exec "$POSTGRES_CONTAINER_ID" rm -f "$BACKUP_FILE"
  else
    rm -f "$BACKUP_FILE"
  fi
}

assert_disposable_name "$SOURCE_DB"
assert_disposable_name "$RESTORE_DB"
unset PGHOST PGHOSTADDR PGPORT PGSERVICE PGSERVICEFILE
configure_postgres_mode

cleanup() {
  postgres_dropdb "$SOURCE_DB" >/dev/null 2>&1 || true
  postgres_dropdb "$RESTORE_DB" >/dev/null 2>&1 || true
  remove_backup_file >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
postgres_createdb "$SOURCE_DB"

export DATABASE_URL="$(database_url "$SOURCE_DB")"
export APP_ENV=test
export LOG_LEVEL=silent
(
  cd "$ROOT_DIR"
  pnpm --filter @matchday/config build
  pnpm db:migrate
)

postgres_psql "$SOURCE_DB" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000001', 'restore-check@example.test', 'Restore Check', 'active');" >/dev/null

# These are disposable fixture rows, never production backup evidence.
postgres_psql "$SOURCE_DB" -v ON_ERROR_STOP=1 -c "$(cat <<'SQL'
INSERT INTO accounts(id,primary_email,display_name,status)
VALUES('00000000-0000-4000-8000-000000000003','casual-friend@example.test','Casual Friend','active');
INSERT INTO casual_games(id,owner_account_id,sport_id,home_name,away_name,host_token_hash,viewer_token_hash)
VALUES('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','badminton','Home','Away','restore-host','restore-viewer');
INSERT INTO casual_game_actions(game_id,version,kind,before_state,after_state)
VALUES('00000000-0000-4000-8000-000000000010',2,'score','{}','{"home_score":1}');
INSERT INTO casual_game_presets(owner_account_id,name,settings)
VALUES('00000000-0000-4000-8000-000000000001','Regular','{"sport_id":"badminton"}');
INSERT INTO casual_friend_requests(sender_id,recipient_id)
VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003');
INSERT INTO casual_game_shares(game_id,recipient_id)
VALUES('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000003');
SQL
)" >/dev/null

# Exercise the same generated-column/check dependency as schedule_generation_jobs
# without bypassing its application provenance guards. This table and nested
# fixture exist only in the guarded disposable database and its temporary dump.
# pg_restore COPY evaluates these expressions with its restricted search_path.
postgres_psql "$SOURCE_DB" -v ON_ERROR_STOP=1 -c "$(cat <<'SQL'
CREATE TABLE public.backup_restore_schedule_hash_fixture (
  id integer PRIMARY KEY,
  input_snapshot jsonb NOT NULL,
  input_hash text NOT NULL CHECK (input_hash=public.phase4_sha256_json(input_snapshot)),
  problem_hash text GENERATED ALWAYS AS (public.phase4_schedule_problem_hash(input_snapshot)) STORED,
  metadata jsonb NOT NULL CHECK (public.phase4_json_object_without_forbidden_keys(metadata))
);
INSERT INTO public.backup_restore_schedule_hash_fixture(id,input_snapshot,input_hash,metadata)
VALUES (1,'{"z":[{"b":2,"a":[1,null,true]}],"a":{"nested":"restore"}}',
  'f7623cf1069aa80481b171bed1234fbe37b38e08e9010f2b190fc3cc2ada43b8',
  '{"nested":[{"label":"restore","items":[{"count":1}]}]}');
SQL
)" >/dev/null

# A complete schedule snapshot exercises the actual validator CHECK during COPY.
# Its identities, times and settings are synthetic; no production dump is used.
# The fixture table avoids application provenance triggers; the production table
# CHECK is separately verified below and is never weakened or disabled.
schedule_input_fixture="$(cat "$ROOT_DIR/packages/database/tests/fixtures/cp9a1-schedule-input.json")"
postgres_psql "$SOURCE_DB" -v ON_ERROR_STOP=1 -c "
CREATE TABLE public.backup_restore_schedule_input_fixture (
  id integer PRIMARY KEY,
  input_snapshot jsonb NOT NULL CHECK (public.phase4_schedule_input_valid(input_snapshot)),
  input_hash text NOT NULL CHECK (input_hash=public.phase4_sha256_json(input_snapshot)),
  problem_hash text GENERATED ALWAYS AS (public.phase4_schedule_problem_hash(input_snapshot)) STORED
);
INSERT INTO public.backup_restore_schedule_input_fixture(id,input_snapshot,input_hash)
VALUES (1, \$snapshot\$${schedule_input_fixture}\$snapshot\$::jsonb,
  public.phase4_sha256_json(\$snapshot\$${schedule_input_fixture}\$snapshot\$::jsonb));
" >/dev/null

postgres_dump "$SOURCE_DB"
postgres_createdb "$RESTORE_DB"
postgres_restore "$RESTORE_DB"

schedule_shape_query="SELECT count(*)=1 AND bool_and((SELECT count(*)=11 FROM jsonb_object_keys(input_snapshot)) AND (SELECT count(*)=11 FROM jsonb_object_keys(input_snapshot->'constraints')) AND jsonb_array_length(input_snapshot->'matches')=36 AND jsonb_array_length(input_snapshot->'slots')=72 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(input_snapshot->'matches') match_value WHERE jsonb_typeof(match_value->'official_ids') IS DISTINCT FROM 'array')) FROM public.backup_restore_schedule_input_fixture;"
if [[ "$(postgres_psql "$RESTORE_DB" -qAt -c "$schedule_shape_query")" != "t" ]]; then
  echo "Backup restore verification failed: complete synthetic schedule fixture shape changed" >&2
  exit 1
fi
schedule_input_query="SELECT count(*)::text || ':' || bool_and(public.phase4_schedule_input_valid(input_snapshot))::text || ':' || min(input_hash) || ':' || min(problem_hash) FROM public.backup_restore_schedule_input_fixture;"
source_schedule_input="$(postgres_psql "$SOURCE_DB" -qAt -c "SET search_path = ''; $schedule_input_query")"
restore_schedule_input="$(postgres_psql "$RESTORE_DB" -qAt -c "SET search_path = ''; $schedule_input_query")"
if [[ "$source_schedule_input" != 1:true:* || "$source_schedule_input" != "$restore_schedule_input" ]]; then
  echo "Backup restore verification failed: full schedule-input validator or hashes differ" >&2
  exit 1
fi
schedule_check_query="SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.schedule_generation_jobs'::regclass AND conname='schedule_generation_jobs_input_snapshot_check' AND convalidated;"
source_schedule_check="$(postgres_psql "$SOURCE_DB" -qAt -c "SET search_path = ''; $schedule_check_query")"
restore_schedule_check="$(postgres_psql "$RESTORE_DB" -qAt -c "SET search_path = ''; $schedule_check_query")"
if [[ "$source_schedule_check" != 'CHECK (public.phase4_schedule_input_valid(input_snapshot))' || "$source_schedule_check" != "$restore_schedule_check" ]]; then
  echo "Backup restore verification failed: schedule_generation_jobs input CHECK changed" >&2
  exit 1
fi
echo "Complete schedule snapshot (11 settings, 36 matches, 72 slots) validated after restricted-search-path restore; production-table CHECK unchanged."

schedule_hash_query="SELECT count(*)::text || ':' || min(input_hash) || ':' || min(problem_hash) FROM public.backup_restore_schedule_hash_fixture;"
schedule_hash_expected="1:f7623cf1069aa80481b171bed1234fbe37b38e08e9010f2b190fc3cc2ada43b8:f7623cf1069aa80481b171bed1234fbe37b38e08e9010f2b190fc3cc2ada43b8"
source_schedule_hash="$(postgres_psql "$SOURCE_DB" -At -c "$schedule_hash_query")"
restore_schedule_hash="$(postgres_psql "$RESTORE_DB" -At -c "$schedule_hash_query")"
if [[ "$source_schedule_hash" != "$schedule_hash_expected" || "$restore_schedule_hash" != "$schedule_hash_expected" ]]; then
  echo "Backup restore verification failed: nested schedule fixture hashes differ" >&2
  exit 1
fi
echo "Disposable nested schedule hash generated column and check verified through pg_dump/pg_restore."
postgres_psql "$RESTORE_DB" -v ON_ERROR_STOP=1 -c "$(cat <<'SQL'
DO $verification$
BEGIN
  IF (SELECT metadata FROM public.backup_restore_schedule_hash_fixture WHERE id=1)
     <> '{"nested":[{"label":"restore","items":[{"count":1}]}]}'::jsonb THEN
    RAISE EXCEPTION 'Restored nested metadata differs';
  END IF;
  BEGIN
    UPDATE public.backup_restore_schedule_hash_fixture
      SET metadata='{"nested":[{"secret":"must-reject"}]}' WHERE id=1;
    RAISE EXCEPTION 'Restored nested metadata check did not reject forbidden key';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$verification$;
SQL
)" >/dev/null
echo "Disposable nested metadata and forbidden-key check verified after restore."

if [[ "$(postgres_psql "$SOURCE_DB" -At -c "SELECT to_regclass('public.competition_officials') IS NOT NULL;")" == "t" ]]; then
  official_name_index_query="SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid=to_regclass('public.competition_officials_active_name_uidx') AND indisunique AND indpred IS NOT NULL;"
  source_official_name_index="$(postgres_psql "$SOURCE_DB" -At -c "$official_name_index_query")"
  restore_official_name_index="$(postgres_psql "$RESTORE_DB" -At -c "$official_name_index_query")"
  if [[ -z "$source_official_name_index" || "$source_official_name_index" != "$restore_official_name_index" ]]; then
    echo "Backup restore verification failed: active official-name unique index is missing or changed" >&2
    exit 1
  fi
  echo "Active official-name partial unique index verified after migration and restore."
fi

migration_ledger_query="SELECT count(*)::text || ':' || md5(string_agg(name || ':' || coalesce(checksum, ''), ',' ORDER BY name)) FROM public.schema_migrations;"
source_migration_ledger="$(postgres_psql "$SOURCE_DB" -At -c "$migration_ledger_query")"
restore_migration_ledger="$(postgres_psql "$RESTORE_DB" -At -c "$migration_ledger_query")"
if [[ "$source_migration_ledger" != "$restore_migration_ledger" ]]; then
  echo "Backup restore verification failed: migration ledger differs" >&2
  exit 1
fi

for casual_table in casual_games casual_game_actions casual_game_presets casual_friend_requests casual_game_shares; do
  casual_fingerprint_query="SELECT count(*)::text || ':' || md5(coalesce(string_agg(to_jsonb(row_value)::text, ',' ORDER BY to_jsonb(row_value)::text), '')) FROM public.${casual_table} row_value;"
  source_casual_fingerprint="$(postgres_psql "$SOURCE_DB" -At -c "$casual_fingerprint_query")"
  restore_casual_fingerprint="$(postgres_psql "$RESTORE_DB" -At -c "$casual_fingerprint_query")"
  if [[ "$source_casual_fingerprint" != 1:* || "$source_casual_fingerprint" != "$restore_casual_fingerprint" ]]; then
    echo "Backup restore verification failed: ${casual_table} rows differ" >&2
    exit 1
  fi
  casual_constraint_query="SELECT string_agg(conname || ':' || convalidated::text || ':' || pg_get_constraintdef(oid), ',' ORDER BY conname) FROM pg_constraint WHERE conrelid='public.${casual_table}'::regclass;"
  source_casual_constraints="$(postgres_psql "$SOURCE_DB" -At -c "$casual_constraint_query")"
  restore_casual_constraints="$(postgres_psql "$RESTORE_DB" -At -c "$casual_constraint_query")"
  if [[ -z "$source_casual_constraints" || "$source_casual_constraints" != "$restore_casual_constraints" ]]; then
    echo "Backup restore verification failed: ${casual_table} constraints differ" >&2
    exit 1
  fi
done

postgres_psql "$RESTORE_DB" -v ON_ERROR_STOP=1 -c "$(cat <<'SQL'
DO $verification$
BEGIN
  BEGIN
    UPDATE casual_games SET home_score=-1 WHERE id='00000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'Restored casual score constraint did not reject invalid score';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO casual_game_actions(game_id,version,kind,before_state,after_state)
    VALUES('00000000-0000-4000-8000-000000000010',2,'score','{}','{}');
    RAISE EXCEPTION 'Restored action version uniqueness did not reject duplicate';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO casual_game_shares(game_id,recipient_id)
    VALUES('00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'Restored game share foreign key did not reject orphan';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END
$verification$;
SQL
)" >/dev/null
echo "Disposable casual rows, fingerprints and constraints verified after restore."

source_count="$(postgres_psql "$SOURCE_DB" -At -c "SELECT count(*) FROM accounts;")"
restore_count="$(postgres_psql "$RESTORE_DB" -At -c "SELECT count(*) FROM accounts;")"
source_fingerprint="$(postgres_psql "$SOURCE_DB" -At -c "SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"
restore_fingerprint="$(postgres_psql "$RESTORE_DB" -At -c "SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"

if [[ "$source_count" != "$restore_count" || "$source_fingerprint" != "$restore_fingerprint" ]]; then
  echo "Backup restore verification failed: source and restored data differ" >&2
  exit 1
fi

postgres_psql "$RESTORE_DB" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000002', 'constraint-check@example.test', 'Constraint Check', 'active');" >/dev/null

echo "Backup restore verification passed: ${restore_count} account row(s), fingerprint ${restore_fingerprint}."
