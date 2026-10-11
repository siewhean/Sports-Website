#!/usr/bin/env bash
# Invoked by the nightly systemd unit with the active-slot EnvironmentFile.
set -euo pipefail
[[ "${ACTIVE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo 'Backup refused: ACTIVE_SHA must be an exact deployed release SHA' >&2; exit 2; }
export CANDIDATE_SHA="$ACTIVE_SHA"
exec docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile backup run --rm --no-deps backup backup
