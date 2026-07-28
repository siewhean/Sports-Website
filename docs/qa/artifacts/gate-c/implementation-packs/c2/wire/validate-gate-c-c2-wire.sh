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
  packages/domain/src/five-sport-scoring-wire.ts \
  packages/domain/tests/gate-c-five-sport-scoring-wire.test.ts; do
  [[ -f "$path" ]] || {
    echo "missing $path" >&2
    exit 1
  }
done

git diff --check

pnpm exec prettier --check \
  packages/domain/src/five-sport-scoring-wire.ts \
  packages/domain/src/index.ts \
  packages/domain/tests/gate-c-five-sport-scoring-wire.test.ts

pnpm --filter @matchday/domain typecheck
pnpm --filter @matchday/domain exec vitest run \
  tests/gate-c-five-sport-scoring-wire.test.ts \
  --reporter=verbose
pnpm --filter @matchday/domain test:unit
pnpm --filter @matchday/domain build

git diff --check
echo "RESULT=C2_WIRE_CONTRACT_PASS"
