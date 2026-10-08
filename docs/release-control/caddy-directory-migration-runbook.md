# Production Caddy Directory Mount Migration Runbook

**Document Version:** 1.0.0  
**Status:** APPROVED RUNBOOK — STRICTLY NON-EXECUTING DURING DEVELOPMENT  
**Target Host:** MATCHDAY OCI Production Instance (`matchday.poladex.shop`)  
**Container Target:** `matchday-oci-caddy-1` (service `caddy` in `infra/oci/compose.yaml`)  
**Target Maintenance Window:** 15-minute off-peak maintenance window prior to Singapore release  
**Required Operator Role:** Infrastructure Lead / Release Engineer with sudo & Docker privileges

> ⚠️ **CRITICAL INTEGRITY & BOUNDARY NOTICE: NON-EXECUTING**  
> Under the Gate F development boundaries and the Zero Production Mutations policy, **NO automated agent or tool may execute commands on the live production host**. This document is a non-executing operational manual prepared exclusively for execution by the designated human infrastructure operator during an approved maintenance window.

---

## 1. Executive Summary & Root Cause Analysis

### 1.1 The Stale Inode Problem in Docker File Bind Mounts

In Linux, file system entries are managed by inodes. When a single host file is mounted into a Docker container via a file bind mount:

```yaml
# LEGACY VULNERABLE CONFIGURATION
volumes:
  - /etc/matchday/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
```

The Docker daemon and Linux kernel mount the **specific inode** of `/etc/matchday/caddy/Caddyfile` into the container's mount namespace.

When `infra/oci/deploy-prod.sh` updates the configuration during a zero-downtime deployment or rollback, it employs an atomic replacement pattern to prevent partial writes:

```bash
# Atomic replacement on host
cp /tmp/Caddyfile.candidate /etc/matchday/caddy/.Caddyfile.candidate
mv -f /etc/matchday/caddy/.Caddyfile.candidate /etc/matchday/caddy/Caddyfile
```

When `mv -f` executes:

1. The host filesystem unlinks the old file inode from the directory entry `/etc/matchday/caddy/Caddyfile`.
2. A new file inode is created and associated with `/etc/matchday/caddy/Caddyfile`.
3. However, the running Caddy container's mount table still references the **unlinked old inode**.
4. Inside the container, `/etc/caddy/Caddyfile` continues to point to the old unlinked inode with the stale configuration.
5. When the deployment script executes `caddy reload --config /etc/caddy/Caddyfile`, Caddy reloads the **stale configuration**, completely unaware that the file on the host has changed.
6. The deployment appears to succeed, but traffic remains directed to the old slot, or in a rollback, traffic continues to route to the failing slot.

### 1.2 The Directory Bind Mount Solution

By mounting the parent directory instead of the individual file:

```yaml
# HARDENED DIRECTORY BIND MOUNT (PR #65)
volumes:
  - /etc/matchday/caddy:/etc/caddy:ro
```

1. Docker binds to the **directory inode** of `/etc/matchday/caddy`.
2. The directory inode remains constant across atomic renames (`mv -f`) of files within the directory.
3. When `mv -f` updates `Caddyfile`, the directory directory entry is updated.
4. The Caddy container immediately resolves `/etc/caddy/Caddyfile` to the newly moved inode.
5. Subsequent `caddy reload` operations immediately pick up the new routing configuration without requiring a container restart.
6. This behavior was formally certified in `infra/oci/caddy-mount-visibility.test.mjs` and verified in PR #65.

### 1.3 The Deployment Blocker

PR #65 added a strict preflight check to `infra/oci/deploy-prod.sh` (lines 580–617). If the live Caddy container has a file bind mount at `/etc/caddy/Caddyfile` or lacks the read-only directory bind mount at `/etc/caddy`, deployment aborts immediately:

```text
[deploy-prod] ERROR: Caddy container mount configuration is invalid:
CADDY_RUNTIME_MOUNT_INVALID
EXPECTED_SOURCE=/etc/matchday/caddy
EXPECTED_DESTINATION=/etc/caddy
REQUIRED_TYPE=bind
REQUIRED_READ_ONLY=true

DEPLOYMENT_BLOCKED=YES
REASON=LEGACY_OR_INCOMPATIBLE_CADDY_MOUNT
```

Because the current production container was started prior to PR #65, any deployment attempt on the live host will fail-closed. This runbook details how the human operator must migrate the running container.

---

## 2. Pre-Migration Verification & Inspection

Log into the production host as an authorised operator and run the diagnostic commands below.

