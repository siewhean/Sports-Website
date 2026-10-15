# Emergency Break-Glass Procedure & Administrative Access (Drill Not Performed)

**Status:** Operational Runbook (Drill Not Performed)  
**Date:** 15 October 2026  
**Track:** R7.4 (Production identity and break-glass operations)  
**Applies to:** Platform administrators, OCI production VM, PostgreSQL database, Auth0 outage recovery

---

## 1. Overview & Scope

The Matchday production platform is designed to enforce multi-factor authentication (MFA) via WebAuthn for administrators and high-risk organiser actions once Auth0 production tenant configuration is completed.

The **Break-Glass Procedure** defines the authorised, audited, out-of-band operational mechanism to regain administrative control of the production infrastructure and application state if:

1. The external identity provider (Auth0) suffers an unrecoverable outage or regional disruption.
2. All enrolled security keys for administrators are lost, damaged, or inaccessible.
3. An active security incident requires immediate administrative access directly on the production host.

> [!WARNING]
> **Drill Status: Not Performed.**  
> This emergency break-glass procedure is documented as an operational runbook. The live drill has not yet been executed against production infrastructure.

---

## 2. Who May Run It & Security Principles

- **Authorised operator: the platform owner only.** No other person, contractor, or automated agent may execute this procedure. If the owner is unavailable, the procedure is not run; the incident is handled within normal access paths.
- **Notify before and after:** Before Step 1, the owner records the incident reference and notifies the agreed incident contacts (status page / incident channel) that break-glass access is starting; after Step 5, notifies that it has ended and attaches the audit `request_id` values.
- **Strict Emergency Use Only:** Break-glass access is reserved for Severity-1 outages and disaster recovery. It must never be used for ordinary administrative tasks, deployments, or schema changes.
- **Fail Closed:** The application layer enforces authentication in normal runtime. Emergency intervention operates strictly out-of-band on the host and database.
- **Audit Logging:** Every break-glass action must insert an audit record into `audit_events`, which has a trigger rejecting all `UPDATE` and `DELETE` operations (append-only). `actor_account_id` must be the **real operator's account UUID** (the owner's `accounts.id`), never `NULL` or a shared/service identity.
- **Ephemeral Access & Rotation:** All emergency sessions must be revoked at the end of the incident, and the credentials used must be rotated afterwards (see Step 5).

---

## 3. Host Ingress & Production Environment

### 3.1 Host Architecture

- **Host:** Oracle Cloud Infrastructure (OCI) Ampere A1 ARM64 VM (Phoenix region), public IP `129.146.6.204`, default login user `opc`.
- **Access Protocol:** SSH on port 22 using the owner's authorised SSH key, restricted by OCI security list ingress rules.
- **Working Directory:** `/opt/matchday/oci-src` (all `docker compose` commands below are run from here).
- **Compose:** project `matchday-prod` (declared by `name:` in `infra/oci/compose.prod.yaml`), always invoked as `docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ...` (see `infra/oci/README.md`, "Operations").
- **Database:** `POSTGRES_DB=matchday_prod`, `POSTGRES_USER=matchday_prod` (see `infra/oci/.env.prod.example`); the live values are in `infra/oci/.env.prod` on the host.
- **Internal Network:** The Docker bridge subnet `172.31.0.0/24` is internal to the VM and not reachable from the public internet.

---

## 4. Break-Glass Execution Protocol

### Step 1: Connect to OCI Production Host

From the owner's workstation with the production SSH key:

```bash
ssh -i /path/to/matchday_prod_ed25519 opc@129.146.6.204
cd /opt/matchday/oci-src
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml ps
```

### Step 2: Open Administrative Database Console

```bash
docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml \
  exec postgres psql -U matchday_prod -d matchday_prod
```

Look up the operator's own account UUID (used as `actor_account_id` in every audit row below):

```sql
SELECT id FROM accounts WHERE primary_email = '<OWNER_EMAIL>';
```

### Step 3: Record Break-Glass Audit Event

Insert an audit record in `audit_events` (schema: `0001_foundation.sql`):

```sql
INSERT INTO audit_events (
  id, occurred_at, request_id, actor_account_id, actor_type, organisation_id,
  action, target_type, target_id, reason, metadata
) VALUES (
  gen_random_uuid(),
  now(),
  'break-glass-' || to_char(now(), 'YYYYMMDD-HH24MISS'),
  '<OPERATOR_ACCOUNT_UUID>',          -- the real operator's accounts.id
  'platform_admin',
  NULL,
  'emergency_break_glass_initiated',
  'platform',
  'production',
  'Emergency administrative intervention: <incident reference>',
  jsonb_build_object('incident', '<incident reference>', 'host', '129.146.6.204')
);
```

