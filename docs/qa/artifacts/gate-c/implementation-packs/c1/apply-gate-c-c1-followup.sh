#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/Documents/Sports Website}"
PATCH="${2:-$(cd "$(dirname "$0")" && pwd)/gate-c-c1-followup.patch}"
EXPECTED_HEAD="c0aa517e6a34221f480d6b1075010233133a99a5"
CERTIFIED_GATE_B="d432cb4f7c8b8c419acb1c8f556ed02dcd48b834"
CERTIFIED_C1_SOURCE="a896e4f48e005ad16c0360f6f41495d19282f12b"
EXPECTED_PATCH_SHA="9e2cd98e096082f84212030cde91d398f48cb7acbad29b3779c502b65b818798"

cd "$REPO"

actual_patch_sha="$(shasum -a 256 "$PATCH" | awk '{print $1}')"
if [[ "$actual_patch_sha" != "$EXPECTED_PATCH_SHA" ]]; then
  echo "STOP: patch checksum mismatch: $actual_patch_sha"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "STOP: working tree is not clean"
  git status --short
  exit 1
fi

if [[ "$(git rev-parse HEAD)" != "$EXPECTED_HEAD" ]]; then
  echo "STOP: expected C1 evidence commit $EXPECTED_HEAD"
  echo "Actual HEAD: $(git rev-parse HEAD)"
  exit 1
fi

git merge-base --is-ancestor "$CERTIFIED_GATE_B" "$CERTIFIED_C1_SOURCE"
git merge-base --is-ancestor "$CERTIFIED_C1_SOURCE" "$EXPECTED_HEAD"

git diff --quiet "$CERTIFIED_C1_SOURCE" "$EXPECTED_HEAD" -- \
  ':(exclude)docs/qa/**' \
  ':(exclude)artifacts/qa/**'

branch="fix/gate-c-c1-follow-up"
if git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "STOP: branch $branch already exists"
  exit 1
fi

git switch -c "$branch"
git apply --index "$PATCH"
git diff --cached --check

echo
printf 'Patch staged on %s\n' "$branch"
git diff --cached --stat
printf '\nDo not commit until the affected checks and complete C1 recertification ledger pass.\n'
