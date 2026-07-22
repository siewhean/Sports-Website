#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/qa/gate-b/compose.yaml"

cleanup() {
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

mkdir -p "$ROOT_DIR/artifacts/qa/gate-b"
docker compose -f "$COMPOSE_FILE" build --pull gate-b
set +e
docker compose -f "$COMPOSE_FILE" run --rm gate-b
status=$?
set -e

if [[ $status -ne 0 ]]; then
  echo "Gate B container validation failed. Review artifacts/qa/gate-b/container." >&2
  exit "$status"
fi

echo "Gate B container validation passed. Evidence is in artifacts/qa/gate-b/container."
