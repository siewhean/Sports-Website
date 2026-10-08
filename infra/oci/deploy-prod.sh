#!/usr/bin/env bash
set -euo pipefail

: "${CANDIDATE_SHA:?Set CANDIDATE_SHA to the full 40-character Git SHA}"
: "${OCI_PUBLIC_HOSTNAME:?Set OCI_PUBLIC_HOSTNAME to the DNS name serving this production stack}"

if [[ ! "$CANDIDATE_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "CANDIDATE_SHA must be a full 40-character SHA" >&2
  exit 1
fi
CANDIDATE_SHA="$(printf '%s' "$CANDIDATE_SHA" | tr '[:upper:]' '[:lower:]')"

dns_hostname_pattern='^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
if [[ ${#OCI_PUBLIC_HOSTNAME} -gt 253 || ! "$OCI_PUBLIC_HOSTNAME" =~ $dns_hostname_pattern ]]; then
  echo "OCI_PUBLIC_HOSTNAME must be a DNS hostname without credentials, path, query, or fragment" >&2
  exit 1
fi
OCI_PUBLIC_HOSTNAME="$(printf '%s' "$OCI_PUBLIC_HOSTNAME" | tr '[:upper:]' '[:lower:]')"

test -f infra/oci/.env.prod
env_mode="$(stat -c '%a' infra/oci/.env.prod 2>/dev/null || stat -f '%Lp' infra/oci/.env.prod)"
if [ "$env_mode" != "600" ]; then
  echo "infra/oci/.env.prod must have 600 permissions (got $env_mode)" >&2
  exit 1
fi

test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
test "$(git status --porcelain=v1 --untracked-files=all)" = ""

export CANDIDATE_SHA OCI_PUBLIC_HOSTNAME
export OCI_PROD_ENV_FILE=.env.prod
export BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
BUILD_TIMESTAMP_SANITIZED="$(printf '%s' "$BUILD_TIMESTAMP" | tr -c 'A-Za-z0-9_' '_')"
export DEPLOY_PID=$$

# Timeout classes (seconds, configurable via environment for deterministic test execution)
DOCKER_INSPECT_TIMEOUT="${MATCHDAY_INSPECT_TIMEOUT:-10}"
CADDY_RELOAD_TIMEOUT="${MATCHDAY_CADDY_RELOAD_TIMEOUT:-15}"
CADDY_VALIDATION_TIMEOUT="${MATCHDAY_CADDY_VALIDATION_TIMEOUT:-30}"
SERVICE_CONTROL_TIMEOUT="${MATCHDAY_SERVICE_CONTROL_TIMEOUT:-30}"
MIGRATION_TIMEOUT="${MATCHDAY_MIGRATION_TIMEOUT:-180}"
BUILD_TIMEOUT="${MATCHDAY_BUILD_TIMEOUT:-600}"

# Pinned Caddy container image contract
CADDY_IMAGE="caddy:2.10-alpine"
CADDY_IMAGE_DIGEST="sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
PINNED_CADDY_IMAGE="${CADDY_IMAGE}@${CADDY_IMAGE_DIGEST}"
CADDY_CONTAINER_TARGET="/etc/caddy/Caddyfile"

# Bounded external command execution runner
run_bounded() {
  local timeout_sec="$1"
  shift
  python3 -c '
import sys, subprocess, os, signal
timeout_sec = float(sys.argv[1])
cmd = sys.argv[2:]
try:
    p = subprocess.Popen(cmd, start_new_session=True)
    try:
        ret = p.wait(timeout=timeout_sec)
        sys.exit(ret)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            pass
        cmd_full = " ".join(cmd) if cmd else "command"
        sys.stderr.write(f"[deploy-prod] ERROR: Command timed out after {timeout_sec}s: {cmd_full}\n")
        sys.exit(124)
    except KeyboardInterrupt:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            pass
        sys.exit(130)
except Exception as e:
    cmd_name = os.path.basename(cmd[0]) if cmd else "command"
    sys.stderr.write(f"[deploy-prod] ERROR: Failed to execute {cmd_name}: {e}\n")
    sys.exit(1)
' "$timeout_sec" "$@"
}

# Deployment lock file
DEPLOY_LOCK_FILE="${MATCHDAY_DEPLOY_LOCK_FILE:-/tmp/matchday-deploy.lock}"
mkdir -p "$(dirname "$DEPLOY_LOCK_FILE")"
exec 9>"$DEPLOY_LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    echo "Another deployment is already in progress (lock held on $DEPLOY_LOCK_FILE)" >&2
    exit 1
  fi
else
  if ! python3 -c 'import fcntl, sys; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null; then
    echo "Another deployment is already in progress (lock held on $DEPLOY_LOCK_FILE)" >&2
    exit 1
  fi
fi

STATE_FILE="${MATCHDAY_ACTIVE_SLOT_FILE:-/var/lib/matchday/deploy/active-slot.env}"
SOURCE_CADDY_TEMPLATE="infra/oci/Caddyfile"
RUNTIME_CADDYFILE_PATH="${MATCHDAY_RUNTIME_CADDYFILE_PATH:-/etc/matchday/caddy/Caddyfile}"
RUNTIME_CADDY_DIR="${MATCHDAY_RUNTIME_CADDY_DIR:-$(dirname "$RUNTIME_CADDYFILE_PATH")}"

# Export runtime Caddyfile path and directory to ensure Compose propagates them
export MATCHDAY_RUNTIME_CADDYFILE_PATH="$RUNTIME_CADDYFILE_PATH"
export MATCHDAY_RUNTIME_CADDY_DIR="$RUNTIME_CADDY_DIR"

if [ -n "${MATCHDAY_RUNTIME_CADDY_DIR:-}" ]; then
  caddy_dir_canonical="$(python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$RUNTIME_CADDY_DIR" 2>/dev/null || echo "$RUNTIME_CADDY_DIR")"
  caddy_file_dir_canonical="$(python3 -c "import os, sys; print(os.path.realpath(os.path.dirname(sys.argv[1])))" "$RUNTIME_CADDYFILE_PATH" 2>/dev/null || echo "$(dirname "$RUNTIME_CADDYFILE_PATH")")"
  if [ "$caddy_dir_canonical" != "$caddy_file_dir_canonical" ]; then
    echo "[deploy-prod] FATAL: Runtime Caddyfile ($RUNTIME_CADDYFILE_PATH) must reside inside MATCHDAY_RUNTIME_CADDY_DIR ($RUNTIME_CADDY_DIR)" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
mkdir -p "$RUNTIME_CADDY_DIR" 2>/dev/null || true

# If runtime Caddyfile does not exist, initialize from immutable template
if [ ! -f "$RUNTIME_CADDYFILE_PATH" ]; then
  if [ -f "$SOURCE_CADDY_TEMPLATE" ]; then
    cp "$SOURCE_CADDY_TEMPLATE" "$RUNTIME_CADDYFILE_PATH"
    chmod 600 "$RUNTIME_CADDYFILE_PATH" 2>/dev/null || true
  fi
fi

# Function to derive active routing from runtime Caddyfile
derive_caddy_routing() {
  local target_file="$1"
  if [ ! -f "$target_file" ]; then
    echo "missing"
    return
  fi
  python3 -c "
import sys
try:
    with open('$target_file', 'r') as f:
        content = f.read()
    has_blue = ('172.31.0.11:4000' in content) or ('172.31.0.12:3000' in content)
    has_green = ('172.31.0.21:4000' in content) or ('172.31.0.22:3000' in content)
    if has_blue and not has_green:
        print('blue')
    elif has_green and not has_blue:
        print('green')
    else:
        print('ambiguous')
except Exception:
    print('ambiguous')
"
}

caddy_routing="$(derive_caddy_routing "$RUNTIME_CADDYFILE_PATH")"

ACTIVE_SLOT=""
ACTIVE_SHA=""

if [ -f "$STATE_FILE" ]; then
  parsed_slot="$(awk -F= '$1 == "ACTIVE_SLOT" { print $2 }' "$STATE_FILE" | tr -d ' \r\n"'\''')"
  if [ "$parsed_slot" != "blue" ] && [ "$parsed_slot" != "green" ]; then
    echo "ERROR: Invalid ACTIVE_SLOT in $STATE_FILE ('$parsed_slot'). Must be 'blue' or 'green'." >&2
    exit 1
  fi
  parsed_sha="$(awk -F= '$1 == "ACTIVE_SHA" { print $2 }' "$STATE_FILE" | tr -d ' \r\n"'\''')"
  if [ -n "$parsed_sha" ] && [[ ! "$parsed_sha" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: Invalid ACTIVE_SHA in $STATE_FILE ('$parsed_sha'). Must be 40-character hex SHA." >&2
    exit 1
  fi
  ACTIVE_SLOT="$parsed_slot"
  ACTIVE_SHA="$parsed_sha"

  # Reconcile with Caddy routing: must agree
  if [ "$caddy_routing" != "missing" ] && [ "$caddy_routing" != "$ACTIVE_SLOT" ]; then
    echo "AMBIGUOUS_ACTIVE_SLOT: Persistent state records '$ACTIVE_SLOT' but runtime Caddy routes to '$caddy_routing'." >&2
    exit 1
  fi
else
  # State file is missing: reconcile from unambiguous Caddy routing or fail closed
  if [ "$caddy_routing" = "blue" ] || [ "$caddy_routing" = "green" ]; then
    echo "[deploy-prod] State file missing; reconciling active slot from unambiguous Caddy routing: $caddy_routing"
    ACTIVE_SLOT="$caddy_routing"
    # Persist reconciled state
    tmp_state="${STATE_FILE}.tmp.$$"
    printf 'ACTIVE_SLOT=%s\nACTIVE_SHA=\nUPDATED_AT=%s\nRECONCILED=true\n' "$ACTIVE_SLOT" "$BUILD_TIMESTAMP" > "$tmp_state"
    chmod 600 "$tmp_state" 2>/dev/null || true
    mv -f "$tmp_state" "$STATE_FILE"
  else
    echo "AMBIGUOUS_ACTIVE_SLOT: State file is missing and runtime Caddy routing is ambiguous ($caddy_routing)." >&2
    exit 1
  fi
fi

if [ "$ACTIVE_SLOT" = "blue" ]; then
  CANDIDATE_SLOT="green"
  CANDIDATE_API_SERVICE="api-green"
  CANDIDATE_WEB_SERVICE="web-green"
  CANDIDATE_WORKER_SERVICE="worker-green"
  CANDIDATE_API_IP="172.31.0.21"
  CANDIDATE_WEB_IP="172.31.0.22"
  ACTIVE_API_SERVICE="api"
  ACTIVE_WEB_SERVICE="web"
  ACTIVE_WORKER_SERVICE="worker"
  ACTIVE_API_IP="172.31.0.11"
  ACTIVE_WEB_IP="172.31.0.12"
else
  CANDIDATE_SLOT="blue"
  CANDIDATE_API_SERVICE="api"
  CANDIDATE_WEB_SERVICE="web"
  CANDIDATE_WORKER_SERVICE="worker"
  CANDIDATE_API_IP="172.31.0.11"
  CANDIDATE_WEB_IP="172.31.0.12"
  ACTIVE_API_SERVICE="api-green"
  ACTIVE_WEB_SERVICE="web-green"
  ACTIVE_WORKER_SERVICE="worker-green"
  ACTIVE_API_IP="172.31.0.21"
  ACTIVE_WEB_IP="172.31.0.22"
fi

echo "[deploy-prod] Deployment starting: Active Slot=$ACTIVE_SLOT, Candidate Slot=$CANDIDATE_SLOT, Candidate SHA=$CANDIDATE_SHA"

# Phase and State tracking
export MATCHDAY_DEPLOY_PHASE="PREFLIGHT"
export PHASE="PREFLIGHT"
PROMOTED=0
ACTIVE_WORKER_STOPPED=0
WORKER_HANDOVER_STARTED=0
ROLLBACK_IN_PROGRESS=0
DEPLOYMENT_COMMITTED=0

TARGET_CADDY_DIR="$(dirname "$RUNTIME_CADDYFILE_PATH")"
PREVIOUS_RUNTIME_CADDYFILE="${TARGET_CADDY_DIR}/.Caddyfile.previous.${BUILD_TIMESTAMP_SANITIZED}_$$"
CANDIDATE_RUNTIME_CADDYFILE="${TARGET_CADDY_DIR}/.Caddyfile.candidate.${BUILD_TIMESTAMP_SANITIZED}_$$"

caddy_env_file="infra/oci/.env.oci"
if [ ! -f "$caddy_env_file" ] && [ -f "infra/oci/.env.prod" ]; then
  caddy_env_file="infra/oci/.env.prod"
fi

emit_receipt() {
  local outcome="$1"
  local active_slot_after="$2"
  local failure_reason="${3:-}"
  local rollback_result="${4:-}"
  local rollback_failures_str="${5:-}"
  local receipt_dir="artifacts"
  mkdir -p "$receipt_dir"
  local receipt_file="$receipt_dir/deploy-receipt.json"

  if [ "${MOCK_RECEIPT_FAILURE:-0}" = "1" ]; then
    return 1
  fi

  node -e '
    const fs = require("fs");
    const [
      timestamp,
      candidateSha,
      activeSlotBefore,
      candidateSlot,
      activeSlotAfter,
      outcome,
      failureReason,
      hostname,
      activeShaBefore,
      promoted,
      workerHandoverStarted,
      rollbackResult,
      receiptPath,
      rollbackFailuresStr
    ] = process.argv.slice(1);

    if (!["blue", "green"].includes(activeSlotAfter)) {
      console.error(`Invalid activeSlotAfter in receipt: "${activeSlotAfter}"`);
      process.exit(1);
    }
    if (!["SUCCESS", "ROLLBACK"].includes(outcome)) {
      console.error(`Invalid outcome in receipt: "${outcome}"`);
      process.exit(1);
    }

    const rollbackFailures = (rollbackFailuresStr || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const receipt = {
      timestamp,
      candidate_sha: candidateSha,
      active_sha_before: activeShaBefore || null,
      active_slot_before: activeSlotBefore,
      candidate_slot: candidateSlot,
      active_slot_after: activeSlotAfter,
      promoted: promoted === "1",
      worker_handover_started: workerHandoverStarted === "1",
      rollback_result: rollbackResult || null,
      rollback_failures: rollbackFailures,
      outcome,
      failure_reason: failureReason || null,
      hostname
    };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  ' "$BUILD_TIMESTAMP" \
    "$CANDIDATE_SHA" \
    "$ACTIVE_SLOT" \
    "$CANDIDATE_SLOT" \
    "$active_slot_after" \
    "$outcome" \
    "$failure_reason" \
    "https://${OCI_PUBLIC_HOSTNAME}" \
    "${ACTIVE_SHA:-}" \
    "$PROMOTED" \
    "$WORKER_HANDOVER_STARTED" \
    "$rollback_result" \
    "$receipt_file" \
    "$rollback_failures_str"
}

cleanup_and_rollback() {
  local reason="$1"
  if [ "$ROLLBACK_IN_PROGRESS" -eq 1 ]; then
    return
  fi
  ROLLBACK_IN_PROGRESS=1
  export ROLLBACK_IN_PROGRESS=1
  echo "[deploy-prod] Automatic rollback initiated. Reason: $reason" >&2

  local rollback_failures=()
  record_rollback_failure() {
    local rf="$1"
    rollback_failures+=("$rf")
  }

  if [ "$PROMOTED" -eq 1 ]; then
    echo "[deploy-prod] Reverting Caddy routing to active slot $ACTIVE_SLOT ($ACTIVE_API_IP / $ACTIVE_WEB_IP)..." >&2

    local caddy_restored=0
    if [ ! -f "$PREVIOUS_RUNTIME_CADDYFILE" ]; then
      echo "[deploy-prod] FATAL: Previous runtime Caddyfile ($PREVIOUS_RUNTIME_CADDYFILE) is missing! Cannot restore active routing." >&2
      record_rollback_failure "FAILED_CADDY_PREVIOUS_CONFIG_MISSING"
    else
      if ! mv -f "$PREVIOUS_RUNTIME_CADDYFILE" "$RUNTIME_CADDYFILE_PATH"; then
        echo "[deploy-prod] FATAL: Failed to restore previous runtime Caddyfile ($PREVIOUS_RUNTIME_CADDYFILE -> $RUNTIME_CADDYFILE_PATH)!" >&2
        record_rollback_failure "FAILED_CADDY_RESTORE"
      else
        echo "[deploy-prod] Previous runtime Caddyfile restored successfully." >&2
        caddy_restored=1
      fi
    fi

    local caddy_discovery_status="CADDY_DISCOVERY_SUCCESS"
    local caddy_container=""
    local discovery_output=""
    local disc_code=0
    discovery_output="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker compose --env-file "$caddy_env_file" -f infra/oci/compose.yaml ps -q caddy)" || disc_code=$?
    if [ "$disc_code" -ne 0 ]; then
      if [ "$disc_code" -eq 124 ]; then
        caddy_discovery_status="CADDY_DISCOVERY_TIMEOUT"
        echo "[deploy-prod] FATAL: Caddy container discovery timed out during rollback!" >&2
      else
        caddy_discovery_status="CADDY_DISCOVERY_COMMAND_FAILURE"
        echo "[deploy-prod] FATAL: Caddy container discovery command failed during rollback (exit code $disc_code)!" >&2
      fi
      record_rollback_failure "FAILED_CADDY_DISCOVERY"
    else
      caddy_container="$(echo "$discovery_output" | tr -d '[:space:]')"
      if [ -z "$caddy_container" ]; then
        caddy_discovery_status="CADDY_CONTAINER_MISSING"
        echo "[deploy-prod] FATAL: Caddy container is missing / not running during rollback!" >&2
        record_rollback_failure "FAILED_CADDY_CONTAINER_MISSING"
      fi
    fi

    local caddy_reloaded=0
    if [ "$caddy_discovery_status" = "CADDY_DISCOVERY_SUCCESS" ]; then
      if ! run_bounded "$CADDY_RELOAD_TIMEOUT" docker compose --env-file "$caddy_env_file" -f infra/oci/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
        echo "[deploy-prod] FATAL: Caddy reload failed during rollback!" >&2
        record_rollback_failure "FAILED_CADDY_RELOAD"
      else
        echo "[deploy-prod] Caddy reloaded successfully during rollback." >&2
        caddy_reloaded=1
      fi
    fi

    if [ "$caddy_restored" -eq 1 ] && [ "$caddy_reloaded" -eq 1 ]; then
      echo "[deploy-prod] Verifying post-rollback routed active release health and identity..." >&2

      local post_rollback_api_health_ok=0
      if ! run_bounded 15 curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/health/ready" >/dev/null 2>&1; then
        echo "[deploy-prod] FATAL: Post-rollback public routed API health probe failed!" >&2
        record_rollback_failure "FAILED_POST_ROLLBACK_API_HEALTH"
      else
        post_rollback_api_health_ok=1
      fi

      if [ "$post_rollback_api_health_ok" -eq 1 ]; then
        if [ -n "${ACTIVE_SHA:-}" ]; then
          local rollback_api_sha=""
          rollback_api_sha="$( (run_bounded 15 curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/api/v1/meta/build" 2>/dev/null || true) | node -e '
            let d = "";
            process.stdin.on("data", c => d += c);
            process.stdin.on("end", () => {
              try {
                const j = JSON.parse(d);
                process.stdout.write(j.git_sha || "");
              } catch {
                process.exit(0);
              }
            });
          ' 2>/dev/null || true)"

          if [ "$rollback_api_sha" != "$ACTIVE_SHA" ]; then
            echo "[deploy-prod] FATAL: Post-rollback public API git_sha '$rollback_api_sha' does not match active SHA '$ACTIVE_SHA'!" >&2
            record_rollback_failure "FAILED_POST_ROLLBACK_API_IDENTITY"
          fi
        else
          echo "[deploy-prod] WARNING: Previous active SHA is unavailable; post-rollback release identity verification cannot be certified." >&2
          record_rollback_failure "INCOMPLETE_POST_ROLLBACK_VERIFICATION"
        fi
      fi

      local post_rollback_web_health_ok=0
      if ! run_bounded 15 curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/" >/dev/null 2>&1; then
        echo "[deploy-prod] FATAL: Post-rollback public routed Web health probe failed!" >&2
        record_rollback_failure "FAILED_POST_ROLLBACK_WEB_HEALTH"
      else
        post_rollback_web_health_ok=1
      fi

      if [ "$post_rollback_web_health_ok" -eq 1 ] && [ -n "${ACTIVE_SHA:-}" ]; then
        local rollback_web_id=""
        rollback_web_id="$( (run_bounded 15 curl --connect-timeout 5 --max-time 15 --fail --silent --show-error -D - -o /dev/null "https://${OCI_PUBLIC_HOSTNAME}/" 2>/dev/null || true) | awk 'tolower($1) == "x-matchday-build-id:" { print $2 }' | tr -d '\r\n')"

        if [ "$rollback_web_id" != "$ACTIVE_SHA" ]; then
          echo "[deploy-prod] FATAL: Post-rollback public Web build ID '$rollback_web_id' does not match active SHA '$ACTIVE_SHA'!" >&2
          record_rollback_failure "FAILED_POST_ROLLBACK_WEB_IDENTITY"
        fi
      fi
    fi
  fi

  if [ "$ACTIVE_WORKER_STOPPED" -eq 1 ] || [ "$WORKER_HANDOVER_STARTED" -eq 1 ]; then
    echo "[deploy-prod] Restoring previous active worker ($ACTIVE_WORKER_SERVICE)..." >&2
    if ! run_bounded "$SERVICE_CONTROL_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml up -d "$ACTIVE_WORKER_SERVICE"; then
      echo "[deploy-prod] FATAL: Failed to restart previous active worker ($ACTIVE_WORKER_SERVICE) during rollback!" >&2
      record_rollback_failure "FAILED_WORKER_RESTORE"
    else
      active_worker_id="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q "$ACTIVE_WORKER_SERVICE" 2>/dev/null || true)"
      if [ -z "$active_worker_id" ]; then
        echo "[deploy-prod] FATAL: Restored active worker container ID not found!" >&2
        record_rollback_failure "FAILED_WORKER_RESTORE"
      else
        active_worker_state="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker inspect --format '{{.State.Status}}' "$active_worker_id" 2>/dev/null || echo "unknown")"
        if [ "$active_worker_state" != "running" ]; then
          echo "[deploy-prod] FATAL: Restored active worker is not running (status: $active_worker_state)!" >&2
          record_rollback_failure "FAILED_WORKER_RESTORE"
        fi
      fi
    fi
  fi

  echo "[deploy-prod] Stopping candidate slot services ($CANDIDATE_API_SERVICE $CANDIDATE_WEB_SERVICE $CANDIDATE_WORKER_SERVICE)..." >&2
  run_bounded "$SERVICE_CONTROL_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml stop "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE" "$CANDIDATE_WORKER_SERVICE" 2>/dev/null || true
  run_bounded "$SERVICE_CONTROL_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml rm -f "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE" "$CANDIDATE_WORKER_SERVICE" 2>/dev/null || true

  rm -f "$CANDIDATE_RUNTIME_CADDYFILE" 2>/dev/null || true
  if [ -f "$PREVIOUS_RUNTIME_CADDYFILE" ] && echo "${rollback_failures[*]}" | grep -q "FAILED_CADDY_RESTORE"; then
    echo "[deploy-prod] Preserving previous Caddy backup file for manual inspection: $PREVIOUS_RUNTIME_CADDYFILE" >&2
  else
    rm -f "$PREVIOUS_RUNTIME_CADDYFILE" 2>/dev/null || true
  fi

  local rollback_result="COMPLETED"
  if [ "${#rollback_failures[@]}" -eq 1 ]; then
    rollback_result="${rollback_failures[0]}"
  elif [ "${#rollback_failures[@]}" -gt 1 ]; then
    rollback_result="PARTIAL_FAILURE"
  fi

  local failures_joined=""
  if [ "${#rollback_failures[@]}" -gt 0 ]; then
    failures_joined=$(IFS=,; echo "${rollback_failures[*]}")
  fi

  if ! emit_receipt "ROLLBACK" "$ACTIVE_SLOT" "$reason" "$rollback_result" "$failures_joined"; then
    echo "[deploy-prod] WARNING: Failed to write rollback receipt" >&2
  fi

  if [ "$rollback_result" != "COMPLETED" ]; then
    echo "[deploy-prod] CRITICAL: Rollback finished with status $rollback_result; failures: [${rollback_failures[*]}]" >&2
  else
    echo "[deploy-prod] Rollback completed successfully." >&2
  fi

  exit 1
}

# Signal traps
handle_signal() {
  local sig="$1"
  echo "[deploy-prod] CAUGHT SIGNAL $sig during phase $PHASE" >&2
  if [ "$DEPLOYMENT_COMMITTED" -eq 1 ]; then
    echo "[deploy-prod] Deployment already committed. Exiting." >&2
    exit 0
  fi
  cleanup_and_rollback "Deployment interrupted by signal $sig during phase $PHASE"
}

trap 'handle_signal SIGINT' INT
trap 'handle_signal SIGTERM' TERM
trap 'handle_signal SIGHUP' HUP

handle_exit() {
  local exit_code=$?
  if [ "$DEPLOYMENT_COMMITTED" -eq 1 ] || [ "$ROLLBACK_IN_PROGRESS" -eq 1 ]; then
    return
  fi
  if [ "$exit_code" -ne 0 ] && [ "$PHASE" != "PREFLIGHT" ]; then
    cleanup_and_rollback "Process exited unexpectedly with code $exit_code during phase $PHASE"
  fi
}
trap handle_exit EXIT

echo "[deploy-prod] Pre-deploy: validating production configuration..."
run_bounded 30 node scripts/validate-production-config.mjs infra/oci/.env.prod

echo "[deploy-prod] Pre-deploy: checking migration safety..."
run_bounded 30 node scripts/certify-gate-f-migrations.mjs "$CANDIDATE_SHA"

if [ "${MATCHDAY_EMERGENCY_ROLLBACK:-0}" = "1" ] || [ "${ROLLBACK_IN_PROGRESS:-0}" = "1" ]; then
  echo "[deploy-prod] WARNING: Emergency rollback flag detected during forward candidate deployment; forward promotion remains strictly subject to freeze policy." >&2
  ROLLBACK_IN_PROGRESS=0
fi

# Check deployment freeze policy (OPS-015 preflight check)
echo "[deploy-prod] Pre-deploy: checking deployment freeze policy (OPS-015 preflight check)..."
if ! run_bounded 30 node infra/oci/deployment-freeze-policy.mjs infra/oci/.env.prod; then
  echo "[deploy-prod] FATAL: Deployment blocked by OPS-015 deployment freeze policy" >&2
  exit 1
fi

# Ensure production backend network exists deterministically
if ! run_bounded 10 docker network inspect matchday-prod_backend >/dev/null 2>&1; then
  echo "[deploy-prod] Creating matchday-prod_backend network (172.31.0.0/24)..."
  run_bounded 10 docker network create --subnet 172.31.0.0/24 matchday-prod_backend
fi

# Verify Caddy container and its bind mount configuration before building or launching candidate
if ! caddy_container="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker compose --env-file "$caddy_env_file" -f infra/oci/compose.yaml ps -q caddy)"; then
  cleanup_and_rollback "Failed querying Caddy container ID within timeout"
fi
if [ -z "$caddy_container" ]; then
  cleanup_and_rollback "Caddy container is not running"
fi

if ! caddy_network="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker inspect "$caddy_container" --format '{{json .NetworkSettings.Networks}}')"; then
  cleanup_and_rollback "Failed inspecting Caddy container networks within timeout"
fi
if ! echo "$caddy_network" | grep -q "matchday-prod_backend"; then
  echo "[deploy-prod] Attaching Caddy to matchday-prod_backend..."
  run_bounded "$SERVICE_CONTROL_TIMEOUT" docker network connect matchday-prod_backend "$caddy_container"
fi

echo "[deploy-prod] Verifying Caddy container mount configuration..."
if ! caddy_mount_info="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker inspect "$caddy_container" --format '{{range .Mounts}}{{println .Type .Source .Destination .RW}}{{end}}')"; then
  cleanup_and_rollback "Failed inspecting Caddy container mounts within timeout"
fi

caddy_mount_check="$(python3 -c "
import sys, os

mount_lines_str = sys.argv[1]
expected_dir = sys.argv[2]

mount_lines = [l.strip() for l in mount_lines_str.strip().split('\n') if l.strip()]
expected_dir_real = os.path.realpath(expected_dir)

has_valid_dir_mount = False
has_conflicting_file_mount = False
errors = []

for line in mount_lines:
    parts = line.split()
    if len(parts) >= 4:
        m_type, source, dest, rw = parts[0], parts[1], parts[2], parts[3]
    elif len(parts) == 3:
        m_type, source, dest, rw = 'bind', parts[0], parts[1], parts[2]
    else:
        continue

    source_real = os.path.realpath(source)

    if dest == '/etc/caddy/Caddyfile':
        has_conflicting_file_mount = True
        errors.append(f'REJECTED_FILE_MOUNT: {dest} from {source}')
    elif dest == '/etc/caddy':
        if m_type.lower() != 'bind':
            errors.append(f'NON_BIND_MOUNT: type={m_type} (required bind)')
        elif rw.lower() != 'false':
            errors.append(f'WRITABLE_MOUNT: rw={rw} (required read-only)')
        elif source_real != expected_dir_real:
            errors.append(f'WRONG_MOUNT_SOURCE: source={source_real} (expected {expected_dir_real})')
        else:
            has_valid_dir_mount = True

if not has_valid_dir_mount:
    if not any('WRONG_MOUNT_SOURCE' in e or 'WRITABLE_MOUNT' in e or 'NON_BIND_MOUNT' in e for e in errors):
        errors.append('MISSING_DIRECTORY_MOUNT: Container is missing required bind mount for /etc/caddy')
if has_conflicting_file_mount:
    errors.append('CONFLICTING_FILE_MOUNT: Standalone or conflicting file mount at /etc/caddy/Caddyfile is rejected')

if has_valid_dir_mount and not has_conflicting_file_mount and len([e for e in errors if not e.startswith('MISSING')]) == 0:
    print('VALID')
else:
    print('INVALID: ' + '; '.join(errors))
" "$caddy_mount_info" "$RUNTIME_CADDY_DIR")"

if [ "$caddy_mount_check" != "VALID" ]; then
  echo "[deploy-prod] ERROR: Caddy container mount configuration is invalid:" >&2
  echo "CADDY_RUNTIME_MOUNT_INVALID" >&2
  echo "EXPECTED_SOURCE=$RUNTIME_CADDY_DIR" >&2
  echo "EXPECTED_DESTINATION=/etc/caddy" >&2
  echo "REQUIRED_TYPE=bind" >&2
  echo "REQUIRED_READ_ONLY=true" >&2
  echo "" >&2
  echo "DEPLOYMENT_BLOCKED=YES" >&2
  echo "REASON=LEGACY_OR_INCOMPATIBLE_CADDY_MOUNT" >&2
  echo "DIAGNOSTIC=$caddy_mount_check" >&2
  cleanup_and_rollback "CADDY_RUNTIME_MOUNT_INVALID: $caddy_mount_check"
fi

PHASE="CANDIDATE_START"

echo "[deploy-prod] Building candidate slot ($CANDIDATE_API_SERVICE, $CANDIDATE_WEB_SERVICE, $CANDIDATE_WORKER_SERVICE)..."
if ! run_bounded "$BUILD_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml build --pull "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE" "$CANDIDATE_WORKER_SERVICE" migrate; then
  cleanup_and_rollback "Failed building candidate services within timeout"
fi

echo "[deploy-prod] Running database migrations..."
if ! run_bounded "$MIGRATION_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile migration run --rm migrate; then
  cleanup_and_rollback "Database migrations failed or timed out"
fi

echo "[deploy-prod] Starting candidate serving slot ($CANDIDATE_API_SERVICE, $CANDIDATE_WEB_SERVICE) alongside active slot $ACTIVE_SLOT..."
if ! run_bounded "$SERVICE_CONTROL_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml up -d "$CANDIDATE_API_SERVICE" "$CANDIDATE_WEB_SERVICE"; then
  cleanup_and_rollback "Failed starting candidate serving slot services"
fi

echo "[deploy-prod] Probing candidate API readiness on internal IP ($CANDIDATE_API_IP:4000)..."
candidate_api_ready=0
for attempt in $(seq 1 30); do
  if run_bounded 5 docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_API_SERVICE" node -e "fetch('http://127.0.0.1:4000/health/ready').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))" >/dev/null 2>&1; then
    candidate_api_ready=1
    break
  fi
  sleep 2
done

if [ "$candidate_api_ready" -ne 1 ]; then
  cleanup_and_rollback "Candidate API failed internal readiness probe"
fi

echo "[deploy-prod] Probing candidate API liveness..."
if ! run_bounded 5 docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_API_SERVICE" node -e "fetch('http://127.0.0.1:4000/health/live').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))" >/dev/null 2>&1; then
  cleanup_and_rollback "Candidate API failed internal liveness probe"
fi

echo "[deploy-prod] Verifying candidate API build identity..."
actual_sha="$(run_bounded 5 docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_API_SERVICE" node -e 'fetch("http://127.0.0.1:4000/api/v1/meta/build").then((r) => r.json()).then((b) => process.stdout.write(b.git_sha ?? "")).catch(() => process.exit(1))' 2>/dev/null | tr -d '\r\n')"
if [ "$actual_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate API reported git_sha '$actual_sha' which does not match candidate '$CANDIDATE_SHA'"
fi

api_env="$(run_bounded 5 docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_API_SERVICE" node -e 'fetch("http://127.0.0.1:4000/api/v1/meta/build").then((r) => r.json()).then((b) => process.stdout.write(b.environment ?? "")).catch(() => process.exit(1))' 2>/dev/null | tr -d '\r\n')"
if [ "$api_env" != "production" ]; then
  cleanup_and_rollback "Candidate API environment is '$api_env', expected 'production'"
fi

candidate_api_id="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q "$CANDIDATE_API_SERVICE")"
candidate_label_sha="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate_api_id" 2>/dev/null || true)"
if [ "$candidate_label_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate API image revision label '$candidate_label_sha' does not match '$CANDIDATE_SHA'"
fi

# Candidate Web Verification before promotion
echo "[deploy-prod] Probing candidate Web readiness on internal port ($CANDIDATE_WEB_IP:3000)..."
candidate_web_ready=0
for attempt in $(seq 1 30); do
  if run_bounded 5 docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_WEB_SERVICE" node -e "fetch('http://127.0.0.1:3000/').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))" >/dev/null 2>&1; then
    candidate_web_ready=1
    break
  fi
  sleep 2
