#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/Documents/Sports Website}"
EXPECTED_HEAD="c0aa517e6a34221f480d6b1075010233133a99a5"
PATCH_SHA="9e2cd98e096082f84212030cde91d398f48cb7acbad29b3779c502b65b818798"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$SCRIPT_DIR/gate-c-c1-followup.patch"

cd "$REPO"

[[ "$(git rev-parse HEAD)" == "$EXPECTED_HEAD" ]] || {
  echo "Expected HEAD $EXPECTED_HEAD" >&2
  exit 1
}

[[ -z "$(git status --porcelain)" ]] || {
  echo "Working tree must be clean before applying the C1 follow-up." >&2
  exit 1
}

printf '%s  %s\n' "$PATCH_SHA" "$PATCH" | shasum -a 256 -c -

git merge-base --is-ancestor \
  d432cb4f7c8b8c419acb1c8f556ed02dcd48b834 \
  "$EXPECTED_HEAD"

git apply --check "$PATCH"
git apply "$PATCH"
git diff --check

echo "C1 follow-up patch applied. Review the diff before validation or commit."
