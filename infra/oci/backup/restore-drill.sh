#!/usr/bin/env bash
# Monthly restore rehearsal (not Gate F production certification), run from the operator's machine (the age private key never leaves it except
# into the VM's RAM-backed /dev/shm for the duration of the drill).
#
#   infra/oci/backup/restore-drill.sh [--key ~/matchday-backup.agekey] [--host opc@129.146.6.204]
#                                     [--ssh-key ~/.ssh/matchday-c5-staging-oracle.key] [--latest daily|weekly|premigration]
#
# Steps: take a fresh backup, restore the newest backup of the chosen kind into a scratch database,
# compare exact per-table row counts with production, then drop the scratch database and remove the
# staged key. Prints RESTORE_DRILL=PASS or RESTORE_DRILL=FAIL and exits non-zero on failure.
# See docs/operations/BACKUP_RESTORE.md ("Restore drill").
set -euo pipefail

AGE_KEY="${HOME}/matchday-backup.agekey"
HOST="${MATCHDAY_VM:-opc@129.146.6.204}"
SSH_KEY="${MATCHDAY_VM_SSH_KEY:-${HOME}/.ssh/matchday-c5-staging-oracle.key}"
KIND="daily"
REMOTE_DIR="/opt/matchday/oci-src"
SCRATCH_DB="matchday_restore_drill"

while [ $# -gt 0 ]; do
  case "$1" in
    --key) AGE_KEY="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --latest) KIND="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$KIND" in daily|weekly|premigration) ;; *) echo "--latest must be daily, weekly or premigration" >&2; exit 2 ;; esac
[ -r "$AGE_KEY" ] || { echo "age private key not readable: $AGE_KEY" >&2; exit 2; }
[ -r "$SSH_KEY" ] || { echo "ssh key not readable: $SSH_KEY" >&2; exit 2; }

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -i "$SSH_KEY" "$HOST")

CLEANED_UP=0
cleanup() {
  [ "$CLEANED_UP" -eq 0 ] || return 0
  # Always remove the staged key and the scratch database, even after a failure.
  "${SSH[@]}" "cleanup_failed=0; cd $REMOTE_DIR || exit 1; docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T postgres \
      sh -c 'dropdb --if-exists -U \"\$POSTGRES_USER\" $SCRATCH_DB' >/dev/null 2>&1 || cleanup_failed=1; \
    shred -u /dev/shm/matchday-backup.agekey 2>/dev/null || rm -f /dev/shm/matchday-backup.agekey || cleanup_failed=1; \
    rm -f /tmp/drill-counts-prod.txt /tmp/drill-counts-restored.txt || cleanup_failed=1; exit \$cleanup_failed" 2>/dev/null || return 1
  CLEANED_UP=1
}
on_exit() {
  local rc=$?
  trap - EXIT
  cleanup || { echo "RESTORE_DRILL=FAIL cleanup failed; operator must remove staged key and scratch database" >&2; rc=1; }
  exit "$rc"
}
trap on_exit EXIT

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[drill] $started staging key in VM RAM (/dev/shm)"
"${SSH[@]}" 'umask 077; cat > /dev/shm/matchday-backup.agekey && chmod 400 /dev/shm/matchday-backup.agekey' < "$AGE_KEY"

echo "[drill] running fresh backup, restore of newest '$KIND' into $SCRATCH_DB, and row-count comparison"
# shellcheck disable=SC2016  # expanded on the VM, not locally
if result="$("${SSH[@]}" "set -euo pipefail; cd $REMOTE_DIR
  . /var/lib/matchday/deploy/active-slot.env
  printf %s \"\$ACTIVE_SHA\" | grep -Eq \"^[0-9a-f]{40}\"
  export CANDIDATE_SHA=\"\$ACTIVE_SHA\" BUILD_TIMESTAMP=drill
  C='docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile backup run --rm --no-deps'
  R=\"\$C -v /dev/shm/matchday-backup.agekey:/identity/key.txt:ro --entrypoint /opt/matchday-backup/restore-postgres.sh backup\"
  \$C backup backup 2>&1 | grep -E 'BACKUP_STATUS' | tail -1
  t0=\$(date -u +%s)
  \$R --latest $KIND --target-db $SCRATCH_DB --identity /identity/key.txt --replace-target 2>&1 | grep -E 'RESTORE_STATUS' | tail -1
  echo \"RESTORE_SECONDS=\$(( \$(date -u +%s) - t0 ))\"
  \$R --counts-only --target-db matchday_prod > /tmp/drill-counts-prod.txt 2>/dev/null
  \$R --counts-only --target-db $SCRATCH_DB > /tmp/drill-counts-restored.txt 2>/dev/null
  echo \"TABLES=\$(grep -c '|' /tmp/drill-counts-restored.txt)\"
  if diff -q /tmp/drill-counts-prod.txt /tmp/drill-counts-restored.txt >/dev/null; then echo COUNTS=MATCH
  else echo COUNTS=DIFFER; diff /tmp/drill-counts-prod.txt /tmp/drill-counts-restored.txt | head -20; fi" 2>&1)"; then
  remote_status=0
else
  remote_status=$?
fi

echo "$result"
if [ "$remote_status" -eq 0 ] && grep -q 'BACKUP_STATUS=ok' <<<"$result" && grep -q 'RESTORE_STATUS=ok' <<<"$result" && grep -q 'COUNTS=MATCH' <<<"$result"; then
  cleanup || { echo "RESTORE_DRILL=FAIL cleanup failed; operator must remove staged key and scratch database" >&2; exit 1; }
  echo "RESTORE_DRILL=PASS started=$started kind=$KIND evidence_scope=same_host_row_count_rehearsal production_certification=false"
  echo "Record this result (date, restore seconds, table count) in your operations log."
  exit 0
fi
echo "RESTORE_DRILL=FAIL started=$started kind=$KIND (rows written between the fresh backup and the count can differ slightly; re-run at a quiet time before investigating)" >&2
exit 1
