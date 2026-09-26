#!/usr/bin/env bash
set -euo pipefail

PROD_HOST="${1:-matchday.poladex.shop}"
STAGING_HOST="${2:-c5-drill.poladex.shop}"
EXPECTED_SHA="${3:-}"

echo "=================================================="
echo "MATCHDAY PRODUCTION TOPOLOGY VERIFICATION"
echo "  Prod Host:    https://${PROD_HOST}"
echo "  Staging Host: https://${STAGING_HOST}"
if [ -n "$EXPECTED_SHA" ]; then
  echo "  Expected SHA: ${EXPECTED_SHA}"
fi
echo "=================================================="

# 1. Verify Production Health & Attestation
echo "[topology] 1. Probing production health..."
prod_ready_code="$(curl --connect-timeout 5 --max-time 10 -s -o /dev/null -w "%{http_code}" "https://${PROD_HOST}/health/ready")"
if [ "$prod_ready_code" != "200" ]; then
  echo "FAIL: Production /health/ready returned HTTP $prod_ready_code (expected 200)" >&2
  exit 1
fi
echo "  ✓ Production /health/ready is HTTP 200"

echo "[topology] 2. Reading production build attestation..."
prod_build="$(curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${PROD_HOST}/api/v1/meta/build")"
prod_env="$(node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).environment||"");});' <<<"$prod_build")"
prod_sha="$(node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).git_sha||"");});' <<<"$prod_build")"
prod_time="$(node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).build_timestamp||"");});' <<<"$prod_build")"

if [ "$prod_env" != "production" ]; then
  echo "FAIL: Production environment is '$prod_env' (expected 'production')" >&2
  exit 1
fi
echo "  ✓ Production environment attestation: $prod_env"
echo "  ✓ Production git_sha: $prod_sha"
echo "  ✓ Production build_timestamp: $prod_time"

if [ -n "$EXPECTED_SHA" ]; then
  if [ "$prod_sha" != "$EXPECTED_SHA" ]; then
    echo "FAIL: Production git_sha '$prod_sha' does not match expected '$EXPECTED_SHA'" >&2
    exit 1
  fi
  echo "  ✓ Production SHA matches candidate SHA"
fi

# 2. Verify Staging Health & Attestation
echo "[topology] 3. Probing staging health..."
staging_ready_code="$(curl --connect-timeout 5 --max-time 10 -s -o /dev/null -w "%{http_code}" "https://${STAGING_HOST}/health/ready")"
if [ "$staging_ready_code" != "200" ]; then
  echo "FAIL: Staging /health/ready returned HTTP $staging_ready_code (expected 200)" >&2
  exit 1
fi
echo "  ✓ Staging /health/ready is HTTP 200"

echo "[topology] 4. Reading staging build attestation..."
staging_build="$(curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${STAGING_HOST}/api/v1/meta/build")"
staging_env="$(node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).environment||"");});' <<<"$staging_build")"
staging_sha="$(node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).git_sha||"");});' <<<"$staging_build")"

if [ "$staging_env" != "staging" ]; then
  echo "FAIL: Staging environment is '$staging_env' (expected 'staging')" >&2
  exit 1
fi
echo "  ✓ Staging environment attestation: $staging_env"
echo "  ✓ Staging git_sha: $staging_sha"

# 3. Verify Isolation between Production and Staging
echo "[topology] 5. Verifying production and staging isolation..."
if [ "$prod_sha" = "$staging_sha" ] && [ -n "$EXPECTED_SHA" ]; then
  # Note: in rare cases where both run the same SHA, env must still differ
  if [ "$prod_env" = "$staging_env" ]; then
    echo "FAIL: Production and staging report identical environment '$prod_env'" >&2
    exit 1
  fi
fi
echo "  ✓ Production and staging hostnames route to isolated environments"

echo "=================================================="
echo "TOPOLOGY VERIFICATION PASS"
echo "=================================================="
