#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks dir "$ROOT_DIR" --config "$ROOT_DIR/.gitleaks.toml" --redact --no-banner
fi

exec docker run --rm \
  -v "$ROOT_DIR:/repo:ro" \
  zricethezav/gitleaks:v8.30.1 \
  dir /repo --config /repo/.gitleaks.toml --redact --no-banner
