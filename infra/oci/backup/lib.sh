#!/usr/bin/env bash
# Shared helpers for the MATCHDAY production backup/restore tooling.
# Sourced by matchday-backup.sh and restore-postgres.sh; not executable on its own.
# Talks to OCI Object Storage through its S3-compatible API (path-style, SigV4)
# using curl only, so the tool image needs no AWS CLI.

LOG_TAG="${LOG_TAG:-backup}"

log() { printf '[%s] %s %s\n' "$LOG_TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { printf '[%s] %s WARNING: %s\n' "$LOG_TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  printf '[%s] %s ERROR: %s\n' "$LOG_TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit 1
}

require_env() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "required environment variable $name is not set"
  done
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

size_of() { wc -c <"$1" | tr -d '[:space:]'; }

# True when every variable needed for the off-host copy is present.
s3_configured() {
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ] &&
    [ -n "${BACKUP_S3_REGION:-}" ] && [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ] &&
    [ -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]
}

s3_validate_config() {
  require_env BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_REGION BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
  case "$BACKUP_S3_ENDPOINT" in
    https://*) ;;
    http://127.0.0.1* | http://localhost*) ;; # local test double only
    *) die "BACKUP_S3_ENDPOINT must be an https:// URL (got '$BACKUP_S3_ENDPOINT')" ;;
  esac
  BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT%/}"
  case "$BACKUP_S3_BUCKET" in
    *[!a-zA-Z0-9._-]* | "") die "BACKUP_S3_BUCKET contains invalid characters" ;;
  esac
}

s3_prefix() {
  local p="${BACKUP_S3_PREFIX:-postgres}"
  p="${p#/}"
  p="${p%/}"
  printf '%s' "$p"
}

s3_url() { printf '%s/%s/%s' "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_BUCKET" "$1"; }

# s3_curl METHOD KEY [curl args...]
# The credential is fed through a curl config on stdin so it never appears in argv.
s3_curl() {
  local method="$1" key="$2"
  shift 2
  printf 'user = "%s:%s"\n' "$BACKUP_S3_ACCESS_KEY_ID" "$BACKUP_S3_SECRET_ACCESS_KEY" |
    curl --silent --show-error --fail --config - \
      --max-time "${BACKUP_S3_TIMEOUT:-600}" \
      --request "$method" \
      --aws-sigv4 "aws:amz:${BACKUP_S3_REGION}:s3" \
      "$@" "$(s3_url "$key")"
}

s3_put_file() { # KEY FILE
  local key="$1" file="$2" sha
  sha="$(sha256_of "$file")"
  s3_curl PUT "$key" --upload-file "$file" \
    -H "x-amz-content-sha256: ${sha}" \
    -H "Content-Type: application/octet-stream" --output /dev/null
}

s3_put_text() { # KEY TEXT
  local key="$1" text="$2" tmp
  tmp="$(mktemp)"
  printf '%s\n' "$text" >"$tmp"
  if ! s3_put_file "$key" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
}

s3_get_file() { # KEY DEST
  s3_curl GET "$1" --output "$2"
}

s3_delete() { s3_curl DELETE "$1" --output /dev/null; }

# Prints "KEY SIZE" lines for every object under the given prefix (sorted by key).
# Single page only (<=1000 keys), far above the retention counts used here.
s3_list() { # PREFIX
  local encoded
  encoded="$(printf '%s' "$1" | sed 's#/#%2F#g')"
  # The query string rides on the "key" so it is part of the signed URL.
  s3_curl GET "?list-type=2&max-keys=1000&prefix=${encoded}" |
    tr '\n' ' ' | sed 's#</Contents>#\n#g' |
    sed -n 's#.*<Key>\([^<]*\)</Key>.*<Size>\([0-9]*\)</Size>.*#\1 \2#p' | sort
}

# Keep the newest KEEP payload objects (*.dump / *.dump.age) under PREFIX and delete the
# rest along with their .sha256 sidecars. Key names embed a UTC timestamp, so a lexical
# sort is chronological.
s3_prune() { # PREFIX KEEP
  local prefix="$1" keep="$2" listing payloads kept key base deleted=0
  if ! [[ "$keep" =~ ^[0-9]+$ ]] || [ "$keep" -lt 1 ]; then
    die "retention count for $prefix must be a positive integer (got '$keep')"
  fi
  listing="$(s3_list "$prefix")" || die "failed listing $prefix for retention"
  payloads="$(printf '%s\n' "$listing" | awk '{print $1}' | grep -E '\.dump(\.age)?$' | sort -r || true)"
  kept="$(printf '%s\n' "$payloads" | head -n "$keep")"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    base="${key%.sha256}"
    if ! printf '%s\n' "$kept" | grep -Fxq "$base"; then
      s3_delete "$key" || die "failed deleting expired backup object $key"
      deleted=$((deleted + 1))
    fi
  done < <(printf '%s\n' "$listing" | awk '{print $1}')
  log "retention: prefix=$prefix kept=$(printf '%s\n' "$kept" | grep -c . || true) deleted_objects=$deleted"
}

# Upload FILE to KEY, upload a sha256 sidecar, then verify by size and by re-downloading
# and hashing (set BACKUP_VERIFY_DOWNLOAD=0 for size-only on very large dumps).
s3_upload_verified() { # KEY FILE
  local key="$1" file="$2" sha size remote_size check
  sha="$(sha256_of "$file")"
  size="$(size_of "$file")"
  s3_put_file "$key" "$file" || die "upload failed for $key"
  s3_put_text "${key}.sha256" "${sha}  $(basename "$key")" || die "upload failed for ${key}.sha256"
  remote_size="$(s3_list "$key" | awk -v k="$key" '$1 == k {print $2}')"
  [ "$remote_size" = "$size" ] || die "size verification failed for $key (local=$size remote=${remote_size:-missing})"
  if [ "${BACKUP_VERIFY_DOWNLOAD:-1}" = "1" ]; then
    check="$(mktemp)"
    if ! s3_get_file "$key" "$check"; then
      rm -f "$check"
      die "verification download failed for $key"
    fi
    if [ "$(sha256_of "$check")" != "$sha" ]; then
      rm -f "$check"
      die "checksum verification failed for $key"
    fi
    rm -f "$check"
  fi
  log "uploaded and verified key=$key bytes=$size sha256=$sha"
}
