# Scoring-access HMAC rotation

MATCHDAY uses two independent HMAC purposes for scoring access:

1. rate-limit/access-attempt fingerprints; and
2. low-entropy fallback-code hashes.

Both support overlap rotation, but they use separate keys, configuration, and
retirement evidence. Never reuse key material or assume rotating one purpose
rotates the other.

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
4. Confirm the startup health check and inspect the secret-free audit events
   `scoring_access_hmac_key.activated` and
   `scoring_access_hmac_key.verification_only`.

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
4. Remove the retired version from the deployment keyring and restart.

### Rate-limit rollback

Before retirement, rollback is configuration-only: restore the prior primary
and keep the newer key in `verificationOnly`; startup preserves aggregate
limits. After retirement, do not reactivate the version. Issue a distinct new
version instead, investigate the audit history, and record the incident in the
C5 operational evidence.

## Fallback-code HMAC keyring

`SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET` remains the single-key `v1`
compatibility value. Zero-downtime rotation is enabled by
`SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING`:

```json
{
  "primary": { "version": "v2", "secret": "<new secret>" },
  "verificationOnly": [{ "version": "v1", "secret": "<old secret>" }]
}
```

The API always issues and rotates new fallback codes with the configured
primary key. On exchange it computes candidate HMACs for the primary and every
verification-only key, looks for the retained full-history hash, and then runs
the normal Phase 2 credential exchange exactly once with the matching key.
Rate limiting, revocation, expiry, writer fencing, and audit behavior therefore
remain owned by the existing Phase 2 runtime.

The database keeps fallback-code hashes unique across retained history for one
HMAC key. During an overlap it is theoretically possible for the same 12-digit
plaintext to have been issued under different key versions; if the presented
code resolves to more than one retained candidate hash, exchange fails closed
rather than choosing one arbitrarily.

### Prepare a fallback-code rotation

1. Generate a new independent 32-byte-or-longer secret and a new public version
   name. Do not reuse a rate-limit, identity, cookie, or scoring-session key.
2. Immediately before the cutover, retain a **secret-free cutover inventory**
   of every pass that still has a fallback code:

   ```sql
   SELECT id, competition_id, match_id, expires_at, revoked_at
   FROM scoring_access_passes
   WHERE short_code_hash IS NOT NULL
   ORDER BY expires_at, id;
   ```

   The retained evidence must not include `short_code_hash`, raw fallback
   codes, tokens, session cookies, IP addresses, or HMAC key material.
3. Configure the new key as `primary` and the old key as `verificationOnly` in
   `SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING`.
4. Complete the rolling API deployment before removing any old key. Startup
   logs only public primary/verification version names.
5. Prove in staging that a code created before the cutover still exchanges,
   a code created after the cutover exchanges, revoked/expired codes remain
   rejected, and invalid attempts still consume the same rate-limit budget.

### Retire a prior fallback-code key

The current database records the fallback hash algorithm but does not persist
the secret-key version per pass. For that reason **time alone is not sufficient
retirement evidence**.

Before removing a verification-only key, every pass in the cutover inventory
must satisfy at least one of these conditions:

- the pass is revoked;
- the pass has expired; or
- an organiser has explicitly rotated its fallback code after the new primary
  became active.

Retain the secret-free rotation/revocation/expiry receipts against the cutover
inventory. Only when the inventory is fully discharged may the old key be
removed from `verificationOnly` and the API restarted.

A future schema may persist a public fallback HMAC key-version identifier per
pass and automate this retirement check. Until then the cutover inventory is
the release evidence and prevents an unverifiable early retirement.

### Fallback-code rollback

Before retirement, rollback is configuration-only: restore the old key as
primary and keep the newer key in `verificationOnly`. Codes created during the
attempted rotation continue to verify through the overlap. Do not delete or
rewrite retained hashes during rollback.

After the old key has been retired, do not reintroduce it casually. Use the
cutover evidence, investigate why rollback is required, and either issue a new
version or explicitly rotate affected fallback codes.

## Evidence required for C5

Retain the exact release SHA, redacted rate-limit key-version transition audit
rows, real-Redis aggregate-counter evidence, rate-limit retirement receipt,
fallback-code cutover inventory, pre/post-cutover exchange receipts, fallback
rotation/revocation receipts, and rollback rehearsals. Never retain secret
values, HMAC digests, raw credentials, IP addresses, session cookies, or access
URLs.
