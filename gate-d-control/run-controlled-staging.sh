#!/usr/bin/env bash
set -euo pipefail

# Gate D controlled-staging orchestrator.
#
# This file intentionally lives on the evidence branch, not the frozen candidate.
# It checks out the exact candidate into a detached temporary worktree and executes
# the candidate's own seeder/load/validator scripts. Generated receipts are copied
# back to the evidence branch working tree only after strict validation passes.

DEFAULT_CANDIDATE_SHA="06f1acd6a90775f92d5b5c260c5545fc81c2470d"
HOSTED_CI_RUN_ID="33653457048"

CANDIDATE_SHA="${CANDIDATE_SHA:-$DEFAULT_CANDIDATE_SHA}"
TARGET_URL="${TARGET_URL:-}"
DATABASE_URL="${DATABASE_URL:-}"
REDIS_URL="${REDIS_URL:-}"

fail() {
  echo "Gate D staging runner: $*" >&2
  exit 1
}

[[ "$CANDIDATE_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || fail "CANDIDATE_SHA must be an exact 40-character SHA"
[[ -n "$TARGET_URL" ]] || fail "TARGET_URL is required"
[[ -n "$DATABASE_URL" ]] || fail "DATABASE_URL is required"
[[ -n "$REDIS_URL" ]] || fail "REDIS_URL is required"

node - "$TARGET_URL" <<'NODE'
const value = process.argv[2];
const url = new URL(value);
if (url.protocol !== "https:") throw new Error("TARGET_URL must be HTTPS for controlled Gate D staging");
if (url.username || url.password || url.search || url.hash) {
  throw new Error("TARGET_URL must not contain credentials, query, or fragment");
}
NODE

CONTROL_ROOT="$(git rev-parse --show-toplevel)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/matchday-gate-d-controlled-XXXXXX")"
WORKTREE="$TMP_ROOT/candidate"
SEED_LOG="$TMP_ROOT/seed.log"
SCORING_SECRET_FILE=""
SCORING_SECRET_DIR=""

cleanup() {
  set +e
  if [[ -n "$SCORING_SECRET_FILE" ]]; then rm -f -- "$SCORING_SECRET_FILE"; fi
  if [[ -n "$SCORING_SECRET_DIR" ]]; then rmdir -- "$SCORING_SECRET_DIR" 2>/dev/null || true; fi
  git -C "$CONTROL_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

git -C "$CONTROL_ROOT" cat-file -e "${CANDIDATE_SHA}^{commit}" 2>/dev/null || fail "candidate commit is unavailable locally"
git -C "$CONTROL_ROOT" worktree add --detach "$WORKTREE" "$CANDIDATE_SHA" >/dev/null

cd "$WORKTREE"
corepack enable
pnpm install --frozen-lockfile

export CANDIDATE_SHA TARGET_URL DATABASE_URL REDIS_URL

DEPLOYED_SHA="$(node - "$TARGET_URL" <<'NODE'
const base = process.argv[2].replace(/\/$/, "");
const response = await fetch(`${base}/api/v1/meta/build`, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`build metadata returned HTTP ${response.status}`);
const body = await response.json();
if (typeof body.git_sha !== "string") throw new Error("build metadata did not include git_sha");
process.stdout.write(body.git_sha);
NODE
)"
[[ "${DEPLOYED_SHA,,}" == "${CANDIDATE_SHA,,}" ]] || fail "deployed SHA $DEPLOYED_SHA does not match candidate $CANDIDATE_SHA"

echo "Gate D staging runner"
echo "  Candidate: $CANDIDATE_SHA"
echo "  Hosted CI: $HOSTED_CI_RUN_ID"
echo "  Target:    $TARGET_URL"
echo "  Deployed:  $DEPLOYED_SHA"

echo "Running canonical staging seed..."
pnpm seed:staging:pilot 2>&1 | tee "$SEED_LOG"

HANDOFF_JSON="$(sed -n 's/^✓ Single-use scoring handoff:  export GATE_D_SCORING_SECRET_FILE=//p' "$SEED_LOG" | tail -n 1)"
[[ -n "$HANDOFF_JSON" ]] || fail "staging seeder did not emit the single-use QA-011 scoring handoff"
SCORING_SECRET_FILE="$(node - "$HANDOFF_JSON" <<'NODE'
const raw = process.argv[2];
const parsed = JSON.parse(raw);
if (typeof parsed !== "string" || parsed.length === 0) throw new Error("invalid scoring handoff path");
process.stdout.write(parsed);
NODE
)"
SCORING_SECRET_DIR="$(dirname "$SCORING_SECRET_FILE")"
[[ -f "$SCORING_SECRET_FILE" ]] || fail "single-use scoring handoff file does not exist"
export GATE_D_SCORING_SECRET_FILE="$SCORING_SECRET_FILE"

echo "Running QA-010 + QA-011 controlled staging workloads..."
pnpm test:load:staging

[[ ! -e "$SCORING_SECRET_FILE" ]] || fail "QA-011 did not delete the single-use scoring secret file"
[[ ! -d "$SCORING_SECRET_DIR" ]] || fail "QA-011 did not delete the single-use scoring secret directory"
SCORING_SECRET_FILE=""
SCORING_SECRET_DIR=""

echo "Validating controlled-staging receipts..."
pnpm evidence:gate-d:verify

mkdir -p "$CONTROL_ROOT/artifacts"
for file in \
  staging-pilot-seed.json \
  qa-010-load-public-summary.json \
  qa-011-load-scoring-summary.json \
  qa-011-result-propagation-summary.json; do
  [[ -f "$WORKTREE/artifacts/$file" ]] || fail "validated run is missing artifact $file"
  cp "$WORKTREE/artifacts/$file" "$CONTROL_ROOT/artifacts/$file"
done

node - "$CONTROL_ROOT/artifacts/gate-d-staging-run.json" "$CANDIDATE_SHA" "$DEPLOYED_SHA" "$TARGET_URL" "$HOSTED_CI_RUN_ID" <<'NODE'
import { writeFileSync } from "node:fs";
const [output, candidateSha, deployedSha, targetUrl, hostedCiRunId] = process.argv.slice(2);
writeFileSync(
  output,
  `${JSON.stringify(
    {
      schema_version: "2026.09.gate-d-staging-run",
      candidate_sha: candidateSha,
      deployed_sha: deployedSha,
      target_url: targetUrl.replace(/\/$/, ""),
      hosted_ci_run_id: Number(hostedCiRunId),
      validated_at_utc: new Date().toISOString(),
      scoring_secret_handoff_deleted: true,
      receipts: [
        "artifacts/qa-010-load-public-summary.json",
        "artifacts/qa-011-load-scoring-summary.json",
        "artifacts/qa-011-result-propagation-summary.json",
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);
NODE

echo
echo "✓ Gate D controlled staging evidence is valid for $CANDIDATE_SHA"
echo "✓ Sanitized receipts copied to $CONTROL_ROOT/artifacts"
echo "✓ Single-use QA-011 scoring handoff was deleted"
echo "Next: commit only sanitized evidence on gate-d/evidence-06f1acd6, then complete human evidence and run validate-gate-d-freeze.mjs."
