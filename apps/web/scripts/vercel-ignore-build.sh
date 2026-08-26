#!/bin/sh
set -u

# Vercel treats exit 0 as "skip" and exit 1 as "build".
if [ "${VERCEL_GIT_COMMIT_REF:-}" = "integration/gate-c-final" ]; then
  exit 1
fi

previous="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^1}"
if ! git cat-file -e "$previous^{commit}" 2>/dev/null; then
  exit 1
fi

if git diff --quiet "$previous" HEAD -- . ../../packages ../../package.json ../../pnpm-lock.yaml ../../turbo.json; then
  exit 0
fi

exit 1
