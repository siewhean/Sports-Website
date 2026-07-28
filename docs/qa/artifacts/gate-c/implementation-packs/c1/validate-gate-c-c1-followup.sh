#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/Documents/Sports Website}"
cd "$REPO"

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
export PATH="$NVM_DIR/versions/node/v24.18.0/bin:$PATH"
hash -r

[[ "$(node --version)" == "v24.18.0" ]]
[[ "$(pnpm --version)" == "10.33.0" ]]

git diff --cached --check
pnpm exec prettier --check \
  apps/api/src/phase-2-runtime.ts \
  apps/api/tests/integration/gate-c-access-collision.test.ts \
  apps/web/app/globals.css \
  apps/web/tests/gate-c-access-real.spec.ts \
  docs/decisions/0002-scoring-access-hmac-rotation.md
pnpm --filter @matchday/api typecheck
RUN_INFRA_TESTS=1 pnpm --filter @matchday/api exec vitest run \
  tests/integration/gate-c-access-collision.test.ts
pnpm --filter @matchday/web typecheck
pnpm --filter @matchday/web exec playwright test \
  --config playwright.gate-c-access.config.ts

echo
printf 'Focused C1 follow-up checks passed. Run the existing complete 31-command C1 ledger before committing or certifying.\n'
