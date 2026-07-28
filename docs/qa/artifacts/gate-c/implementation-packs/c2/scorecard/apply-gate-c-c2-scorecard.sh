#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-}"
if [[ -z "$ROOT" ]]; then
  echo "usage: $0 /path/to/Sports\ Website" >&2
  exit 2
fi
if [[ -z "${C2_DOMAIN_SOURCE_SHA:-}" ]]; then
  echo "C2_DOMAIN_SOURCE_SHA is required" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$SCRIPT_DIR/gate-c-c2-scorecard.patch"
EXPECTED_PATCH_SHA="ec2d8bb8a8de72b883a1ef80840e096a6134762e825abb6fb7db0ba2b4dc1ebf"
ORIGINAL_C1_EVIDENCE="c0aa517e6a34221f480d6b1075010233133a99a5"

cd "$ROOT"

[[ "$(git status --short)" == "" ]] || {
  echo "working tree must be clean before applying the scorecard adapter" >&2
  git status --short >&2
  exit 1
}

HEAD_SHA="$(git rev-parse HEAD)"
[[ "$HEAD_SHA" == "$C2_DOMAIN_SOURCE_SHA" ]] || {
  echo "HEAD must equal C2_DOMAIN_SOURCE_SHA" >&2
  echo "HEAD=$HEAD_SHA" >&2
  echo "EXPECTED=$C2_DOMAIN_SOURCE_SHA" >&2
  exit 1
}

git merge-base --is-ancestor "$ORIGINAL_C1_EVIDENCE" HEAD || {
  echo "C2 branch does not descend from the certified C1 evidence history" >&2
  exit 1
}

for path in \
  packages/domain/src/five-sport-scoring.ts \
  packages/domain/tests/gate-c-five-sport-scoring.test.ts; do
  [[ -f "$path" ]] || {
    echo "missing accepted C2 domain prerequisite: $path" >&2
    exit 1
  }
done

for path in \
  apps/web/lib/five-sport-scorecard.ts \
  apps/web/lib/five-sport-scorecard.test.ts; do
  [[ ! -e "$path" ]] || {
    echo "refusing to overwrite existing $path" >&2
    exit 1
  }
done

ACTUAL_PATCH_SHA="$(sha256sum "$PATCH" | awk '{print $1}')"
[[ "$ACTUAL_PATCH_SHA" == "$EXPECTED_PATCH_SHA" ]] || {
  echo "patch checksum mismatch" >&2
  echo "actual=$ACTUAL_PATCH_SHA" >&2
  echo "expected=$EXPECTED_PATCH_SHA" >&2
  exit 1
}

git apply --check "$PATCH"
git apply "$PATCH"
git diff --check

echo "Gate C C2 scorecard-adapter patch applied."
echo "Run validate-gate-c-c2-scorecard.sh before committing."