done

if [ "$candidate_web_ready" -ne 1 ]; then
  cleanup_and_rollback "Candidate Web failed internal readiness probe"
fi

echo "[deploy-prod] Verifying candidate Web build identity..."
candidate_web_build_id="$(run_bounded 5 docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T "$CANDIDATE_WEB_SERVICE" node -e "fetch('http://127.0.0.1:3000/').then(r => process.stdout.write(r.headers.get('x-matchday-build-id') || '')).catch(() => process.exit(1))" 2>/dev/null | tr -d '\r\n')"
if [ "$candidate_web_build_id" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate Web reported build ID '$candidate_web_build_id' which does not match candidate '$CANDIDATE_SHA'"
fi

candidate_web_id="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q "$CANDIDATE_WEB_SERVICE")"
if [ -z "$candidate_web_id" ]; then
  cleanup_and_rollback "Candidate Web container ID not found"
fi

# OPS-015 TOCTOU Pre-Promotion Freeze Recheck
echo "[deploy-prod] Pre-promotion: rechecking deployment freeze policy (OPS-015 TOCTOU guard)..."
export MATCHDAY_DEPLOY_PHASE="PRE_PROMOTION"
export PHASE="PRE_PROMOTION"
if ! run_bounded 30 node infra/oci/deployment-freeze-policy.mjs infra/oci/.env.prod; then
  cleanup_and_rollback "Deployment freeze policy recheck failed before promotion"
fi

# Atomic Traffic Promotion via Same-Filesystem Rename
echo "[deploy-prod] Generating candidate runtime Caddy configuration..."
cp -p "$RUNTIME_CADDYFILE_PATH" "$PREVIOUS_RUNTIME_CADDYFILE"

python3 -c "
with open('$RUNTIME_CADDYFILE_PATH', 'r') as f:
    content = f.read()
updated = content.replace('$ACTIVE_API_IP:4000', '$CANDIDATE_API_IP:4000').replace('trusted_proxies $ACTIVE_WEB_IP', 'trusted_proxies $CANDIDATE_WEB_IP').replace('$ACTIVE_WEB_IP:3000', '$CANDIDATE_WEB_IP:3000')
with open('$CANDIDATE_RUNTIME_CADDYFILE', 'w') as f:
    f.write(updated)
"
chmod 600 "$CANDIDATE_RUNTIME_CADDYFILE" 2>/dev/null || true

# Mandatory validation of candidate Caddyfile using pinned container image
echo "[deploy-prod] Validating candidate runtime Caddy configuration using pinned Caddy image ($PINNED_CADDY_IMAGE)..."
if ! run_bounded "$CADDY_VALIDATION_TIMEOUT" docker run --rm --network none -v "$CANDIDATE_RUNTIME_CADDYFILE":/etc/caddy/Caddyfile:ro "$PINNED_CADDY_IMAGE" caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile; then
  cleanup_and_rollback "Candidate runtime Caddyfile failed syntax validation"
fi

# Atomic rename onto target runtime Caddyfile
if ! mv -f "$CANDIDATE_RUNTIME_CADDYFILE" "$RUNTIME_CADDYFILE_PATH"; then
  cleanup_and_rollback "Failed atomic rename of candidate runtime Caddyfile"
fi
PROMOTED=1
PHASE="PROMOTED"

echo "[deploy-prod] Reloading Caddy configuration..."
if ! run_bounded "$CADDY_RELOAD_TIMEOUT" docker compose --env-file "$caddy_env_file" -f infra/oci/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
  cleanup_and_rollback "Caddy reload failed during traffic promotion"
fi

# Post-Promotion Routed Health Checks
echo "[deploy-prod] Verifying public routed API health post-promotion..."
if ! curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/health/ready" >/dev/null; then
  cleanup_and_rollback "Public routed /health/ready probe failed post-promotion"
fi

echo "[deploy-prod] Verifying public routed API build identity post-promotion..."
public_api_sha="$(curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/api/v1/meta/build" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const b=JSON.parse(d);process.stdout.write(b.git_sha||"");}catch(e){process.exit(1);}});' || true)"
if [ "$public_api_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Public routed API git_sha '$public_api_sha' does not match candidate '$CANDIDATE_SHA'"
fi

echo "[deploy-prod] Verifying public routed Web health post-promotion..."
if ! curl --connect-timeout 5 --max-time 10 --fail --silent --show-error "https://${OCI_PUBLIC_HOSTNAME}/" >/dev/null; then
  cleanup_and_rollback "Public routed Web / probe failed post-promotion"
fi

echo "[deploy-prod] Verifying public routed Web build identity post-promotion..."
public_web_build_id="$(curl --connect-timeout 5 --max-time 15 --fail --silent --show-error -D - -o /dev/null "https://${OCI_PUBLIC_HOSTNAME}/" 2>/dev/null | awk 'tolower($1) == "x-matchday-build-id:" { print $2 }' | tr -d '\r\n')"
if [ "$public_web_build_id" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Public routed Web build ID '$public_web_build_id' does not match candidate '$CANDIDATE_SHA'"
fi

# Sequential Worker Handover
PHASE="WORKER_HANDOVER"
echo "[deploy-prod] Performing sequential worker handover..."
WORKER_HANDOVER_STARTED=1
echo "[deploy-prod] Stopping previous worker ($ACTIVE_WORKER_SERVICE)..."
if ! run_bounded "$SERVICE_CONTROL_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml stop "$ACTIVE_WORKER_SERVICE"; then
  cleanup_and_rollback "Failed stopping previous worker within timeout"
fi
ACTIVE_WORKER_STOPPED=1

echo "[deploy-prod] Starting candidate worker ($CANDIDATE_WORKER_SERVICE)..."
if ! run_bounded "$SERVICE_CONTROL_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml up -d "$CANDIDATE_WORKER_SERVICE"; then
  cleanup_and_rollback "Failed starting candidate worker within timeout"
fi

candidate_worker_id="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps -q "$CANDIDATE_WORKER_SERVICE")"
if [ -z "$candidate_worker_id" ]; then
  cleanup_and_rollback "Candidate worker container ID not found"
fi

worker_state="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$candidate_worker_id" 2>/dev/null || echo "unknown")"
if [ "$worker_state" != "running 0" ]; then
  cleanup_and_rollback "Candidate worker failed stability check: $worker_state"
fi

worker_sha="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$candidate_worker_id" 2>/dev/null | awk -F= '$1 == "GIT_SHA" { print $2 }')"
if [ "$worker_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate worker GIT_SHA '$worker_sha' does not match candidate '$CANDIDATE_SHA'"
fi

worker_label_sha="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate_worker_id" 2>/dev/null || true)"
if [ "$worker_label_sha" != "$CANDIDATE_SHA" ]; then
  cleanup_and_rollback "Candidate worker revision label '$worker_label_sha' does not match '$CANDIDATE_SHA'"
