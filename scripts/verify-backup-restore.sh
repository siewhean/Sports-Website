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

postgres_dump "$SOURCE_DB"
postgres_createdb "$RESTORE_DB"
postgres_restore "$RESTORE_DB"

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
