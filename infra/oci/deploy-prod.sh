#!/usr/bin/env bash
set -euo pipefail

: "${CANDIDATE_SHA:?Set CANDIDATE_SHA to the full 40-character Git SHA}"
: "${OCI_PUBLIC_HOSTNAME:?Set OCI_PUBLIC_HOSTNAME to the DNS name serving this production stack}"

if [[ ! "$CANDIDATE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "CANDIDATE_SHA must be a full 40-character SHA" >&2
  exit 1
fi
CANDIDATE_SHA="$(printf '%s' "$CANDIDATE_SHA" | tr '[:upper:]' '[:lower:]')"

export CANDIDATE_SHA OCI_PUBLIC_HOSTNAME
export OCI_PROD_ENV_FILE=.env.prod
export BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"

test -f infra/oci/.env.prod
node scripts/validate-production-config.mjs infra/oci/.env.prod

echo "[deploy-prod] Pre-deploy: checking migration safety..."
node scripts/certify-gate-f-migrations.mjs "$CANDIDATE_SHA"

echo "[deploy-prod] Building and rolling out production stack..."
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml build --pull api web worker migrate
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile migration run --rm migrate
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml up -d --remove-orphans api web worker

# Update Caddy reverse proxy to ensure production routing
if docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml ps -q caddy >/dev/null 2>&1; then
  docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile || true
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

actual_sha="$(docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T api node -e 'fetch("http://127.0.0.1:4000/api/v1/meta/build").then((r) => r.json()).then((b) => process.stdout.write(b.git_sha ?? "")).catch(() => process.exit(1))' | tr -d '\r\n')"
test "$actual_sha" = "$CANDIDATE_SHA"
echo "Production stack verified and running at SHA: $actual_sha"