### Step 2.1: Inspect Running Caddy Container

```bash
# 1. Check Caddy container status and ID
docker ps --filter "name=caddy" --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"

# 2. Inspect current mount configuration
caddy_cid=$(docker ps -q --filter "name=caddy")
docker inspect "$caddy_cid" --format '{{range .Mounts}}{{println .Type .Source .Destination .RW}}{{end}}'
```

**Diagnostic Analysis:**

- If the output contains `bind /etc/matchday/caddy/Caddyfile /etc/caddy/Caddyfile false` (or any mount targeting `/etc/caddy/Caddyfile`), the container is using the **legacy file mount** and **must be migrated**.
- If the output contains `bind /etc/matchday/caddy /etc/caddy false` and NO mount targeting `/etc/caddy/Caddyfile`, the migration is already complete.

### Step 2.2: Verify Network Attachments

```bash
# Verify Caddy is attached to both backend networks
docker inspect "$caddy_cid" --format '{{json .NetworkSettings.Networks}}' | jq .
```

Expected output must show membership in:

- `matchday-oci_backend` (172.30.0.10)
- `matchday-prod_backend` (172.31.0.10)

---

## 3. Host Directory Preparation

Before recreating the container, ensure the host directory structure and file permissions are properly configured.

### Step 3.1: Create Directory and Set Strict Permissions

```bash
# 1. Create runtime caddy directory if not already present
sudo mkdir -p /etc/matchday/caddy

# 2. Ensure root ownership and 755 directory permissions
sudo chown -R root:root /etc/matchday/caddy
sudo chmod 755 /etc/matchday/caddy

# 3. Verify existing Caddyfile or backup
if [ -f /etc/matchday/caddy/Caddyfile ]; then
  sudo cp -p /etc/matchday/caddy/Caddyfile /etc/matchday/caddy/Caddyfile.backup.$(date +%Y%m%d%H%M%S)
  sudo chmod 644 /etc/matchday/caddy/Caddyfile
fi
```

### Step 3.2: Verify Caddyfile Contents

Confirm that `/etc/matchday/caddy/Caddyfile` contains the valid production configuration routing to active slot backends (e.g., `172.31.0.11:4000` / `172.31.0.12:3000`):

```bash
sudo cat /etc/matchday/caddy/Caddyfile
```

---

## 4. Container Recreation Procedure

Recreate the Caddy container using the hardened Docker Compose configuration.

### Step 4.1: Pull Pinned Caddy Image

Ensure the exact pinned SHA image is present locally to minimize downtime during recreation:

```bash
cd /opt/matchday # or repository root on production host
sudo docker pull caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
```

### Step 4.2: Verify Compose Configuration

Check that `infra/oci/compose.yaml` declares the directory bind mount:

```bash
grep -A 5 "volumes:" infra/oci/compose.yaml | grep "/etc/caddy:ro"
```

Expected output:

```text
      - ${MATCHDAY_RUNTIME_CADDY_DIR:-/etc/matchday/caddy}:/etc/caddy:ro
```

### Step 4.3: Recreate Caddy Container

Execute the container recreation with minimal traffic disruption (< 2 seconds):

```bash
sudo docker compose \
  --env-file infra/oci/.env.prod \
  -f infra/oci/compose.yaml \
  up -d --force-recreate caddy
```

### Step 4.4: Ensure Production Backend Network Attachment

`deploy-prod.sh` requires Caddy to communicate with production containers on `matchday-prod_backend`:

```bash
new_caddy_cid=$(docker compose -f infra/oci/compose.yaml ps -q caddy)

if ! docker inspect "$new_caddy_cid" --format '{{json .NetworkSettings.Networks}}' | grep -q "matchday-prod_backend"; then
  echo "Attaching Caddy to matchday-prod_backend network..."
  sudo docker network connect matchday-prod_backend "$new_caddy_cid"
fi
```

---

## 5. Post-Migration Verification & Inode Visibility Test

Conduct rigorous post-migration verification to certify the fix.

### Step 5.1: Verify Mount Table via Docker Inspect

```bash
sudo docker inspect "$new_caddy_cid" --format '{{range .Mounts}}{{println .Type .Source .Destination .RW}}{{end}}'
```

**Pass Criteria:**

1. Contains: `bind /etc/matchday/caddy /etc/caddy false`
2. Does NOT contain: `/etc/caddy/Caddyfile`
3. Mode is strictly read-only (`false`).

### Step 5.2: Inode Atomic Replacement Test

