#!/usr/bin/env bash
# MATCHDAY production Postgres restore: download -> verify checksum -> decrypt -> pg_restore.
#
#   restore-postgres.sh --list
#   restore-postgres.sh (--latest daily|weekly|premigration | --key KEY | --file PATH) \
#       --target-db NAME [--identity AGE_KEY_FILE] [--replace-target] \
#       [--allow-production-overwrite]
#   restore-postgres.sh --counts-only --target-db NAME
#
# Restoring into the production database name (PGDATABASE) is refused unless
# --allow-production-overwrite is passed. A drill should always use a scratch name such as
# matchday_restore_drill. Exits non-zero on any failure.
set -euo pipefail

LOG_TAG="restore"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
MODE="restore"
LATEST=""
KEY=""
FILE=""
TARGET=""
IDENTITY=""
REPLACE_TARGET=0
ALLOW_PROD=0

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list" ;;
    --counts-only) MODE="counts" ;;
    --latest) LATEST="${2:-}"; shift ;;
    --key) KEY="${2:-}"; shift ;;
    --file) FILE="${2:-}"; shift ;;
    --target-db) TARGET="${2:-}"; shift ;;
    --identity) IDENTITY="${2:-}"; shift ;;
    --replace-target) REPLACE_TARGET=1 ;;
    --allow-production-overwrite) ALLOW_PROD=1 ;;
    -h | --help) usage ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
  shift
done

require_env PGHOST PGUSER PGPASSWORD PGDATABASE

counts() { # DB
  printf '%s\n' "select format('select %L as table_name, count(*) as row_count from %I.%I', schemaname || '.' || tablename, schemaname, tablename) from pg_tables where schemaname not in ('pg_catalog','information_schema') order by schemaname, tablename \\gexec" |
    psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align --field-separator '|' --dbname "$1"
}

if [ "$MODE" = "list" ]; then
  s3_validate_config
  for p in daily weekly premigration; do
    printf '== %s/%s/\n' "$(s3_prefix)" "$p"
    s3_list "$(s3_prefix)/$p/" | grep -E '\.dump(\.age)?( |$)' || true
  done
  exit 0
fi

[[ "$TARGET" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || die "--target-db is required and must be a plain identifier"
case "$TARGET" in
  postgres | template0 | template1) die "refusing to restore into system database '$TARGET'" ;;
esac

if [ "$MODE" = "counts" ]; then
  counts "$TARGET"
  exit 0
fi

if [ "$TARGET" = "$PGDATABASE" ] && [ "$ALLOW_PROD" -ne 1 ]; then
  die "target '$TARGET' is the production database; refusing without --allow-production-overwrite (use a scratch name for drills)"
fi

sources=0
[ -z "$LATEST" ] || sources=$((sources + 1))
[ -z "$KEY" ] || sources=$((sources + 1))
[ -z "$FILE" ] || sources=$((sources + 1))
[ "$sources" -eq 1 ] || die "choose exactly one of --latest, --key, --file"

work="$BACKUP_DIR/restore-work"
mkdir -p "$work"
chmod 700 "$work" 2>/dev/null || true
trap 'rm -rf "${work:?}"/*' EXIT

if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || die "file not found: $FILE"
  artifact="$work/$(basename "$FILE")"
  cp "$FILE" "$artifact"
else
  s3_validate_config
  if [ -n "$LATEST" ]; then
    case "$LATEST" in daily | weekly | premigration) ;; *) die "--latest must be daily, weekly or premigration" ;; esac
    KEY="$(s3_list "$(s3_prefix)/$LATEST/" | awk '{print $1}' | grep -E '\.dump(\.age)?$' | sort | tail -n 1 || true)"
    [ -n "$KEY" ] || die "no backups found under $(s3_prefix)/$LATEST/"
  fi
  case "$KEY" in *.dump | *.dump.age) ;; *) die "--key must name a .dump or .dump.age object" ;; esac
  artifact="$work/$(basename "$KEY")"
  log "downloading $KEY"
  s3_get_file "$KEY" "$artifact" || die "download failed for $KEY"
  if s3_get_file "$KEY.sha256" "$artifact.sha256" 2>/dev/null; then
    expected="$(cut -d' ' -f1 "$artifact.sha256")"
    [ "$(sha256_of "$artifact")" = "$expected" ] || die "checksum mismatch for $KEY (expected $expected)"
    log "checksum verified sha256=$expected"
  else
    die "checksum sidecar $KEY.sha256 missing; refusing to restore an unverified download"
  fi
fi

dump="$artifact"
case "$artifact" in
  *.age)
    [ -n "$IDENTITY" ] && [ -f "$IDENTITY" ] || die "encrypted backup: pass --identity <age private key file>"
    dump="${artifact%.age}"
    age --decrypt --identity "$IDENTITY" --output "$dump" "$artifact" || die "age decryption failed (wrong key?)"
    ;;
esac

pg_restore --list "$dump" >/dev/null || die "pg_restore --list cannot read the archive; refusing to restore"

if [ "$TARGET" = "$PGDATABASE" ]; then
  warn "OVERWRITING PRODUCTION database '$TARGET' (stop api/worker first)"
  pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error --single-transaction --dbname "$TARGET" "$dump" ||
    die "pg_restore into $TARGET failed"
else
  exists="$(psql --no-psqlrc --tuples-only --no-align --dbname postgres --set ON_ERROR_STOP=1 \
    --command "select 1 from pg_database where datname = '$TARGET'" || die "cannot query pg_database")"
  if [ "$exists" = "1" ]; then
    [ "$REPLACE_TARGET" -eq 1 ] || die "database '$TARGET' already exists; pass --replace-target to drop and recreate it"
    dropdb --if-exists "$TARGET" || die "dropdb $TARGET failed"
  fi
  createdb "$TARGET" || die "createdb $TARGET failed"
  pg_restore --no-owner --no-acl --exit-on-error --single-transaction --dbname "$TARGET" "$dump" ||
    die "pg_restore into $TARGET failed"
fi

log "RESTORE_STATUS=ok target=$TARGET"
log "exact row counts per table (compare with production using --counts-only):"
counts "$TARGET"
