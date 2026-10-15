#!/usr/bin/env bash
# Fresh-clone boot check: start the real built API process with ONLY the values in .env
# (a copy of .env.example), wait for readiness, hit a public route, stop it, and fail on a
# crash or any fatal/error-level log line.
#
# Every key defined in .env is removed from the inherited environment before launch, so a CI
# job-level env (e.g. APP_ENV=test, LOG_LEVEL=silent) cannot mask a broken template. Node's
# --env-file then supplies the values, exactly as a developer's .env would.
#
# Local-only escape hatch: BOOT_CHECK_DATABASE_URL points the process at a throwaway database
# instead of the template's DATABASE_URL. CI leaves it unset (the service container matches).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BOOT_CHECK_ENV_FILE:-$ROOT/.env}"
READY_TIMEOUT_SECONDS="${BOOT_CHECK_READY_TIMEOUT_SECONDS:-60}"
LOG_FILE="$(mktemp -t matchday-boot-api.XXXXXX)"
WEB_LOG_FILE="$(mktemp -t matchday-boot-web.XXXXXX)"
CHECK_WEB="${BOOT_CHECK_WEB:-1}"
web_pid=""

[ -f "$ENV_FILE" ] || { echo "::error::$ENV_FILE not found (cp .env.example .env first)"; exit 1; }
[ -f "$ROOT/apps/api/dist/main.js" ] || { echo "::error::apps/api/dist/main.js missing (run pnpm build)"; exit 1; }

unset_args=()
while IFS= read -r key; do unset_args+=("-u" "$key"); done < <(
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | cut -d= -f1 | sort -u
)
extra_env=()
if [ -n "${BOOT_CHECK_DATABASE_URL:-}" ]; then
  extra_env+=("DATABASE_URL=$BOOT_CHECK_DATABASE_URL")
  echo "Override: DATABASE_URL -> BOOT_CHECK_DATABASE_URL (local throwaway database)"
fi

api_host="$(grep -E '^API_HOST=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
api_port="$(grep -E '^API_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
base="http://${api_host:-127.0.0.1}:${api_port:-4000}"

cd "$ROOT"
env "${unset_args[@]}" ${extra_env[@]+"${extra_env[@]}"} node --env-file="$ENV_FILE" apps/api/dist/main.js >"$LOG_FILE" 2>&1 &
pid=$!

status=0
cleanup() {
  if [ -n "$web_pid" ] && kill -0 "$web_pid" 2>/dev/null; then
    kill -TERM "$web_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$web_pid" 2>/dev/null || true
  fi
  if [ "$CHECK_WEB" = "1" ] && [ -s "$WEB_LOG_FILE" ]; then
    echo "----- web log ($WEB_LOG_FILE) -----"
    cat "$WEB_LOG_FILE"
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  echo "----- API log ($LOG_FILE) -----"
  cat "$LOG_FILE"
  echo "-------------------------------"
  rm -f "$LOG_FILE" "$LOG_FILE.body" "$WEB_LOG_FILE"
}
trap cleanup EXIT

fail() { echo "::error::$1"; status=1; exit 1; }

deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
ready=""
while [ "$SECONDS" -lt "$deadline" ]; do
  kill -0 "$pid" 2>/dev/null || fail "API process exited before becoming ready"
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/health/ready" || true)"
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || fail "GET $base/health/ready did not return 200 within ${READY_TIMEOUT_SECONDS}s"
echo "GET /health/ready -> 200 after $((SECONDS - (deadline - READY_TIMEOUT_SECONDS)))s"

check() {
  local origin="$1" path="$2" code
  code="$(curl -s -o "$LOG_FILE.body" -w '%{http_code}' "$origin$path" || true)"
  echo "GET $origin$path -> $code ($(head -c 200 "$LOG_FILE.body" 2>/dev/null | tr -d '\n'))"
  [ "$code" = "200" ] || fail "GET $origin$path returned $code, expected 200"
}
check "$base" /health/live
check "$base" /api/v1/public/competitions

# Web: `next start` on the prebuilt app (apps/web/.next from `pnpm build`), same .env-only rules,
# rendering / server-side against the API started above.
if [ "$CHECK_WEB" = "1" ]; then
  [ -f "$ROOT/apps/web/.next/BUILD_ID" ] || fail "apps/web/.next missing (run pnpm build)"
  web_origin="http://127.0.0.1:3000"
  (cd "$ROOT/apps/web" && exec env "${unset_args[@]}" ${extra_env[@]+"${extra_env[@]}"} \
    node --env-file="$ENV_FILE" node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000) >"$WEB_LOG_FILE" 2>&1 &
  web_pid=$!
  web_deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$web_origin/" || true)" = "200" ]; do
    kill -0 "$web_pid" 2>/dev/null || fail "web process exited before serving /"
    [ "$SECONDS" -lt "$web_deadline" ] || fail "GET $web_origin/ did not return 200 within ${READY_TIMEOUT_SECONDS}s"
    sleep 1
  done
  check "$web_origin" /
  kill -TERM "$web_pid"
  wait "$web_pid" || true
  web_pid=""
  if grep -E 'Unhandled|uncaughtException|FATAL|\[Error' "$WEB_LOG_FILE" >/dev/null; then
    fail "web logged an error during the boot check"
  fi
fi

kill -0 "$pid" 2>/dev/null || fail "API process died during route checks"
kill -TERM "$pid"
exit_code=0
wait "$pid" || exit_code=$?
# 143 = terminated by our SIGTERM without a custom handler; 0 = graceful shutdown handler.
if [ "$exit_code" -ne 0 ] && [ "$exit_code" -ne 143 ]; then fail "API exited with code $exit_code on SIGTERM"; fi

# pino: 50 = error, 60 = fatal. Plain-text crash markers cover non-JSON output.
if grep -E '"level":(50|60)|Unhandled|uncaughtException|FATAL' "$LOG_FILE" >/dev/null; then
  fail "API logged an error/fatal line during the boot check"
fi
rm -f "$LOG_FILE.body"
echo "Fresh boot check passed (API exit code $exit_code; web checked: $CHECK_WEB; started from .env only)."
exit "$status"
