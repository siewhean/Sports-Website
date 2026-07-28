#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$ROOT/restored}"
mkdir -p "$OUT/c1" "$OUT/c2"
decode() {
  local target="$1" source="$2"
  mkdir -p "$(dirname "$OUT/$target")"
  if base64 --help 2>&1 | grep -q -- "--decode"; then
    cat "$ROOT/$source"/part-*.b64 | base64 --decode > "$OUT/$target"
  else
    cat "$ROOT/$source"/part-*.b64 | base64 -D > "$OUT/$target"
  fi
}
decode "c1/gate-c-c1-followup-bundle.zip" "chunks/gate-c-c1-followup-bundle.zip"
decode "c1/gate-c-c1-followup.mbox" "chunks/gate-c-c1-followup.mbox"
decode "c1/gate-c-c1-followup.patch" "chunks/gate-c-c1-followup.patch"
decode "c2/gate-c-c2-control-surface-pack.zip" "chunks/gate-c-c2-control-surface-pack.zip"
decode "c2/gate-c-c2-domain-pack.zip" "chunks/gate-c-c2-domain-pack.zip"
decode "c2/gate-c-c2-preparation-bundle.zip" "chunks/gate-c-c2-preparation-bundle.zip"
decode "c2/gate-c-c2-scorecard-pack.zip" "chunks/gate-c-c2-scorecard-pack.zip"
decode "c2/gate-c-c2-wire-pack.zip" "chunks/gate-c-c2-wire-pack.zip"
(cd "$OUT" && shasum -a 256 -c "$ROOT/SHA256SUMS")
echo "Restored Gate C downloads under: $OUT"