### Step 4: Emergency Session Generation (If Web Access Required)

The application session cookie is `__Host-matchday_session` (production; `packages/config/src/index.ts`) and its value has the format `<id>.<secret>` (`packages/identity/src/session.ts`):

- `<id>` is the `identity_sessions.id` UUID.
- `<secret>` must match `^[A-Za-z0-9_-]{32,256}$`; the application itself uses 32 random bytes encoded as base64url.
- `identity_sessions.secret_hash` is the **SHA-256 hex digest of the UTF-8 `<secret>`** (`hashSessionSecret`), not of the whole cookie value.

Generate the values on the host (never paste them into chat, tickets or logs):

```bash
SESSION_ID=$(cat /proc/sys/kernel/random/uuid)
SECRET=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
SECRET_HASH=$(printf '%s' "$SECRET" | sha256sum | cut -d' ' -f1)
echo "$SESSION_ID $SECRET_HASH"   # the cookie value is "$SESSION_ID.$SECRET"
```

Insert the session (`0002_identity_sessions.sql`; leave the provider columns `NULL`, because `identity_sessions_provider_binding_check` from `0005` rejects a `provider_session_id` without `provider_issuer`/`provider_subject`):

```sql
INSERT INTO identity_sessions (
  id, account_id, secret_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at
) VALUES (
  '<SESSION_ID>', '<OPERATOR_ACCOUNT_UUID>', '<SECRET_HASH>',
  now(), now(), now() + interval '2 hours', now() + interval '4 hours'
);
```

Additional requirements for the session to be useful:

- **Platform admin role:** admin endpoints call `assertPlatformAdmin` (`apps/api/src/admin-runtime.ts`), which requires an active `account_platform_roles` row for the account (`role='platform_admin'`, `revoked_at IS NULL`, `expires_at` NULL or in the future). Confirm it exists; do not grant the role to any other account.
- **Assurance:** a session with no `identity_session_assurance` row is treated as single-factor, so endpoints gated by `IDENTITY_ASSURANCE_POLICY=mfa` will return `STEP_UP_REQUIRED`. Record in the audit metadata which actions were therefore not possible rather than fabricating an assurance row.
- **CSRF:** mutations require the `x-csrf-token` header. The token is an HMAC-SHA256 (keyed by `IDENTITY_CSRF_HMAC_SECRET`) of `matchday-csrf-v1:<session id>`, base64url-encoded (`apps/api/src/identity-runtime.ts`). Obtain it from the API rather than computing it: `GET /api/v1/identity/me` with the session cookie returns `csrf_token`.

### Step 5: Post-Incident Revocation, Rotation & Audit

1. **Revoke the emergency session:**

   ```sql
   UPDATE identity_sessions SET revoked_at = now()
   WHERE id = '<SESSION_ID>' AND revoked_at IS NULL;
   ```

2. **Log access termination in `audit_events`** (same `actor_account_id`):

   ```sql
   INSERT INTO audit_events (
     id, occurred_at, request_id, actor_account_id, actor_type, organisation_id,
     action, target_type, target_id, reason, metadata
   ) VALUES (
     gen_random_uuid(), now(),
     'break-glass-close-' || to_char(now(), 'YYYYMMDD-HH24MISS'),
     '<OPERATOR_ACCOUNT_UUID>', 'platform_admin', NULL,
     'emergency_break_glass_terminated', 'platform', 'production',
     'Emergency break-glass session concluded and revoked',
     jsonb_build_object('incident', '<incident reference>', 'session_id', '<SESSION_ID>')
   );
   ```

3. **Rotate after use:** rotate the SSH key used, and rotate `IDENTITY_CSRF_HMAC_SECRET` and the database password in `infra/oci/.env.prod` if they were exposed outside the host, then redeploy the exact SHA. Clear shell history containing `$SECRET`.
4. **Notify** the incident contacts that break-glass access has ended, with both audit `request_id` values.

---

## 5. Checkpoint CP7 Break-Glass Drill Record

| Field                 | Status                                                            |
| --------------------- | ----------------------------------------------------------------- |
| **Drill Status:**     | **Not Performed**                                                 |
| **Drill Date:**       | Pending owner rehearsal                                           |
| **Target Host:**      | OCI VM (Phoenix region)                                           |
| **Audit Log:**        | Pending initial live verification                                 |
| **Drill Conclusion:** | **PENDING** — Procedure documented; awaiting live rehearsal drill |
