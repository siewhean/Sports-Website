# Database backup and restore

## Foundation contract

PostgreSQL backups must be encrypted, access-controlled, monitored, and restorable into an isolated database. A backup is not considered valid until a restore has completed and schema constraints plus deterministic data fingerprints have been checked.

Phase 1 proves the procedure locally with a disposable source and restore database:

```sh
docker compose -f infra/local/compose.yaml up -d --wait
pnpm backup:verify
```

The verification script migrates a new source database, inserts a deterministic sentinel, creates a custom-format `pg_dump`, restores it into another new database, compares row counts and fingerprints, verifies a post-restore constraint-valid write, and removes both databases and the temporary dump.

## Production requirements

Before launch, the infrastructure owner must add provider-native continuous WAL archiving, encrypted daily full backups, cross-region copies, immutable retention, alerting for missed backups, and least-privilege restore credentials. The target production recovery objectives remain subject to the regional durability decision and cannot be proved by the local script.

Every production restore drill must record the backup timestamp, restore start/end, recovered transaction point, integrity checks, observed RPO/RTO, operator, and any remediation. Restore into an isolated environment first; never overwrite the active production database during a drill.

## Restore decision path

1. Freeze writes and record the incident timestamp if an actual recovery is required.
2. Select the newest verified base backup before the target recovery point.
3. Restore into an isolated database and replay WAL to the approved point.
4. Run migrations in check mode, row/fingerprint checks, foreign-key checks, and representative application reads.
5. Obtain incident-commander approval before traffic cutover.
6. Rotate any credentials exposed by the incident and preserve the audit record.

## Production evidence boundary

`pnpm backup:verify` remains a disposable local test. Gate F simulations, their generated PASS fields, hosted CI, and a Vercel deployment cannot certify OCI backup readiness. No script in this section performs a production backup, restore, or rollout.

The backup audit consumes an independently captured operator/provider evidence file:

```sh
node scripts/run-gate-f-backup-restore-audit.mjs <exact-candidate-sha> /approved/evidence/production-backup.json
```

No input, malformed input, failed verification, local/test/simulation provenance, or missing retained files yields `PENDING` and a nonzero CLI exit. Existing synthetic disaster-recovery receipts are overwritten with `PENDING`; a database restore does not establish cross-region disaster recovery. The aggregate simulation remains `PENDING` with `production_certification: false`, even when independent backup evidence validates. Valid backup evidence alone cannot open Gate F; a future independent evidence path covering every required production gate is still required.

The input contract is `schema_version: production-backup-v1` and `evidence_class: production_operator_capture`. Supply observed values without credentials or row-level data:

- `candidate_sha`: exact certified source under assessment; `source.deployed_sha`: independently observed running production revision, which may differ. `source` also requires `environment: production`, opaque database/host identities, and `observed_at` in UTC.
- `operator.identity`, `operator.owner`, and `authorization.reference` with `authorization.scope: backup_and_isolated_restore_only`. This never authorizes application deployment.
- `backup`: identifier, `created_at`, `recovered_through_at`, positive `size_bytes`, SHA-256, PostgreSQL format/version. `storage` requires class/reference, verified off-host and encrypted flags, encryption/access-control references, positive retention days and retention-policy reference.
- `restore`: exact source backup identifier/checksum, verified checksum flag, isolated nonproduction target database and host identities distinct from production, start/completion timestamps. `integrity` requires successful restore, migration-ledger, schema, constraint, representative-read and application-schema checks, matching SHA-256 source/restore aggregate fingerprints, and a consistent snapshot reference.
- `recovery`: measurement reference, measured RTO seconds matching restore completion minus start, and measured RPO seconds matching backup creation minus its recovered transaction point. These are observed intervals, not asserted recovery budgets or proof of continuous WAL archiving.
- `captured_at` plus six `evidence_files`: kinds `backup_artifact`, `storage`, `restore`, `integrity`, `authorization`, `recovery`. Each requires a retained path, SHA-256, and UTC capture timestamp. Relative paths resolve beside the input file. The actual retained backup artifact is streamed to verify its size and checksum; other retained captures are independently hashed. Files must be nonempty and distinct.

Chronology must be consistent and captures cannot be future dated. The validator's explicit freshness policy defaults to 24 hours for the backup and source observation; this is an evidence acceptance limit, not an implemented backup schedule. A read-only loader accepts a positive `maxEvidenceAgeMs` only when the caller deliberately applies a separately approved policy.

Hashes establish retained-byte integrity, **not authenticity or authorization**. An infrastructure owner must review the original captures, confirm the production identities and authorization, and validate the claimed mechanisms before setting `production_operator_review: PASS` in the certification record. Unit tests generate temporary fixtures only; they do not prove any infrastructure exists. Do not commit backup bytes, credentials, private keys, or production PII. WAL/PITR, monitoring, immutable retention and cross-region DR remain unproved until their own operational evidence is captured.
