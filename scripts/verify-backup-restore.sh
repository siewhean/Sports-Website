#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/local/compose.yaml"
RUN_SUFFIX="$(date -u +%s)_$$_${RANDOM}"
SOURCE_DB="matchday_backup_test_${RUN_SUFFIX}"
RESTORE_DB="matchday_restore_test_${RUN_SUFFIX}"
BACKUP_FILE="/tmp/${SOURCE_DB}.dump"
MODE="${BACKUP_VERIFY_MODE:-docker}"
DIRECT_ADMIN_DATABASE_URL="${BACKUP_VERIFY_ADMIN_DATABASE_URL:-postgresql:///postgres}"
DIRECT_CLIENT_IMAGE="${BACKUP_VERIFY_DIRECT_CLIENT_IMAGE:-}"

if [[ "$MODE" != "docker" && "$MODE" != "direct" ]]; then
  echo "BACKUP_VERIFY_MODE must be docker or direct" >&2
  exit 2
fi

if [[ -n "$DIRECT_CLIENT_IMAGE" && ! "$DIRECT_CLIENT_IMAGE" =~ ^postgres:[0-9]+(\.[0-9]+)?-alpine$ ]]; then
  echo "BACKUP_VERIFY_DIRECT_CLIENT_IMAGE must be a pinned PostgreSQL Alpine image." >&2
  exit 2
fi

container_id() {
  docker compose -f "$COMPOSE_FILE" ps -q postgres
}

postgres_exec() {
  docker exec "$(container_id)" "$@"
}

direct_maintenance_url() {
  node - "$DIRECT_ADMIN_DATABASE_URL" <<'NODE'
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
if (url.pathname !== "/postgres" || [...url.searchParams].length > 0) {
  process.stderr.write("BACKUP_VERIFY_ADMIN_DATABASE_URL must target postgres without query parameters.\n");
  process.exit(1);
}
process.stdout.write(url.toString());
NODE
}

direct_database_url() {
  node - "$DIRECT_ADMIN_DATABASE_URL" "$1" <<'NODE'
const url = new URL(process.argv[2]);
url.pathname = `/${process.argv[3]}`;
process.stdout.write(url.toString());
NODE
}

direct_postgres_tool() {
  if [[ -n "$DIRECT_CLIENT_IMAGE" ]]; then
    docker run --rm --network host --volume /tmp:/tmp "$DIRECT_CLIENT_IMAGE" "$@"
    return
  fi
  "$@"
}

assert_disposable_database_name() {
  if [[ ! "$1" =~ ^matchday_(backup|restore)_test_[0-9]+_[0-9]+_[0-9]+$ ]]; then
    echo "Refusing to operate on a non-disposable verification database." >&2
    exit 2
  fi
}

direct_exec() {
  direct_postgres_tool psql --dbname="$(direct_database_url "$1")" --set=ON_ERROR_STOP=1 --command="$2"
}