fi

echo "[deploy-prod] Retiring previous serving slot ($ACTIVE_API_SERVICE, $ACTIVE_WEB_SERVICE)..."
run_bounded "$SERVICE_CONTROL_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml stop "$ACTIVE_API_SERVICE" "$ACTIVE_WEB_SERVICE" 2>/dev/null || true
run_bounded "$SERVICE_CONTROL_TIMEOUT" docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml rm -f "$ACTIVE_API_SERVICE" "$ACTIVE_WEB_SERVICE" 2>/dev/null || true

# Persist active slot state atomically
tmp_state="${STATE_FILE}.tmp.$$"
printf 'ACTIVE_SLOT=%s\nACTIVE_SHA=%s\nUPDATED_AT=%s\n' "$CANDIDATE_SLOT" "$CANDIDATE_SHA" "$BUILD_TIMESTAMP" > "$tmp_state"
chmod 600 "$tmp_state" 2>/dev/null || true
mv -f "$tmp_state" "$STATE_FILE"

rm -f "$PREVIOUS_RUNTIME_CADDYFILE" 2>/dev/null || true

api_image_digest="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker inspect --format '{{.Image}}' "$candidate_api_id" 2>/dev/null || echo "unknown")"
worker_image_digest="$(run_bounded "$DOCKER_INSPECT_TIMEOUT" docker inspect --format '{{.Image}}' "$candidate_worker_id" 2>/dev/null || echo "unknown")"

if ! emit_receipt "SUCCESS" "$CANDIDATE_SLOT" "" ""; then
  echo "[deploy-prod] FATAL: Failed to write deployment receipt" >&2
  exit 1
fi

DEPLOYMENT_COMMITTED=1
PHASE="COMMITTED"

echo "=================================================="
echo "PRODUCTION DEPLOYMENT SUCCESSFUL"
echo "  Candidate SHA:       $CANDIDATE_SHA"
echo "  Promoted Slot:       $CANDIDATE_SLOT"
echo "  API SHA:             $actual_sha"
echo "  Worker SHA:          $worker_sha"
echo "  Build Timestamp:     $BUILD_TIMESTAMP"
echo "  API Image:           $api_image_digest"
echo "  Worker Image:        $worker_image_digest"
echo "  Hostname:            https://${OCI_PUBLIC_HOSTNAME}"
echo "=================================================="
