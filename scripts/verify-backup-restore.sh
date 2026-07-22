#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/local/compose.yaml"
SOURCE_DB="matchday_backup_test"
RESTORE_DB="matchday_restore_test"
BACKUP_FILE="/tmp/${SOURCE_DB}.dump"
DIRECT_MODE="${GATE_B_MANAGE_INFRA:-1}"

if [[ "$DIRECT_MODE" == "0" ]]; then
  if [[ ! "${DATABASE_URL:-}" =~ ^postgres(ql)?://[^/?#]+(:[0-9]+)?/[^/?#]+$ ]]; then
    echo "Direct backup verification requires a simple PostgreSQL DATABASE_URL without query or fragment" >&2
    exit 1
  fi
  MAINTENANCE_URL="$DATABASE_URL"
  BASE_URL="${DATABASE_URL%/*}"
  SOURCE_URL="${BASE_URL}/${SOURCE_DB}"
  RESTORE_URL="${BASE_URL}/${RESTORE_DB}"

  cleanup() {
    dropdb --maintenance-db="$MAINTENANCE_URL" --if-exists --force "$SOURCE_DB" >/dev/null 2>&1 || true
    dropdb --maintenance-db="$MAINTENANCE_URL" --if-exists --force "$RESTORE_DB" >/dev/null 2>&1 || true
    rm -f "$BACKUP_FILE"
  }
  trap cleanup EXIT
  cleanup
  createdb --maintenance-db="$MAINTENANCE_URL" "$SOURCE_DB"
  export DATABASE_URL="$SOURCE_URL"
  export APP_ENV=test
  export LOG_LEVEL=silent
  pnpm --dir "$ROOT_DIR" db:migrate
  psql -v ON_ERROR_STOP=1 "$SOURCE_URL" -c \
    "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000001', 'restore-check@example.test', 'Restore Check', 'active');" >/dev/null
  pg_dump "$SOURCE_URL" --format=custom --file="$BACKUP_FILE"
  createdb --maintenance-db="$MAINTENANCE_URL" "$RESTORE_DB"
  pg_restore --dbname="$RESTORE_URL" --exit-on-error "$BACKUP_FILE"
  source_count="$(psql -At "$SOURCE_URL" -c "SELECT count(*) FROM accounts;")"
  restore_count="$(psql -At "$RESTORE_URL" -c "SELECT count(*) FROM accounts;")"
  source_fingerprint="$(psql -At "$SOURCE_URL" -c "SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"
  restore_fingerprint="$(psql -At "$RESTORE_URL" -c "SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"
  if [[ "$source_count" != "$restore_count" || "$source_fingerprint" != "$restore_fingerprint" ]]; then
    echo "Backup restore verification failed: source and restored data differ" >&2
    exit 1
  fi
  psql -v ON_ERROR_STOP=1 "$RESTORE_URL" -c \
    "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000002', 'constraint-check@example.test', 'Constraint Check', 'active');" >/dev/null
  echo "Backup restore verification passed: ${restore_count} account row(s), fingerprint ${restore_fingerprint}."
  exit 0
fi

container_id() {
  docker compose -f "$COMPOSE_FILE" ps -q postgres
}

postgres_exec() {
  docker exec "$(container_id)" "$@"
}

cleanup() {
  postgres_exec dropdb --if-exists --force -U matchday "$SOURCE_DB" >/dev/null 2>&1 || true
  postgres_exec dropdb --if-exists --force -U matchday "$RESTORE_DB" >/dev/null 2>&1 || true
  postgres_exec rm -f "$BACKUP_FILE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ -z "$(container_id)" ]]; then
  echo "PostgreSQL is not running. Start it with: docker compose -f infra/local/compose.yaml up -d --wait" >&2
  exit 1
fi

cleanup
postgres_exec createdb -U matchday "$SOURCE_DB"
export DATABASE_URL="postgres://matchday:matchday@127.0.0.1:5432/$SOURCE_DB"
export APP_ENV=test
export LOG_LEVEL=silent
pnpm --dir "$ROOT_DIR" db:migrate
postgres_exec psql -v ON_ERROR_STOP=1 -U matchday -d "$SOURCE_DB" -c \
  "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000001', 'restore-check@example.test', 'Restore Check', 'active');" >/dev/null
postgres_exec pg_dump -U matchday -d "$SOURCE_DB" --format=custom --file="$BACKUP_FILE"
postgres_exec createdb -U matchday "$RESTORE_DB"
postgres_exec pg_restore -U matchday -d "$RESTORE_DB" --exit-on-error "$BACKUP_FILE"
source_count="$(postgres_exec psql -At -U matchday -d "$SOURCE_DB" -c "SELECT count(*) FROM accounts;")"
restore_count="$(postgres_exec psql -At -U matchday -d "$RESTORE_DB" -c "SELECT count(*) FROM accounts;")"
source_fingerprint="$(postgres_exec psql -At -U matchday -d "$SOURCE_DB" -c "SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"
restore_fingerprint="$(postgres_exec psql -At -U matchday -d "$RESTORE_DB" -c "SELECT md5(string_agg(id::text || ':' || primary_email, ',' ORDER BY id)) FROM accounts;")"
if [[ "$source_count" != "$restore_count" || "$source_fingerprint" != "$restore_fingerprint" ]]; then
  echo "Backup restore verification failed: source and restored data differ" >&2
  exit 1
fi
postgres_exec psql -v ON_ERROR_STOP=1 -U matchday -d "$RESTORE_DB" -c \
  "INSERT INTO accounts (id, primary_email, display_name, status) VALUES ('00000000-0000-4000-8000-000000000002', 'constraint-check@example.test', 'Constraint Check', 'active');" >/dev/null

echo "Backup restore verification passed: ${restore_count} account row(s), fingerprint ${restore_fingerprint}."
