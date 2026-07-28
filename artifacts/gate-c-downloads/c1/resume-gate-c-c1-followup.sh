#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/Documents/Sports Website}"
EXPECTED_BRANCH="fix/gate-c-c1-follow-up"
EXPECTED_HEAD="c0aa517e6a34221f480d6b1075010233133a99a5"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$REPO/artifacts/qa/gate-c-access/c1-follow-up-$STAMP"
mkdir -p "$OUT"

cd "$REPO"
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
hash -r

[[ "$(node --version)" == "v24.18.0" ]]
[[ "$(pnpm --version)" == "10.33.0" ]]
[[ "$(git branch --show-current)" == "$EXPECTED_BRANCH" ]]
[[ "$(git rev-parse HEAD)" == "$EXPECTED_HEAD" ]]

run() {
  local label="$1"; shift
  set +e
  "$@" 2>&1 | tee "$OUT/$label.log"
  local status=${PIPESTATUS[0]}
  set -e
  printf 'EXIT[%s]=%s\n' "$label" "$status" | tee -a "$OUT/$label.log"
  [[ $status -eq 0 ]]
}

run 01-collision pnpm --filter @matchday/api exec vitest run \
  tests/integration/gate-c-access-collision.test.ts
run 02-api-typecheck pnpm --filter @matchday/api typecheck
run 03-web-typecheck pnpm --filter @matchday/web typecheck
run 04-format pnpm exec prettier --check \
  apps/api/src/phase-2-runtime.ts \
  apps/api/tests/integration/gate-c-access-collision.test.ts \
  apps/web/app/globals.css \
  apps/web/tests/gate-c-access-real.spec.ts \
  docs/decisions/0002-scoring-access-hmac-rotation.md

GATE_C_ACCESS_EVIDENCE_DIR="$OUT/browser" \
  run 10-gate-c-access-browser-matrix \
  pnpm --filter @matchday/api exec tsx scripts/run-gate-c-access-e2e.ts

run 20-diff-check git diff --check

echo "RESULT=FOCUSED_C1_FOLLOWUP_PASS" | tee "$OUT/RESULT"
