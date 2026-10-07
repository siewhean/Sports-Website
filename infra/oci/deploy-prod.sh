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

STATE_FILE="${MATCHDAY_ACTIVE_SLOT_FILE:-/tmp/matchday-active-slot.env}"
CADDYFILE_PATH="${MATCHDAY_CADDYFILE_PATH:-infra/oci/Caddyfile}"

# Determine currently active slot (default to blue if no prior state)
ACTIVE_SLOT="blue"
if [ -f "$STATE_FILE" ]; then
  # Read ACTIVE_SLOT safely
  val="$(awk -F= '$1 == "ACTIVE_SLOT" { print $2 }' "$STATE_FILE" | tr -d ' \r\n"'\''')"
  if [ "$val" = "green" ]; then
    ACTIVE_SLOT="green"
  fi
fi

if [ "$ACTIVE_SLOT" = "blue" ]; then
  CANDIDATE_SLOT="green"
else
  CANDIDATE_SLOT="blue"
fi

if [ "$CANDIDATE_SLOT" = "green" ]; then
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
RECEIPT_EMITTED=0

emit_receipt() {
  local outcome="$1"
  local failure_reason="${2:-}"
  RECEIPT_EMITTED=1
  local receipt_dir="artifacts"
  mkdir -p "$receipt_dir"
  local receipt_file="$receipt_dir/deploy-receipt.json"
  node -e '
    const fs = require("fs");
    const receipt = {
      timestamp: process.argv[1],
      candidate_sha: process.argv[2],
      active_slot_before: process.argv[3],
      candidate_slot: process.argv[4],
      active_slot_after: process.argv[5],
      outcome: process.argv[6],
      failure_reason: process.argv[7] || null,
      hostname: process.argv[8]
    };
    fs.writeFileSync(process.argv[9], JSON.stringify(receipt, null, 2));
  ' "$BUILD_TIMESTAMP" "$CANDIDATE_SHA" "$ACTIVE_SLOT" "$CANDIDATE_SLOT" "$1" "$outcome" "$failure_reason" "https://${OCI_PUBLIC_HOSTNAME}" "$receipt_file" || true
}

cleanup_and_rollback() {
  local reason="$1"
  echo "[deploy-prod] Automatic rollback initiated. Reason: $reason" >&2
  if [ "$PROMOTED" -eq 1 ]; then
    echo "[deploy-prod] Reverting Caddy routing to active slot $ACTIVE_SLOT ($ACTIVE_API_IP / $ACTIVE_WEB_IP)..." >&2
    python3 -c "
with open('$CADDYFILE_PATH', 'r') as f:
    content = f.read()
updated = content.replace('$CANDIDATE_API_IP:4000', '$ACTIVE_API_IP:4000').replace('trusted_proxies $CANDIDATE_WEB_IP', 'trusted_proxies $ACTIVE_WEB_IP').replace('$CANDIDATE_WEB_IP:3000', '$ACTIVE_WEB_IP:3000')
with open('$CADDYFILE_PATH', 'w') as f:
    f.write(updated)
"
    caddy_container="$(docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml ps -q caddy 2>/dev/null || true)"
    if [ -n "$caddy_container" ]; then
      docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile
    fi
  fi
  echo "[deploy-prod] Stopping candidate slot services ($CANDIDATE_API_SERVICE $CANDIDATE_WEB_SERVICE $CANDIDATE_WORKER_SERVICE)..." >&2
  docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml stop "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE" "$CANDIDATE_WORKER_SERVICE" 2>/dev/null || true
  docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml rm -f "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE" "$CANDIDATE_WORKER_SERVICE" 2>/dev/null || true
  emit_receipt "ROLLBACK" "$reason"
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
caddy_container="$(docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml ps -q caddy 2>/dev/null || true)"
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
candidate_ready=0
for attempt in $(seq 1 30); do
  if docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_API_SERVICE" node -e "fetch('http://127.0.0.1:4000/health/ready').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))" >/dev/null 2>&1; then
    candidate_ready=1
    break
  fi
  sleep 2
done

if [ "$candidate_ready" -ne 1 ]; then
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

echo "[deploy-prod] Promoting traffic to candidate slot $CANDIDATE_SLOT via Caddy..."
python3 -c "
with open('$CADDYFILE_PATH', 'r') as f:
    content = f.read()
updated = content.replace('$ACTIVE_API_IP:4000', '$CANDIDATE_API_IP:4000').replace('trusted_proxies $ACTIVE_WEB_IP', 'trusted_proxies $CANDIDATE_WEB_IP').replace('$ACTIVE_WEB_IP:3000', '$CANDIDATE_WEB_IP:3000')
with open('$CADDYFILE_PATH', 'w') as f:
    f.write(updated)
"
PROMOTED=1

if [ -n "$caddy_container" ]; then
  echo "[deploy-prod] Reloading Caddy configuration..."
  if ! docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
    cleanup_and_rollback "Caddy reload failed during traffic promotion"
  fi
fi

echo "[deploy-prod] Verifying public routed health post-promotion..."
if ! curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/health/ready" >/dev/null; then
  cleanup_and_rollback "Public routed /health/ready probe failed post-promotion"
fi

public_sha="$(curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/api/v1/meta/build" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const b=JSON.parse(d);process.stdout.write(b.git_sha||"");}catch(e){process.exit(1);}});' || true)"
if [ "$public_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Public routed git_sha '$public_sha' does not match candidate '$CANDIDATE_SHA'"
fi

echo "[deploy-prod] Performing sequential worker handover..."
echo "[deploy-prod] Stopping previous worker ($ACTIVE_WORKER_SERVICE)..."
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml stop "$ACTIVE_WORKER_SERVICE" 2>/dev/null || true

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

# Record state
printf 'ACTIVE_SLOT=%s\nACTIVE_SHA=%s\nUPDATED_AT=%s\n' "$CANDIDATE_SLOT" "$CANDIDATE_SHA" "$BUILD_TIMESTAMP" > "$STATE_FILE"

api_image_digest="$(docker inspect --format '{{.Image}}' "$candidate_api_id" 2>/dev/null || echo "unknown")"
worker_image_digest="$(docker inspect --format '{{.Image}}' "$candidate_worker_id" 2>/dev/null || echo "unknown")"

emit_receipt "SUCCESS" ""

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
