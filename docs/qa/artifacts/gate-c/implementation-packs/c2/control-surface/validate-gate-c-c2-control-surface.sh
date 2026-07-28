#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-}"
if [[ -z "$ROOT" ]]; then
  echo "usage: $0 /path/to/Sports\ Website" >&2
  exit 2
fi

cd "$ROOT"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
export PATH="$NVM_DIR/versions/node/v24.18.0/bin:$PATH"
hash -r

[[ "$(node --version)" == "v24.18.0" ]] || {
  echo "Node v24.18.0 is required" >&2
  exit 1
}
[[ "$(pnpm --version)" == "10.33.0" ]] || {
  echo "pnpm 10.33.0 is required" >&2
  exit 1
}

for path in \
  apps/web/lib/five-sport-score-control-actions.ts \
  apps/web/lib/five-sport-score-control-actions.test.ts \
  apps/web/components/phase5/FiveSportScoreControls.tsx \
  apps/web/components/phase5/FiveSportScoreControls.module.css; do
  [[ -f "$path" ]] || {
    echo "missing $path" >&2
    exit 1
  }
done

git diff --check

pnpm exec prettier --check \
  apps/web/lib/five-sport-score-control-actions.ts \
  apps/web/lib/five-sport-score-control-actions.test.ts \
  apps/web/components/phase5/FiveSportScoreControls.tsx \
  apps/web/components/phase5/FiveSportScoreControls.module.css

pnpm --filter @matchday/web typecheck
pnpm --filter @matchday/web exec vitest run \
  lib/five-sport-scorecard.test.ts \
  lib/five-sport-score-control-actions.test.ts \
  --reporter=verbose
pnpm --filter @matchday/web test:unit
pnpm --filter @matchday/web build

git diff --check
echo "RESULT=C2_SHARED_CONTROL_SURFACE_PASS"
