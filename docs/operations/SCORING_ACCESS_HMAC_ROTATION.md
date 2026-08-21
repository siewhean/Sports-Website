# Scoring Access HMAC Key Rotation Operational Runbook

## 1. Overview & Architecture

Matchday employs dual HMAC keyrings for scoring access security:

1. **Rate-Limit & Attempt Fingerprint HMAC Keyring**: Managed in PostgreSQL table `scoring_access_hmac_key_versions` and enforced in `apps/api/src/scoring-access-hmac-keyring.ts`.
2. **Fallback-Code HMAC Keyring**: Configured via the `SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING` environment variable and parsed by `@matchday/config`.

### Key Security Principles

- **No Abuse Window**: Key rotation never resets abuse counters or splits rate-limit state in Redis.
- **Durable Version Binding**: Every persisted scoring access attempt and pass records its explicit `hmac_key_version`.
- **Primary-Write Only**: New attempts and tokens are derived exclusively using the current `primary` key version.
- **Dual Verification**: Signatures are accepted if valid under the `primary` key or any active `verificationOnly` key.
- **Fail-Closed on Retired/Unknown**: Retired or undeclared key versions are rejected immediately with typed `ApiError` responses.
- **Secret Redaction**: Audit logs, metrics, evidence ledgers, and telemetry record only key version labels (e.g. `v2-2026`), status, and timestamp metadata—never raw key material.

---

## 2. Keyring Specifications

### Schema & Constraints

- **Primary Key**: Exactly one active `primary` key version.
- **Verification-Only Keys**: Up to 7 non-retired `verificationOnly` key versions.
- **Key Material**: Minimum 32 bytes (256 bits) of cryptographically secure pseudo-random hex string.
- **Unique Secrets**: Key material between primary and verification-only keys must be strictly unique.
- **Redis TTL Retention**: Minimum retention window is 15 minutes (900 seconds) after demotion to `verification_only`.

---

## 3. Step-by-Step Rotation Procedure

### Phase 1: Key Generation & Staging

1. Generate a new 32-byte cryptographic secret:
   ```bash
   node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
   ```
2. Construct the new keyring configuration:
   ```json
   {
     "primary": {
       "version": "v2-2026",
       "secret": "<NEW_32_BYTE_HEX_SECRET>"
     },
     "verificationOnly": [
       {
         "version": "v1",
         "secret": "<OLD_32_BYTE_HEX_SECRET>"
       }
     ]
   }
   ```

### Phase 2: Deployment & Startup Reconciliation

1. Update `SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING` in the deployment environment.
2. Deploy the API service.
3. Upon startup, `reconcileScoringAccessHmacKeyring(sql, keyring)` acquires advisory transaction lock `9274421608195` and:
   - Registers `v2-2026` as `primary` in `scoring_access_hmac_key_versions`.
   - Transitions `v1` to `verification_only` with `retirement_not_before = NOW() + 15 minutes`.
   - Records `scoring_access_hmac_key.activated` and `scoring_access_hmac_key.verification_only` audit events.

### Phase 3: Overlap & Drain Window

1. Allow a minimum of 15 minutes to elapse.
2. Ensure that:
   - All client traffic transitioned to passes issued under the primary version.
   - Redis rate-limit counters associated with the older key version have naturally expired.
   - No unexpired attempt fingerprints remain in `scoring_access_attempts` referencing the old key version.

### Phase 4: Explicit Key Retirement

1. Authenticate as a platform administrator.
2. Invoke the retirement endpoint:
   ```bash
   curl -X POST "https://<API_HOST>/api/v1/platform/scoring-access/hmac-keys/v1/retire" \
     -H "Content-Type: application/json" \
     -H "Cookie: <ADMIN_SESSION_COOKIE>" \
     -H "x-csrf-token: <CSRF_TOKEN>" \
     -d '{"reason": "Scheduled quarterly rotation to v2-2026"}'
   ```
3. The API validates:
   - The key is in `verification_only` status.
   - `NOW() >= retirement_not_before`.
   - Zero active `scoring_access_attempts` have `rate_limit_state_expires_at > NOW()`.
   - Updates status to `retired` and emits an immutable audit event.
4. Remove `v1` from the `verificationOnly` array in subsequent environment configuration updates.

---

## 4. Emergency & Rollback Procedures

### Scenario A: Compromise of Newly Promoted Primary Key

1. Immediately generate a fresh version `v3-2026`.
2. Configure `primary: v3-2026` with `verificationOnly: [v1]`.
3. Do NOT include compromised `v2-2026` in `verificationOnly`.
4. Deploy and trigger emergency retirement for `v2-2026`.

### Scenario B: Unexpected Invalidation During Rotation

1. If client devices with older passes fail verification, ensure the old key version is present in `verificationOnly`.
2. Inspect `scoring_access_hmac_key_versions` table:
   ```sql
   SELECT key_version, status, activated_at, verification_only_since, retirement_not_before, retired_at
   FROM scoring_access_hmac_key_versions
   ORDER BY key_version;
   ```
3. Revert environment config to include the required key in `verificationOnly` and restart the service.

---

## 5. Verification & Drill Checklist

- [x] Dual HMAC parsing rejects `< 32 bytes` secrets.
- [x] Dual HMAC parsing rejects duplicate keys or versions.
- [x] Reconciler transitions primary and verification-only keys with advisory locks.
- [x] High-concurrency failure drill confirms 0 score loss across rotation boundaries.
- [x] Retirement fails closed when retention TTL has not elapsed.