Prove that atomic file replacements on the host are immediately reflected inside the container without restarting it:

```bash
# 1. Create a test probe file on the host
echo "INODE_TEST_1_$(date +%s)" | sudo tee /etc/matchday/caddy/.test-probe >/dev/null

# 2. Check initial visibility inside container
val1=$(sudo docker exec "$new_caddy_cid" cat /etc/caddy/.test-probe)
echo "Initial container view: $val1"

# 3. Perform atomic replacement on host (simulating deploy-prod.sh)
echo "INODE_TEST_2_REPLACED_$(date +%s)" | sudo tee /etc/matchday/caddy/.test-probe.candidate >/dev/null
sudo mv -f /etc/matchday/caddy/.test-probe.candidate /etc/matchday/caddy/.test-probe

# 4. Verify updated visibility inside container without restarting container
val2=$(sudo docker exec "$new_caddy_cid" cat /etc/caddy/.test-probe)
echo "Post-atomic-replace container view: $val2"

# 5. Clean up test files
sudo rm -f /etc/matchday/caddy/.test-probe

# Assertion
if [ "$val1" != "$val2" ] && [[ "$val2" == *"REPLACED"* ]]; then
  echo "✓ INODE VISIBILITY TEST PASSED: Container immediately sees atomic file replacements!"
else
  echo "✗ INODE VISIBILITY TEST FAILED: Container did not see atomic update."
  exit 1
fi
```

### Step 5.3: Test Caddy Validation & Zero-Downtime Reload

```bash
# Validate config inside container
sudo docker exec "$new_caddy_cid" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Reload config inside container
sudo docker exec "$new_caddy_cid" caddy reload --config /etc/caddy/Caddyfile
```

Expected output:

```text
Valid configuration
{"level":"info","ts":...,"msg":"reloaded configuration"}
```

---

## 6. End-to-End Ingress Health Verification

Verify public ingress routing across both staging and production virtual hosts.

### Step 6.1: Local Host Health Checks

```bash
# Test production homepage
curl -fsS -H "Host: matchday.poladex.shop" http://127.0.0.1/health/ready -o /dev/null -w "%{http_code}\n"

# Test staging / drill homepage
curl -fsS -H "Host: c5-drill.poladex.shop" http://127.0.0.1/health/ready -o /dev/null -w "%{http_code}\n"
```

Expected HTTP status code: `200`.

### Step 6.2: External Public HTTPS Health Checks

From an external machine or mobile hotspot:

```bash
# 1. Verify TLS certificate and HTTPS redirect
curl -Iv https://matchday.poladex.shop/api/v1/meta/build

# 2. Verify HTTP to HTTPS redirect
curl -Iv http://matchday.poladex.shop/
```

Verify TLS 1.3 handshake and `Strict-Transport-Security` header present.

---

## 7. Rollback & Emergency Contingency Procedures

If Caddy fails to start or serve traffic following recreation:

### Rollback Step 7.1: Inspect Error Logs

```bash
sudo docker compose -f infra/oci/compose.yaml logs --tail=50 caddy
```

### Rollback Step 7.2: Restore Previous Caddyfile

```bash
# If configuration syntax caused failure, restore backup Caddyfile
latest_bak=$(ls -t /etc/matchday/caddy/Caddyfile.backup.* | head -1)
if [ -n "$latest_bak" ]; then
  echo "Restoring Caddyfile from $latest_bak..."
  sudo cp -p "$latest_bak" /etc/matchday/caddy/Caddyfile
  sudo docker exec "$new_caddy_cid" caddy reload --config /etc/caddy/Caddyfile
fi
```

### Rollback Step 7.3: Emergency Container Reset

If the container became corrupted, restart it with explicit debug output:

```bash
sudo docker compose -f infra/oci/compose.yaml down caddy
sudo docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.yaml up -d caddy
```

---

## 8. Evidence Capture for Gate F Certification

Following successful migration, generate the operator evidence capture receipt:

```bash
# Capture container inspect receipt
caddy_cid=$(docker compose -f infra/oci/compose.yaml ps -q caddy)
mkdir -p /tmp/caddy-migration-evidence
docker inspect "$caddy_cid" > /tmp/caddy-migration-evidence/caddy-inspect.json
sha256sum /tmp/caddy-migration-evidence/caddy-inspect.json

echo "Migration complete. Mounts verified. Ready for deploy-prod.sh execution."
```

Once this procedure is complete on the host, the preflight blocker in `deploy-prod.sh` will evaluate to `VALID` and allow zero-downtime deployments to proceed.
