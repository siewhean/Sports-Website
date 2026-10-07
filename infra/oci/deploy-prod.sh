#!/usr/bin/env bash
set -euo pipefail

: "${CANDIDATE_SHA:?Set CANDIDATE_SHA to the full 40-character Git SHA}"
: "${OCI_PUBLIC_HOSTNAME:?Set OCI_PUBLIC_HOSTNAME to the DNS name serving this production stack}"

if [[ ! "$CANDIDATE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "CANDIDATE_SHA must be a full 40-character SHA" >&2
  exit 1
fi
CANDIDATE_SHA="$(printf '%s' "$CANDIDATE_SHA" | tr '[:upper:]' '[:lower:]')"

dns_hostname_pattern='^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
if [[ ${#OCI_PUBLIC_HOSTNAME} -gt 253 || ! "$OCI_PUBLIC_HOSTNAME" =~ $dns_hostname_pattern ]]; then
  echo "OCI_PUBLIC_HOSTNAME must be a DNS hostname without credentials, path, query, or fragment" >&2
  exit 1
fi
OCI_PUBLIC_HOSTNAME="$(printf '%s' "$OCI_PUBLIC_HOSTNAME" | tr '[:upper:]' '[:lower:]')"

test -f infra/oci/.env.prod
env_mode="$(stat -c '%a' infra/oci/.env.prod 2>/dev/null || stat -f '%Lp' infra/oci/.env.prod)"
if [ "$env_mode" != "600" ]; then
  echo "infra/oci/.env.prod must have 600 permissions (got $env_mode)" >&2
  exit 1
fi

test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
test "$(git status --porcelain=v1 --untracked-files=all)" = ""

export CANDIDATE_SHA OCI_PUBLIC_HOSTNAME
export OCI_PROD_ENV_FILE=.env.prod
export BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

# Deployment lock file
DEPLOY_LOCK_FILE="${MATCHDAY_DEPLOY_LOCK_FILE:-/tmp/matchday-deploy.lock}"
mkdir -p "$(dirname "$DEPLOY_LOCK_FILE")"
exec 9>"$DEPLOY_LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    echo "Another deployment is already in progress (lock held on $DEPLOY_LOCK_FILE)" >&2
    exit 1
  fi
else
  if ! python3 -c 'import fcntl, sys; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null; then
    echo "Another deployment is already in progress (lock held on $DEPLOY_LOCK_FILE)" >&2
    exit 1
  fi
fi

STATE_FILE="${MATCHDAY_ACTIVE_SLOT_FILE:-/var/lib/matchday/deploy/active-slot.env}"
SOURCE_CADDY_TEMPLATE="infra/oci/Caddyfile"
RUNTIME_CADDYFILE_PATH="${MATCHDAY_RUNTIME_CADDYFILE_PATH:-/etc/matchday/caddy/Caddyfile}"

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
mkdir -p "$(dirname "$RUNTIME_CADDYFILE_PATH")" 2>/dev/null || true

# If runtime Caddyfile does not exist, initialize from immutable template
if [ ! -f "$RUNTIME_CADDYFILE_PATH" ]; then
  if [ -f "$SOURCE_CADDY_TEMPLATE" ]; then
    cp "$SOURCE_CADDY_TEMPLATE" "$RUNTIME_CADDYFILE_PATH"
  fi
fi

# Function to derive active routing from runtime Caddyfile
derive_caddy_routing() {
  local target_file="$1"
  if [ ! -f "$target_file" ]; then
    echo "missing"
    return
  fi
  python3 -c "
import sys
try:
    with open('$target_file', 'r') as f:
        content = f.read()
    has_blue = ('172.31.0.11:4000' in content) or ('172.31.0.12:3000' in content)
    has_green = ('172.31.0.21:4000' in content) or ('172.31.0.22:3000' in content)
    if has_blue and not has_green:
        print('blue')
    elif has_green and not has_blue:
        print('green')
    else:
        print('ambiguous')
except Exception:
    print('ambiguous')
"
}

caddy_routing="$(derive_caddy_routing "$RUNTIME_CADDYFILE_PATH")"

ACTIVE_SLOT=""
ACTIVE_SHA=""

if [ -f "$STATE_FILE" ]; then
  parsed_slot="$(awk -F= '$1 == "ACTIVE_SLOT" { print $2 }' "$STATE_FILE" | tr -d ' \r\n"'\''')"
  if [ "$parsed_slot" != "blue" ] && [ "$parsed_slot" != "green" ]; then
    echo "ERROR: Invalid ACTIVE_SLOT in $STATE_FILE ('$parsed_slot'). Must be 'blue' or 'green'." >&2
    exit 1
  fi
  parsed_sha="$(awk -F= '$1 == "ACTIVE_SHA" { print $2 }' "$STATE_FILE" | tr -d ' \r\n"'\''')"
  if [ -n "$parsed_sha" ] && [[ ! "$parsed_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: Invalid ACTIVE_SHA in $STATE_FILE ('$parsed_sha'). Must be 40-character hex SHA." >&2
    exit 1
  fi
  ACTIVE_SLOT="$parsed_slot"
  ACTIVE_SHA="$parsed_sha"

  # Reconcile with Caddy routing: must agree
  if [ "$caddy_routing" != "missing" ] && [ "$caddy_routing" != "$ACTIVE_SLOT" ]; then
    echo "AMBIGUOUS_ACTIVE_SLOT: Persistent state records '$ACTIVE_SLOT' but runtime Caddy routes to '$caddy_routing'." >&2
    exit 1
  fi
else
  # State file is missing: reconcile from unambiguous Caddy routing or fail closed
  if [ "$caddy_routing" = "blue" ] || [ "$caddy_routing" = "green" ]; then
    echo "[deploy-prod] State file missing; reconciling active slot from unambiguous Caddy routing: $caddy_routing"
    ACTIVE_SLOT="$caddy_routing"
    # Persist reconciled state
    tmp_state="${STATE_FILE}.tmp.$$"
    printf 'ACTIVE_SLOT=%s\nACTIVE_SHA=\nUPDATED_AT=%s\nRECONCILED=true\n' "$ACTIVE_SLOT" "$BUILD_TIMESTAMP" > "$tmp_state"
    chmod 600 "$tmp_state" 2>/dev/null || true
    mv -f "$tmp_state" "$STATE_FILE"
  else
    echo "AMBIGUOUS_ACTIVE_SLOT: State file is missing and runtime Caddy routing is ambiguous ($caddy_routing)." >&2
    exit 1
  fi
fi

if [ "$ACTIVE_SLOT" = "blue" ]; then
  CANDIDATE_SLOT="green"
  CANDIDATE_API_SERVICE="api-green"
  CANDIDATE_WEB_SERVICE="web-green"
  CANDIDATE_WORKER_SERVICE="worker-green"
  CANDIDATE_API_IP="172.31.0.21"
  CANDIDATE_WEB_IP="172.31.0.22"
  ACTIVE_API_SERVICE="api"
  ACTIVE_WEB_SERVICE="web"
  ACTIVE_WORKER_SERVICE="worker"
  ACTIVE_API_IP="172.31.0.11"
  ACTIVE_WEB_IP="172.31.0.12"
else
  CANDIDATE_SLOT="blue"
  CANDIDATE_API_SERVICE="api"
  CANDIDATE_WEB_SERVICE="web"
  CANDIDATE_WORKER_SERVICE="worker"
  CANDIDATE_API_IP="172.31.0.11"
  CANDIDATE_WEB_IP="172.31.0.12"
  ACTIVE_API_SERVICE="api-green"
  ACTIVE_WEB_SERVICE="web-green"
  ACTIVE_WORKER_SERVICE="worker-green"
  ACTIVE_API_IP="172.31.0.21"
  ACTIVE_WEB_IP="172.31.0.22"
fi

echo "[deploy-prod] Deployment starting: Active Slot=$ACTIVE_SLOT, Candidate Slot=$CANDIDATE_SLOT, Candidate SHA=$CANDIDATE_SHA"

PROMOTED=0
ACTIVE_WORKER_STOPPED=0
WORKER_HANDOVER_STARTED=0
PREVIOUS_RUNTIME_CADDYFILE="${RUNTIME_CADDYFILE_PATH}.prev.$BUILD_TIMESTAMP"
CANDIDATE_RUNTIME_CADDYFILE="${RUNTIME_CADDYFILE_PATH}.candidate.$BUILD_TIMESTAMP"

caddy_env_file="infra/oci/.env.oci"
if [ ! -f "$caddy_env_file" ] && [ -f "infra/oci/.env.prod" ]; then
  caddy_env_file="infra/oci/.env.prod"
fi

emit_receipt() {
  local outcome="$1"
  local active_slot_after="$2"
  local failure_reason="${3:-}"
  local rollback_result="${4:-}"
  local receipt_dir="artifacts"
  mkdir -p "$receipt_dir"
  local receipt_file="$receipt_dir/deploy-receipt.json"

  if [ "${MOCK_RECEIPT_FAILURE:-0}" = "1" ]; then
    return 1
  fi

  node -e '
    const fs = require("fs");
    const [
      timestamp,
      candidateSha,
      activeSlotBefore,
      candidateSlot,
      activeSlotAfter,
      outcome,
      failureReason,
      hostname,
      activeShaBefore,
      promoted,
      workerHandoverStarted,
      rollbackResult,
      receiptPath
    ] = process.argv.slice(1);

    if (!["blue", "green"].includes(activeSlotAfter)) {
      console.error(`Invalid activeSlotAfter in receipt: "${activeSlotAfter}"`);
      process.exit(1);
    }
    if (!["SUCCESS", "ROLLBACK"].includes(outcome)) {
      console.error(`Invalid outcome in receipt: "${outcome}"`);
      process.exit(1);
    }

    const receipt = {
      timestamp,
      candidate_sha: candidateSha,
      active_sha_before: activeShaBefore || null,
      active_slot_before: activeSlotBefore,
      candidate_slot: candidateSlot,
      active_slot_after: activeSlotAfter,
      promoted: promoted === "1",
      worker_handover_started: workerHandoverStarted === "1",
      rollback_result: rollbackResult || null,
      outcome,
      failure_reason: failureReason || null,
      hostname
    };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  ' "$BUILD_TIMESTAMP" \
    "$CANDIDATE_SHA" \
    "$ACTIVE_SLOT" \
    "$CANDIDATE_SLOT" \
    "$active_slot_after" \
    "$outcome" \
    "$failure_reason" \
    "https://${OCI_PUBLIC_HOSTNAME}" \
    "${ACTIVE_SHA:-}" \
    "$PROMOTED" \
    "$WORKER_HANDOVER_STARTED" \
    "$rollback_result" \
    "$receipt_file"
}

cleanup_and_rollback() {
  local reason="$1"
  echo "[deploy-prod] Automatic rollback initiated. Reason: $reason" >&2
  local rollback_result="COMPLETED"

  if [ "$PROMOTED" -eq 1 ]; then
    echo "[deploy-prod] Reverting Caddy routing to active slot $ACTIVE_SLOT ($ACTIVE_API_IP / $ACTIVE_WEB_IP)..." >&2
    if [ -f "$PREVIOUS_RUNTIME_CADDYFILE" ]; then
      cat "$PREVIOUS_RUNTIME_CADDYFILE" > "$RUNTIME_CADDYFILE_PATH"
    fi
    caddy_container="$(docker compose --env-file "$caddy_env_file" -f infra/oci/compose.yaml ps -q caddy 2>/dev/null || true)"
    if [ -n "$caddy_container" ]; then
      if ! docker compose --env-file "$caddy_env_file" -f infra/oci/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
        echo "[deploy-prod] FATAL: Caddy reload failed during rollback!" >&2
        rollback_result="FAILED_CADDY_RELOAD"
      fi
    fi
  fi

  if [ "$ACTIVE_WORKER_STOPPED" -eq 1 ]; then
    echo "[deploy-prod] Restoring previous active worker ($ACTIVE_WORKER_SERVICE)..." >&2
    if ! docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml up -d "$ACTIVE_WORKER_SERVICE"; then
      echo "[deploy-prod] FATAL: Failed to restart previous active worker ($ACTIVE_WORKER_SERVICE) during rollback!" >&2
      rollback_result="FAILED_WORKER_RESTORE"
    else
      active_worker_id="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q "$ACTIVE_WORKER_SERVICE" 2>/dev/null || true)"
      if [ -z "$active_worker_id" ]; then
        echo "[deploy-prod] FATAL: Restored active worker container ID not found!" >&2
        rollback_result="FAILED_WORKER_RESTORE"
      else
        active_worker_state="$(docker inspect --format '{{.State.Status}}' "$active_worker_id" 2>/dev/null || echo "unknown")"
        if [ "$active_worker_state" != "running" ]; then
          echo "[deploy-prod] FATAL: Restored active worker is not running (status: $active_worker_state)!" >&2
          rollback_result="FAILED_WORKER_RESTORE"
        fi
      fi
    fi
  fi

  echo "[deploy-prod] Stopping candidate slot services ($CANDIDATE_API_SERVICE $CANDIDATE_WEB_SERVICE $CANDIDATE_WORKER_SERVICE)..." >&2
  docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml stop "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE" "$CANDIDATE_WORKER_SERVICE" 2>/dev/null || true
  docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml rm -f "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE" "$CANDIDATE_WORKER_SERVICE" 2>/dev/null || true

  rm -f "$PREVIOUS_RUNTIME_CADDYFILE" "$CANDIDATE_RUNTIME_CADDYFILE" 2>/dev/null || true

  if ! emit_receipt "ROLLBACK" "$ACTIVE_SLOT" "$reason" "$rollback_result"; then
    echo "[deploy-prod] WARNING: Failed to write rollback receipt" >&2
  fi

  if [ "$rollback_result" != "COMPLETED" ]; then
    echo "[deploy-prod] CRITICAL: Rollback finished with status $rollback_result" >&2
  fi

  exit 1
}

echo "[deploy-prod] Pre-deploy: validating production configuration..."
node scripts/validate-production-config.mjs infra/oci/.env.prod

echo "[deploy-prod] Pre-deploy: checking migration safety..."
node scripts/certify-gate-f-migrations.mjs "$CANDIDATE_SHA"

# Ensure production backend network exists deterministically
if ! docker network inspect matchday-prod_backend >/dev/null 2>&1; then
  echo "[deploy-prod] Creating matchday-prod_backend network (172.31.0.0/24)..."
  docker network create --subnet 172.31.0.0/24 matchday-prod_backend
fi

# Ensure Caddy is attached to the production backend network
caddy_container="$(docker compose --env-file "$caddy_env_file" -f infra/oci/compose.yaml ps -q caddy 2>/dev/null || true)"
if [ -n "$caddy_container" ]; then
  if ! docker inspect "$caddy_container" --format '{{json .NetworkSettings.Networks}}' 2>/dev/null | grep -q "matchday-prod_backend"; then
    echo "[deploy-prod] Attaching Caddy to matchday-prod_backend..."
    docker network connect matchday-prod_backend "$caddy_container"
  fi
fi

echo "[deploy-prod] Building candidate slot ($CANDIDATE_API_SERVICE, $CANDIDATE_WEB_SERVICE, $CANDIDATE_WORKER_SERVICE)..."
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml build --pull "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE" "$CANDIDATE_WORKER_SERVICE" migrate

echo "[deploy-prod] Running database migrations..."
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile migration run --rm migrate

echo "[deploy-prod] Starting candidate serving slot ($CANDIDATE_API_SERVICE, $CANDIDATE_WEB_SERVICE) alongside active slot $ACTIVE_SLOT..."
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml up -d "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE"

echo "[deploy-prod] Probing candidate API readiness on internal IP ($CANDIDATE_API_IP:4000)..."
candidate_api_ready=0
for attempt in $(seq 1 30); do
  if docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_API_SERVICE" node -e "fetch('http://127.0.0.1:4000/health/ready').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))" >/dev/null 2>&1; then
    candidate_api_ready=1
    break
  fi
  sleep 2
done

if [ "$candidate_api_ready" -ne 1 ]; then
  cleanup_and_rollback "Candidate API failed internal readiness probe"
fi

echo "[deploy-prod] Probing candidate API liveness..."
if ! docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_API_SERVICE" node -e "fetch('http://127.0.0.1:4000/health/live').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))" >/dev/null 2>&1; then
  cleanup_and_rollback "Candidate API failed internal liveness probe"
fi

echo "[deploy-prod] Verifying candidate API build identity..."
actual_sha="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_API_SERVICE" node -e 'fetch("http://127.0.0.1:4000/api/v1/meta/build").then((r) => r.json()).then((b) => process.stdout.write(b.git_sha ?? "")).catch(() => process.exit(1))' 2>/dev/null | tr -d '\r\n')"
if [ "$actual_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate API reported git_sha '$actual_sha' which does not match candidate '$CANDIDATE_SHA'"
fi

api_env="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_API_SERVICE" node -e 'fetch("http://127.0.0.1:4000/api/v1/meta/build").then((r) => r.json()).then((b) => process.stdout.write(b.environment ?? "")).catch(() => process.exit(1))' 2>/dev/null | tr -d '\r\n')"
if [ "$api_env" != "production" ]; then
  cleanup_and_rollback "Candidate API environment is '$api_env', expected 'production'"
fi

candidate_api_id="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q "$CANDIDATE_API_SERVICE")"
candidate_label_sha="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate_api_id" 2>/dev/null || true)"
if [ "$candidate_label_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate API image revision label '$candidate_label_sha' does not match '$CANDIDATE_SHA'"
fi

# Candidate Web Verification before promotion
echo "[deploy-prod] Probing candidate Web readiness on internal port ($CANDIDATE_WEB_IP:3000)..."
candidate_web_ready=0
for attempt in $(seq 1 30); do
  if docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_WEB_SERVICE" node -e "fetch('http://127.0.0.1:3000/').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))" >/dev/null 2>&1; then
    candidate_web_ready=1
    break
  fi
  sleep 2