cleanup() {
  assert_disposable_database_name "$SOURCE_DB"
  assert_disposable_database_name "$RESTORE_DB"
  if [[ "$MODE" == "direct" ]]; then
    local maintenance_url
    maintenance_url="$(direct_maintenance_url)"
    direct_postgres_tool dropdb --if-exists --force --maintenance-db="$maintenance_url" "$SOURCE_DB" >/dev/null 2>&1 || true
    direct_postgres_tool dropdb --if-exists --force --maintenance-db="$maintenance_url" "$RESTORE_DB" >/dev/null 2>&1 || true
    rm -f "$BACKUP_FILE"
    return
  fi
  postgres_exec dropdb --if-exists --force -U matchday "$SOURCE_DB" >/dev/null 2>&1 || true
  postgres_exec dropdb --if-exists --force -U matchday "$RESTORE_DB" >/dev/null 2>&1 || true
  postgres_exec rm -f "$BACKUP_FILE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ "$MODE" == "docker" && -z "$(container_id)" ]]; then
  echo "PostgreSQL is not running. Start it with: docker compose -f infra/local/compose.yaml up -d --wait" >&2
  exit 1
fi

cleanup
if [[ "$MODE" == "direct" ]]; then
  maintenance_url="$(direct_maintenance_url)"
  direct_postgres_tool createdb --maintenance-db="$maintenance_url" "$SOURCE_DB"
  export DATABASE_URL="$(direct_database_url "$SOURCE_DB")"
else
  postgres_exec createdb -U matchday "$SOURCE_DB"
  export DATABASE_URL="postgres://matchday:matchday@127.0.0.1:5432/$SOURCE_DB"
fi
export APP_ENV=test
export LOG_LEVEL=silent
pnpm --dir "$ROOT_DIR" db:migrate

if [[ "$MODE" == "direct" ]]; then
  direct_exec "$SOURCE_DB" "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000001', 'restore-check@example.test', 'Restore Check', 'active');" >/dev/null
  direct_postgres_tool pg_dump --dbname="$(direct_database_url "$SOURCE_DB")" --format=custom --file="$BACKUP_FILE"
  direct_postgres_tool createdb --maintenance-db="$maintenance_url" "$RESTORE_DB"
  direct_postgres_tool pg_restore --dbname="$(direct_database_url "$RESTORE_DB")" --exit-on-error "$BACKUP_FILE"
  source_count="$(direct_postgres_tool psql --dbname="$(direct_database_url "$SOURCE_DB")" --tuples-only --no-align --command="SELECT count(*) FROM accounts;")"
  restore_count="$(direct_postgres_tool psql --dbname="$(direct_database_url "$RESTORE_DB")" --tuples-only --no-align --command="SELECT count(*) FROM accounts;")"
  source_fingerprint="$(direct_postgres_tool psql --dbname="$(direct_database_url "$SOURCE_DB")" --tuples-only --no-align --command="SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"
  restore_fingerprint="$(direct_postgres_tool psql --dbname="$(direct_database_url "$RESTORE_DB")" --tuples-only --no-align --command="SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"
else
  postgres_exec psql -v ON_ERROR_STOP=1 -U matchday -d "$SOURCE_DB" -c \
    "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000001', 'restore-check@example.test', 'Restore Check', 'active');" >/dev/null
  postgres_exec pg_dump -U matchday -d "$SOURCE_DB" --format=custom --file="$BACKUP_FILE"
  postgres_exec createdb -U matchday "$RESTORE_DB"
  postgres_exec pg_restore -U matchday -d "$RESTORE_DB" --exit-on-error "$BACKUP_FILE"
  source_count="$(postgres_exec psql -At -U matchday -d "$SOURCE_DB" -c "SELECT count(*) FROM accounts;")"
  restore_count="$(postgres_exec psql -At -U matchday -d "$RESTORE_DB" -c "SELECT count(*) FROM accounts;")"
  source_fingerprint="$(postgres_exec psql -At -U matchday -d "$SOURCE_DB" -c "SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"
  restore_fingerprint="$(postgres_exec psql -At -U matchday -d "$RESTORE_DB" -c "SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"
fi

if [[ "$source_count" != "$restore_count" || "$source_fingerprint" != "$restore_fingerprint" ]]; then
  echo "Backup restore verification failed: source and restored data differ" >&2
  exit 1
fi

if [[ "$MODE" == "direct" ]]; then
  direct_exec "$RESTORE_DB" "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000002', 'constraint-check@example.test', 'Constraint Check', 'active');" >/dev/null
else
  postgres_exec psql -v ON_ERROR_STOP=1 -U matchday -d "$RESTORE_DB" -c \
    "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000002', 'constraint-check@example.test', 'Constraint Check', 'active');" >/dev/null
fi

echo "Backup restore verification passed: ${restore_count} account row(s), fingerprint ${restore_fingerprint}."
