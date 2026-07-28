#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/Documents/Sports Website}"
cd "$REPO"

export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
hash -r

[[ "$(node --version)" == "v24.18.0" ]]
[[ "$(pnpm --version)" == "10.33.0" ]]

pnpm --filter @matchday/api exec vitest run \
  tests/integration/gate-c-access-collision.test.ts
pnpm --filter @matchday/api typecheck
pnpm --filter @matchday/web typecheck
pnpm exec prettier --check \
  apps/api/src/phase-2-runtime.ts \
  apps/api/tests/integration/gate-c-access-collision.test.ts \
  apps/web/app/globals.css \
  apps/web/tests/gate-c-access-real.spec.ts \
  docs/decisions/0002-scoring-access-hmac-rotation.md
git diff --check

echo "Focused C1 follow-up checks passed. Run the canonical browser wrapper and complete ledger next."
