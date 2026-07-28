#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/Documents/Sports Website}"
cd "$REPO"

export NVM_DIR="$HOME/.nvm"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi
export PATH="$NVM_DIR/versions/node/v24.18.0/bin:$PATH"
hash -r 2>/dev/null || true

NODE_VERSION="$(node --version)"
PNPM_VERSION="$(pnpm --version)"
BRANCH="$(git branch --show-current)"
HEAD_SHA="$(git rev-parse HEAD)"

if [[ "$NODE_VERSION" != "v24.18.0" ]]; then
  echo "STOP: expected Node v24.18.0, got $NODE_VERSION" >&2
  exit 1
fi
if [[ "$PNPM_VERSION" != "10.33.0" ]]; then
  echo "STOP: expected pnpm 10.33.0, got $PNPM_VERSION" >&2
  exit 1
fi
if [[ "$BRANCH" != "fix/gate-c-c1-follow-up" ]]; then
  echo "STOP: expected branch fix/gate-c-c1-follow-up, got $BRANCH" >&2
  exit 1
fi
if [[ "$HEAD_SHA" != "c0aa517e6a34221f480d6b1075010233133a99a5" ]]; then
  echo "STOP: expected starting HEAD c0aa517e6a34221f480d6b1075010233133a99a5, got $HEAD_SHA" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="artifacts/qa/gate-c-access/c1-follow-up-$STAMP"
LOG_DIR="$EVIDENCE_DIR/logs"
mkdir -p "$LOG_DIR"

{
  echo "node=$NODE_VERSION"
  echo "pnpm=$PNPM_VERSION"
  echo "branch=$BRANCH"
  echo "starting_head=$HEAD_SHA"
  echo "started_at_utc=$STAMP"
  echo "working_tree_before:"
  git status --short
} | tee "$LOG_DIR/00-environment.log"

run_logged() {
  local label="$1"
  shift
  echo "COMMAND[$label]: $*" | tee "$LOG_DIR/$label.log"
  set +e
  "$@" 2>&1 | tee -a "$LOG_DIR/$label.log"
  local status=${PIPESTATUS[0]}
  set -e
  echo "EXIT[$label]=$status" | tee -a "$LOG_DIR/$label.log"
  if [[ $status -ne 0 ]]; then
    echo "STOP: $label failed with exit $status" >&2
    exit "$status"
  fi
}

run_logged 10-gate-c-access-browser-matrix \
  env GATE_C_ACCESS_EVIDENCE_DIR="$EVIDENCE_DIR/browser" \
  pnpm --filter @matchday/api exec tsx scripts/run-gate-c-access-e2e.ts

run_logged 20-collision-integration \
  pnpm --filter @matchday/api exec vitest run tests/integration/gate-c-access-collision.test.ts

run_logged 21-api-typecheck pnpm --filter @matchday/api typecheck
run_logged 22-web-typecheck pnpm --filter @matchday/web typecheck
run_logged 23-prettier pnpm exec prettier --check \
  apps/api/src/phase-2-runtime.ts \
  apps/api/tests/integration/gate-c-access-collision.test.ts \
  apps/web/app/globals.css \
  apps/web/tests/gate-c-access-real.spec.ts \
  docs/decisions/0002-scoring-access-hmac-rotation.md
run_logged 24-diff-check git diff --check

{
  echo "completed_at_utc=$(date -u +%Y%m%dT%H%M%SZ)"
  echo "ending_head=$(git rev-parse HEAD)"
  echo "working_tree_after:"
  git status --short
  echo "RESULT=FOCUSED_C1_FOLLOWUP_PASS"
} | tee "$LOG_DIR/99-summary.log"

echo
printf 'Focused C1 follow-up validation passed. Evidence: %s\n' "$EVIDENCE_DIR"
printf 'Next: inspect screenshots/diffs, then run the repository complete 31-command C1 ledger before committing a new source SHA.\n'
