#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-}"
if [[ -z "$ROOT" ]]; then
  echo "usage: $0 /path/to/Sports\ Website" >&2
  exit 2
fi
if [[ -z "${C1_FOLLOWUP_EVIDENCE_SHA:-}" ]]; then
  echo "C1_FOLLOWUP_EVIDENCE_SHA is required" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$SCRIPT_DIR/gate-c-c2-domain.patch"
EXPECTED_PATCH_SHA="66faddd6687ec4ded90305cf912dfc1b945a6fba008c6ced27bda7e635cbd197"
ORIGINAL_C1_EVIDENCE="c0aa517e6a34221f480d6b1075010233133a99a5"

cd "$ROOT"

[[ "$(git status --short)" == "" ]] || {
  echo "working tree must be clean before applying C2" >&2
  git status --short >&2
  exit 1
}

HEAD_SHA="$(git rev-parse HEAD)"
[[ "$HEAD_SHA" == "$C1_FOLLOWUP_EVIDENCE_SHA" ]] || {
  echo "HEAD must equal C1_FOLLOWUP_EVIDENCE_SHA" >&2
  echo "HEAD=$HEAD_SHA" >&2
  echo "EXPECTED=$C1_FOLLOWUP_EVIDENCE_SHA" >&2
  exit 1
}

git merge-base --is-ancestor "$ORIGINAL_C1_EVIDENCE" HEAD || {
  echo "C2 base does not descend from the certified C1 evidence history" >&2
  exit 1
}

for path in \
  packages/domain/src/five-sport-scoring.ts \
  packages/domain/tests/gate-c-five-sport-scoring.test.ts; do
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

echo "Gate C C2 domain patch applied."
echo "Run validate-gate-c-c2-domain.sh before committing."
