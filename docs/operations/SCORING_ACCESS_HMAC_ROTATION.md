# Scoring-access HMAC rotation

MATCHDAY uses two independent HMAC purposes for scoring access:

1. rate-limit/access-attempt fingerprints, which support overlapping versioned
   keys; and
2. low-entropy fallback-code hashes, which currently use a separate secret and
   deliberately require code invalidation and reissue during a secret rotation.

Never assume rotating one purpose rotates the other.

## Rate-limit and access-attempt keyring

This keyring rotates only the server-side HMAC keys used for scoring-access
rate-limit Redis keys and immutable access-attempt fingerprints. It never
rotates access-pass secrets, fallback-code secrets, sessions, or cookies.

### Prepare and activate a new primary

1. Generate a new independent 32-byte-or-longer secret in the deployment
   secret manager. Do not place it in tickets, shell history, browser code,
   logs, or this repository.
2. Configure `SCORING_ACCESS_RATE_LIMIT_HMAC_KEYRING` as JSON with the new
   `primary` version and every still-active prior version in
   `verificationOnly`.
   During the first C5 deployment that still accepts `v1`, calculate the
   documented SHA-256 material commitment for the existing deployed v1 secret
   and set `SCORING_ACCESS_RATE_LIMIT_LEGACY_V1_MATERIAL_COMMITMENT`. Startup
   fails closed if that public commitment is absent or does not match the
   configured v1 material; this prevents a replacement secret from silently
   splitting the retained C1-C4 Redis budget.
3. Deploy the configuration and API together. API startup transactionally
   reconciles the public version names with
   `scoring_access_hmac_key_versions`, audits activation/demotion without key
   material, and refuses an unknown, retired, or omitted non-retired version.
   Complete the rolling restart before demoting the former primary: each API
   process checks the durable primary record immediately before a Redis write
   or access-attempt receipt, so an old process fences itself once the
   demotion/retirement transaction has committed.
4. Confirm the startup health check and inspect the secret-free audit events
   `scoring_access_hmac_key.activated` and
   `scoring_access_hmac_key.verification_only`.
   Confirm `scoring_access_hmac_rate_limit_operations_total` and
   `scoring_access_hmac_key_lifecycle_total` contain only public versions,
   accepted-version counts, and lifecycle/operation labels.

During the overlap, new access-attempt rows and Redis writes use the primary
version. The limiter aggregates counters and cooldowns across all configured
versions plus the C1-C4 unversioned v1 Redis quartet. Do not remove `v1` until
the maximum 15-minute Redis retention period has elapsed.

### Retire a prior rate-limit version

1. Keep the prior version in `verificationOnly` until at least 15 minutes
   have elapsed after its demotion and its exact persisted
   `rate_limit_state_expires_at` values have expired.
2. A signed-in platform administrator calls:

   `POST /api/v1/admin/scoring-access-hmac-key-versions/{version}/retire`

   with the normal same-origin session cookie, allowed `Origin`, valid CSRF
   token, and a 3-1000 character operational reason.
3. The server rejects primary, unknown, already-retired, TTL-pending, or
   still-live-attempt versions. A successful retirement is one-way and writes
   an append-only platform-admin audit event containing only the version and
   reason.
4. Remove the retired version from the deployment keyring and restart. Startup
   rejects any attempt to reactivate a retired version.

### Rate-limit rollback

Before retirement, rollback is configuration-only: restore the prior primary
and keep the newer key in `verificationOnly`; startup preserves aggregate
limits. After retirement, do not reactivate the version. Issue a distinct new
version instead, investigate the audit history, and record the incident in the
C5 operational evidence.

## Fallback-code HMAC secret rotation

`SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET` is intentionally independent from
the rate-limit keyring. The current runtime writes fallback hashes as
`hmac_sha256_v1`; therefore changing this secret without first invalidating
existing fallback codes would make retained codes fail unpredictably across a
rolling deployment.

Until the fallback-code runtime has an overlapping versioned verification
keyring, use this fail-closed procedure:

1. Schedule the change outside an active event window and pause new fallback
   code issuance/rotation for the affected environment.
2. In one reviewed database transaction, invalidate every currently usable
   fallback code by setting `short_code_hash=NULL`,
   `fallback_code_hash_version='rotation_required'`, and recording the
   corresponding secret-free audit/outbox evidence. Do not change QR/access
   pass secrets or scoring-session credentials.
3. Confirm there are no non-null `short_code_hash` values before changing the
   secret. The full-history uniqueness invariant must remain present.
4. Rotate `SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET` in the secret manager and
   restart every API instance. Do not run old- and new-secret API instances at
   the same time after invalidation.
5. Organisers explicitly rotate/reissue fallback codes for passes that still
   require them. Newly issued hashes must be marked `hmac_sha256_v1` for the
   currently deployed runtime.
6. Rehearse rollback before the maintenance window. If the deployment must be
   rolled back, keep all invalidated fallback codes invalidated and reissue
   them; never restore old hashes from a backup merely to recover a code.

This destructive reissue procedure is safe but operationally heavier than a
true overlapping fallback-code keyring. Gate C must not claim that the
rate-limit keyring provides fallback-code key rotation; a future dual-version
runtime should replace this section before zero-downtime fallback-code secret
rotation is required.

## Evidence required for C5

Retain the exact release SHA, the redacted rate-limit key-version transition
audit rows, the real-Redis aggregate-counter receipt, the retirement API
receipt, the fallback-code invalidation/reissue receipt, and rollback
rehearsals. Never retain secret values, HMAC digests, raw credentials, IP
addresses, session cookies, or access URLs.