done

if [ "$candidate_web_ready" -ne 1 ]; then
  cleanup_and_rollback "Candidate Web failed internal readiness probe"
fi

echo "[deploy-prod] Verifying candidate Web build identity..."
candidate_web_build_id="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_WEB_SERVICE" node -e "fetch('http://127.0.0.1:3000/').then(r => process.stdout.write(r.headers.get('x-matchday-build-id') || '')).catch(() => process.exit(1))" 2>/dev/null | tr -d '\r\n')"
if [ "$candidate_web_build_id" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate Web reported build ID '$candidate_web_build_id' which does not match candidate '$CANDIDATE_SHA'"
fi

candidate_web_id="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q "$CANDIDATE_WEB_SERVICE")"
if [ -z "$candidate_web_id" ]; then
  cleanup_and_rollback "Candidate Web container ID not found"
fi

# Atomic Traffic Promotion via Runtime Caddyfile
echo "[deploy-prod] Generating candidate runtime Caddy configuration..."
cp "$RUNTIME_CADDYFILE_PATH" "$PREVIOUS_RUNTIME_CADDYFILE"

python3 -c "
with open('$RUNTIME_CADDYFILE_PATH', 'r') as f:
    content = f.read()
updated = content.replace('$ACTIVE_API_IP:4000', '$CANDIDATE_API_IP:4000').replace('trusted_proxies $ACTIVE_WEB_IP', 'trusted_proxies $CANDIDATE_WEB_IP').replace('$ACTIVE_WEB_IP:3000', '$CANDIDATE_WEB_IP:3000')
with open('$CANDIDATE_RUNTIME_CADDYFILE', 'w') as f:
    f.write(updated)
"

# Validate candidate runtime Caddyfile
if command -v caddy >/dev/null 2>&1; then
  if ! caddy validate --adapter caddyfile --config "$CANDIDATE_RUNTIME_CADDYFILE" >/dev/null 2>&1; then
    cleanup_and_rollback "Candidate runtime Caddyfile failed syntax validation"
  fi
fi

# Atomically replace runtime Caddyfile
cat "$CANDIDATE_RUNTIME_CADDYFILE" > "$RUNTIME_CADDYFILE_PATH"
rm -f "$CANDIDATE_RUNTIME_CADDYFILE"
PROMOTED=1

if [ -n "$caddy_container" ]; then
  echo "[deploy-prod] Reloading Caddy configuration..."
  if ! docker compose --env-file "$caddy_env_file" -f infra/oci/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
    cleanup_and_rollback "Caddy reload failed during traffic promotion"
  fi
fi

# Post-Promotion Routed Health Checks
echo "[deploy-prod] Verifying public routed API health post-promotion..."
if ! curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/health/ready" >/dev/null; then
  cleanup_and_rollback "Public routed /health/ready probe failed post-promotion"
fi

echo "[deploy-prod] Verifying public routed API build identity post-promotion..."
public_api_sha="$(curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/api/v1/meta/build" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const b=JSON.parse(d);process.stdout.write(b.git_sha||"");}catch(e){process.exit(1);}});' || true)"
if [ "$public_api_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Public routed API git_sha '$public_api_sha' does not match candidate '$CANDIDATE_SHA'"
fi

echo "[deploy-prod] Verifying public routed Web health post-promotion..."
if ! curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/" >/dev/null; then
  cleanup_and_rollback "Public routed Web / probe failed post-promotion"
fi

echo "[deploy-prod] Verifying public routed Web build identity post-promotion..."
public_web_build_id="$(curl --connect-timeout 5 --max-time 15 --fail --silent --show-error -D - -o /dev/null "https://${OCI_PUBLIC_HOSTNAME}/" 2>/dev/null | awk 'tolower($1) == "x-matchday-build-id:" { print $2 }' | tr -d '\r\n')"
if [ "$public_web_build_id" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Public routed Web build ID '$public_web_build_id' does not match candidate '$CANDIDATE_SHA'"
fi

# Sequential Worker Handover
echo "[deploy-prod] Performing sequential worker handover..."
WORKER_HANDOVER_STARTED=1
echo "[deploy-prod] Stopping previous worker ($ACTIVE_WORKER_SERVICE)..."
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml stop "$ACTIVE_WORKER_SERVICE"
ACTIVE_WORKER_STOPPED=1

echo "[deploy-prod] Starting candidate worker ($CANDIDATE_WORKER_SERVICE)..."
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml up -d "$CANDIDATE_WORKER_SERVICE"

candidate_worker_id="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q "$CANDIDATE_WORKER_SERVICE")"
if [ -z "$candidate_worker_id" ]; then
  cleanup_and_rollback "Candidate worker container ID not found"
fi

worker_state="$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$candidate_worker_id" 2>/dev/null || echo "unknown")"
if [ "$worker_state" != "running 0" ]; then
  cleanup_and_rollback "Candidate worker failed stability check: $worker_state"
fi

worker_sha="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$candidate_worker_id" 2>/dev/null | awk -F= '$1 == "GIT_SHA" { print $2 }')"
if [ "$worker_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate worker GIT_SHA '$worker_sha' does not match candidate '$CANDIDATE_SHA'"
fi

worker_label_sha="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate_worker_id" 2>/dev/null || true)"
if [ "$worker_label_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate worker revision label '$worker_label_sha' does not match '$CANDIDATE_SHA'"
fi

echo "[deploy-prod] Retiring previous serving slot ($ACTIVE_API_SERVICE, $ACTIVE_WEB_SERVICE)..."
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml stop "$ACTIVE_API_SERVICE" "$ACTIVE_WEB_SERVICE" 2>/dev/null || true
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml rm -f "$ACTIVE_API_SERVICE" "$ACTIVE_WEB_SERVICE" 2>/dev/null || true

# Persist active slot state atomically
tmp_state="${STATE_FILE}.tmp.$$"
printf 'ACTIVE_SLOT=%s\nACTIVE_SHA=%s\nUPDATED_AT=%s\n' "$CANDIDATE_SLOT" "$CANDIDATE_SHA" "$BUILD_TIMESTAMP" > "$tmp_state"
chmod 600 "$tmp_state" 2>/dev/null || true
mv -f "$tmp_state" "$STATE_FILE"

rm -f "$PREVIOUS_RUNTIME_CADDYFILE" 2>/dev/null || true

api_image_digest="$(docker inspect --format '{{.Image}}' "$candidate_api_id" 2>/dev/null || echo "unknown")"
worker_image_digest="$(docker inspect --format '{{.Image}}' "$candidate_worker_id" 2>/dev/null || echo "unknown")"

if ! emit_receipt "SUCCESS" "$CANDIDATE_SLOT" "" ""; then
  echo "[deploy-prod] FATAL: Failed to write deployment receipt" >&2
  exit 1
fi

echo "=================================================="
echo "PRODUCTION DEPLOYMENT SUCCESSFUL"
echo "  Candidate SHA:       $CANDIDATE_SHA"
echo "  Promoted Slot:       $CANDIDATE_SLOT"
echo "  API SHA:             $actual_sha"
echo "  Worker SHA:          $worker_sha"
echo "  Build Timestamp:     $BUILD_TIMESTAMP"
echo "  API Image:           $api_image_digest"
echo "  Worker Image:        $worker_image_digest"
echo "  Hostname:            https://${OCI_PUBLIC_HOSTNAME}"
echo "=================================================="
