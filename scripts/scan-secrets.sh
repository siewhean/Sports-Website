#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT_DIR/.gitleaks.toml"

if command -v gitleaks >/dev/null 2>&1; then
  if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    exec gitleaks git "$ROOT_DIR" --log-opts="--all" --config "$CONFIG" --redact --no-banner
  fi
  exec gitleaks dir "$ROOT_DIR" --config "$CONFIG" --redact --no-banner
fi

if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exec docker run --rm \
    -v "$ROOT_DIR:/repo:ro" \
    zricethezav/gitleaks:v8.30.1 \
    git /repo --log-opts="--all" --config /repo/.gitleaks.toml --redact --no-banner
fi

exec docker run --rm \
  -v "$ROOT_DIR:/repo:ro" \
  zricethezav/gitleaks:v8.30.1 \
  dir /repo --config /repo/.gitleaks.toml --redact --no-banner
