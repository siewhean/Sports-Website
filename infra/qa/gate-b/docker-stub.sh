#!/usr/bin/env bash
set -euo pipefail

if [[ "${GATE_B_MANAGE_INFRA:-1}" == "0" && "${1:-}" == "compose" ]]; then
  echo "Gate B QA infrastructure is supplied by the outer Compose project."
  exit 0
fi

echo "Docker is intentionally unavailable inside the Gate B QA runner." >&2
exit 127
