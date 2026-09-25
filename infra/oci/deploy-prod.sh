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

echo "[deploy-prod] Building and rolling out production stack..."
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml build --pull api web worker migrate
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile migration run --rm migrate
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml up -d --remove-orphans api web worker

# Reload Caddy reverse proxy; fail closed if reload fails
if [ -n "$caddy_container" ]; then
  echo "[deploy-prod] Reloading Caddy with updated configuration..."
  docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile
fi

echo "[deploy-prod] Awaiting readiness on internal API..."
for attempt in $(seq 1 30); do
  if docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T api node -e "fetch('http://127.0.0.1:4000/health/ready').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "Production API failed readiness probe" >&2
    docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps
    exit 1
  fi
  sleep 2
done

echo "[deploy-prod] Verifying release identities..."
actual_sha="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T api node -e 'fetch("http://127.0.0.1:4000/api/v1/meta/build").then((r) => r.json()).then((b) => process.stdout.write(b.git_sha ?? "")).catch(() => process.exit(1))' | tr -d '\r\n')"
test "$actual_sha" = "$CANDIDATE_SHA"

api_env="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T api node -e 'fetch("http://127.0.0.1:4000/api/v1/meta/build").then((r) => r.json()).then((b) => process.stdout.write(b.environment ?? "")).catch(() => process.exit(1))' | tr -d '\r\n')"
test "$api_env" = "production"

worker_id="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q worker)"
test -n "$worker_id"
worker_state="$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$worker_id")"
if test "$worker_state" != "running 0"; then
  echo "OCI production worker failed stability check: $worker_state" >&2
  exit 1
fi
worker_sha="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$worker_id" | awk -F= '$1 == "GIT_SHA" { print $2 }')"
test "$worker_sha" = "$CANDIDATE_SHA"

worker_label_sha="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$worker_id")"
test "$worker_label_sha" = "$CANDIDATE_SHA"

api_id="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q api)"
api_label_sha="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$api_id")"
test "$api_label_sha" = "$CANDIDATE_SHA"

echo "[deploy-prod] Verifying public Caddy ingress..."
curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/health/ready" >/dev/null
public_sha="$(curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/api/v1/meta/build" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const b=JSON.parse(d);process.stdout.write(b.git_sha||"");});')"
test "$public_sha" = "$CANDIDATE_SHA"

# Capture image digests for release attestation
api_image_digest="$(docker inspect --format '{{.Image}}' "$api_id")"
worker_image_digest="$(docker inspect --format '{{.Image}}' "$worker_id")"

echo "=================================================="
echo "PRODUCTION DEPLOYMENT SUCCESSFUL"
echo "  Candidate SHA:       $CANDIDATE_SHA"
echo "  API SHA:             $actual_sha"
echo "  Worker SHA:          $worker_sha"
echo "  Build Timestamp:     $BUILD_TIMESTAMP"
echo "  API Image:           $api_image_digest"
echo "  Worker Image:        $worker_image_digest"
echo "  Hostname:            https://${OCI_PUBLIC_HOSTNAME}"
echo "=================================================="

