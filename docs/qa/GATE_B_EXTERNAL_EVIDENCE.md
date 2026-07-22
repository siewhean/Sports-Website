# Gate B external evidence

**Gate:** Organiser Alpha / Gate B  
**Validator:** `pnpm qa:gate-b:external`  
**Required directory:** `artifacts/qa/gate-b/external`  
**Maximum default age:** 30 days

Gate B cannot pass from local adapters, screenshots or written assurances. The strict runner requires five machine-readable receipts collected from the staging environment and bound to the exact commit under test.

## Rules

1. Every file must contain the exact `git rev-parse HEAD` value in `commit`.
2. `environment` must be `staging`.
3. Evidence must be collected within the configured age limit.
4. Do not store passwords, cookies, access tokens, refresh tokens, client secrets, private keys or credential-bearing URLs.
5. Provider receipt IDs may be stored. Raw provider payloads must remain in the provider system.
6. Reviewer identities must be SHA-256 hashes, not names, emails or phone numbers.
7. The five files belong under the ignored `artifacts/` directory and must not be committed.
8. Run the validator before the strict container. The strict container runs it again.

```bash
mkdir -p artifacts/qa/gate-b/external
pnpm qa:gate-b:external
bash scripts/run-gate-b-container.sh
```

## 1. Live OIDC lifecycle — `oidc.json`

The selected staging identity tenant must prove:

- authorization-code flow with PKCE, state and nonce;
- hosted account-recovery delivery;
- password-change session revocation;
- issuer/`sid` session revocation;
- signed provider event verification;
- replay rejection for the same provider event.

```json
{
  "schema_version": 1,
  "commit": "<40-character Git commit>",
  "environment": "staging",
  "provider": "<identity provider and tenant>",
  "collected_at": "2026-07-23T00:00:00.000Z",
  "issuer": "https://identity.example.com",
  "authorization_code_pkce": { "passed": true, "receipt_id": "<provider/test-run receipt>" },
  "hosted_recovery_delivery": { "passed": true, "receipt_id": "<message or workflow receipt>" },
  "password_change_revocation": { "passed": true, "receipt_id": "<event receipt>" },
  "sid_revocation": { "passed": true, "receipt_id": "<event receipt>" },
  "signed_event_verified": { "passed": true, "receipt_id": "<verification receipt>" },
  "event_replay_rejected": { "passed": true, "receipt_id": "<replay-test receipt>" }
}
```

## 2. CDN and purge — `cdn.json`

Use the deployed staging origin and immutable asset URL. Record an uncached request followed by a cached request, private response behavior, image negotiation and one real purge after publication.

```json
{
  "schema_version": 1,
  "commit": "<40-character Git commit>",
  "environment": "staging",
  "provider": "<CDN provider and distribution>",
  "collected_at": "2026-07-23T00:00:00.000Z",
  "public_url": "https://staging.example.com",
  "tls_valid": true,
  "brotli": true,
  "first_cache_status": "MISS",
  "second_cache_status": "HIT",
  "private_response_bypassed_shared_cache": true,
  "avif_negotiated": true,
  "webp_negotiated": true,
  "purge": {
    "passed": true,
    "receipt_id": "<provider purge receipt>",
    "published_version": 2,
    "purged_at": "2026-07-23T00:00:00.000Z"
  }
}
```

## 3. Hosted telemetry and alerting — `telemetry.json`

Generate a staging request and a controlled application error. Confirm the trace reached the hosted collector, the error reached the tracker, the alert reached the configured responder and the same request ID can be correlated across evidence.

```json
{
  "schema_version": 1,
  "commit": "<40-character Git commit>",
  "environment": "staging",
  "provider": "<telemetry/error provider>",
  "collected_at": "2026-07-23T00:00:00.000Z",
  "trace_exported": {
    "passed": true,
    "receipt_id": "<trace permalink or provider receipt>",
    "trace_id": "0123456789abcdef0123456789abcdef"
  },
  "error_captured": { "passed": true, "receipt_id": "<error event receipt>" },
  "alert_delivered": { "passed": true, "receipt_id": "<notification receipt>" },
  "request_correlation_verified": { "passed": true, "receipt_id": "<correlation review receipt>" }
}
```

## 4. Managed backup and regional restore — `restore.json`

Restore one encrypted retained backup into an isolated region or equivalent isolated managed environment. Compare deterministic row counts and SHA-256 data fingerprints after all migrations.

```json
{
  "schema_version": 1,
  "commit": "<40-character Git commit>",
  "environment": "staging",
  "provider": "<managed database provider and project>",
  "collected_at": "2026-07-23T00:00:00.000Z",
  "backup_id": "<managed backup ID>",
  "backup_created_at": "2026-07-23T00:00:00.000Z",
  "encrypted": true,
  "retention_days": 14,
  "source_region": "<source region>",
  "restore_region": "<different isolated region>",
  "restore_completed_at": "2026-07-23T00:15:00.000Z",
  "source_row_count": 100,
  "restored_row_count": 100,
  "source_fingerprint": "<64-character SHA-256>",
  "restored_fingerprint": "<same 64-character SHA-256>",
  "migration_head": "0030_phase4_idempotent_format_publication.sql",
  "rpo_minutes": 5,
  "rto_minutes": 15,
  "receipt_id": "<managed restore receipt>"
}
```

## 5. Organiser validation — `organisers.json`

At least two independent people must complete the staging organiser journey:

- one local/independent competition organiser;
- one national governing body, national event or equivalent national-level organiser.

They must test Assisted Setup, format selection, schedule generation, a lock or move, and publication. A PASS bundle cannot contain blocking findings.

```json
{
  "schema_version": 1,
  "commit": "<40-character Git commit>",
  "environment": "staging",
  "provider": "<survey, ticketing or research repository>",
  "collected_at": "2026-07-23T00:00:00.000Z",
  "reviews": [
    {
      "reviewer_id_hash": "<64-character SHA-256 of a stable internal reviewer identifier>",
      "scope": "local",
      "organisation_type": "independent organiser",
      "reviewed_at": "2026-07-23T00:00:00.000Z",
      "attestation_id": "<survey or signed review receipt>",
      "tasks": {
        "assisted_setup": true,
        "format_selection": true,
        "schedule_generation": true,
        "lock_or_move": true,
        "publication": true
      },
      "blocking_findings": [],
      "verdict": "PASS"
    },
    {
      "reviewer_id_hash": "<different 64-character SHA-256>",
      "scope": "national",
      "organisation_type": "national governing body",
      "reviewed_at": "2026-07-23T00:00:00.000Z",
      "attestation_id": "<survey or signed review receipt>",
      "tasks": {
        "assisted_setup": true,
        "format_selection": true,
        "schedule_generation": true,
        "lock_or_move": true,
        "publication": true
      },
      "blocking_findings": [],
      "verdict": "PASS"
    }
  ]
}
```

## Output

A successful validation writes mode-`0600` summaries to:

```text
artifacts/qa/gate-b/external-validation/summary.json
artifacts/qa/gate-b/external-validation/summary.md
```

Each source file is represented by its provider, collection date and SHA-256 digest. The source receipts remain private and untracked.
