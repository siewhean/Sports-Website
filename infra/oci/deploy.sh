#!/usr/bin/env bash
set -euo pipefail

: "${CANDIDATE_SHA:?Set CANDIDATE_SHA to the full 40-character Git SHA}"
: "${OCI_PUBLIC_HOSTNAME:?Set OCI_PUBLIC_HOSTNAME to the DNS name serving this VM}"

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

test -f infra/oci/.env.oci
env_mode="$(stat -c '%a' infra/oci/.env.oci 2>/dev/null || stat -f '%Lp' infra/oci/.env.oci)"
test "$env_mode" = "600"
if grep -Fn "CHANGE_ME" infra/oci/.env.oci; then
  echo "Replace every CHANGE_ME placeholder in infra/oci/.env.oci before deploying" >&2
  exit 1
fi
env_candidate_sha="$(sed -n 's/^CANDIDATE_SHA=//p' infra/oci/.env.oci | head -n 1 | tr '[:upper:]' '[:lower:]')"
if test "$env_candidate_sha" != "$CANDIDATE_SHA"; then
  echo "infra/oci/.env.oci CANDIDATE_SHA must match the requested candidate" >&2
  exit 1
fi
test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
test "$(git status --porcelain=v1 --untracked-files=all)" = ""

export OCI_PUBLIC_HOSTNAME
export OCI_ENV_FILE=.env.oci
export BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
compose_config="$(docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml config)"
for expected in \
  "API_ALLOWED_ORIGINS: https://${OCI_PUBLIC_HOSTNAME}" \
  "MATCHDAY_PUBLIC_ORIGIN: https://${OCI_PUBLIC_HOSTNAME}" \
  "IDENTITY_OIDC_CALLBACK_URI: https://${OCI_PUBLIC_HOSTNAME}/api/v1/identity/callback" \
  "IDENTITY_HOSTED_RECOVERY_URL: https://${OCI_PUBLIC_HOSTNAME}/recover" \
  "IDENTITY_POST_AUTH_REDIRECT_URIS: https://${OCI_PUBLIC_HOSTNAME}/organiser"; do
  if ! grep -Fq "$expected" <<<"$compose_config"; then
    echo "OCI environment is inconsistent with OCI_PUBLIC_HOSTNAME: $expected" >&2
    exit 1
  fi
done
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml build --pull api web worker migrate
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml --profile migration run --rm migrate
docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml up -d --remove-orphans api web worker caddy

for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/health/ready" >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "OCI API did not become ready within 300 seconds" >&2
    docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml ps
    exit 1
  fi
  sleep 5
done

actual_sha="$(docker compose --env-file infra/oci/.env.oci -f infra/oci/compose.yaml exec -T api node -e 'fetch("http://127.0.0.1:4000/api/v1/meta/build").then((response) => response.json()).then((body) => process.stdout.write(body.git_sha ?? "")).catch(() => process.exit(1))' | tr -d '\r\n')"
test "$actual_sha" = "$CANDIDATE_SHA"
web_build_id="$(curl --fail --silent --show-error -D - -o /dev/null "https://${OCI_PUBLIC_HOSTNAME}/" | awk 'tolower($1) == "x-matchday-build-id:" { print $2; exit }' | tr -d '\r\n')"
test "$web_build_id" = "$CANDIDATE_SHA"
echo "OCI deployment ready at https://${OCI_PUBLIC_HOSTNAME} for $CANDIDATE_SHA"
