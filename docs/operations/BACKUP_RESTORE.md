# Database backup and restore

## Foundation contract

PostgreSQL backups must be encrypted, access-controlled, monitored, and restorable into an isolated database. A backup is not considered valid until a restore has completed and schema constraints plus deterministic data fingerprints have been checked.

Phase 1 proves the procedure locally with a disposable source and restore database:

```sh
docker compose -f infra/local/compose.yaml up -d --wait
pnpm backup:verify
```

The verification script migrates a new source database, inserts a deterministic sentinel, creates a custom-format `pg_dump`, restores it into another new database, compares row counts and fingerprints, verifies a post-restore constraint-valid write, and removes both databases and the temporary dump.

## Production backups (single OCI VM)

Production is one VM running Docker Compose. Backups are implemented in `infra/oci/backup/` and wired into `infra/oci/compose.prod.yaml` and `infra/oci/deploy-prod.sh`.

| Piece                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup` compose service (profile `backup`, never started by `up`) | One-shot container built `FROM` the same digest-pinned Postgres 18.4 image as the database (so `pg_dump` always matches the server), plus `bash`, `curl`, `age`. Read-only root FS, `cap_drop: ALL`, `no-new-privileges`, 512 MB / 0.5 CPU.                                                                                                                                           |
| `matchday-backup.timer` + `.service` (host systemd)                | Runs `docker compose --profile backup run --rm backup backup` nightly at 19:15 UTC (03:15 Singapore) with `Persistent=true` catch-up. Chosen over a long-running cron/scheduler container: no always-on process or credentials, systemd gives journald logs, a failed-unit state and missed-run catch-up for free, and compose stays the single source for image, limits and network. |
| `matchday-backup.sh backup`                                        | `pg_dump --format=custom` -> `pg_restore --list` sanity check -> `age` encryption to `BACKUP_AGE_RECIPIENT` -> upload to `postgres/daily/<db>-<UTC stamp>.dump.age` plus a `.sha256` sidecar -> verify (remote size, then re-download and SHA-256) -> Sunday copy to `postgres/weekly/` -> retention pruning -> bucket usage check.                                                   |
| `deploy-prod.sh` pre-migration snapshot                            | Immediately before migrations run: `pg_dump` into `$MATCHDAY_BACKUP_DIR/premigration/` (default `/var/lib/matchday/backups`), validated with `pg_restore --list`, newest 5 kept locally, uploaded to `postgres/premigration/` when `BACKUP_S3_BUCKET` is set. A failed dump aborts the deploy (automatic rollback of the candidate; nothing promoted).                                |
| `restore-postgres.sh`                                              | List, download, checksum-verify, decrypt, `pg_restore` into a scratch database, print exact per-table row counts. Refuses to touch the production database name without `--allow-production-overwrite`.                                                                                                                                                                               |

**Failure signalling.** Any failure exits non-zero, logs `ERROR: BACKUP_STATUS=failed ...` to stderr (visible with `journalctl -u matchday-backup`), writes `status/status.json` with `"status":"failed"`, does not touch `status/last-success`, and pings `BACKUP_HEARTBEAT_URL/fail` when configured. Success logs `BACKUP_STATUS=ok`, refreshes `status/last-success` and pings `BACKUP_HEARTBEAT_URL`. Wire either an uptime/heartbeat monitor (see `docs/runbooks/uptime-monitoring.md`) or a check such as `find /var/lib/matchday/backups/status/last-success -mmin -1560` (26 h) into alerting.

**Retention and the 20 GB free tier.** Script-side pruning keeps 14 dailies, 8 weeklies and 10 pre-migration snapshots (`BACKUP_RETAIN_*`), about 32 objects. The run fails if usage under the prefix exceeds `BACKUP_MAX_TOTAL_BYTES` (15 GiB), which allows compressed dumps up to roughly 450 MB each. Add an Object Storage lifecycle rule as a second line of defence (below).

**Skipping the pre-migration snapshot.** Only `MATCHDAY_SKIP_PREMIGRATION_BACKUP=1` skips it (for example if the snapshot disk is full and the migration is known to be trivially safe). It prints a loud warning; any value other than `0`/`1` aborts the deploy. Do not leave it set.

### Owner one-time setup

1. **Bucket.** In the Singapore region (`ap-singapore-1`, configurable via `BACKUP_S3_REGION`) create a private Standard-tier bucket, for example `matchday-backups`. Note the Object Storage namespace (Profile menu -> Tenancy, or `oci os ns get`).
2. **Lifecycle rule (second line of defence).** Bucket -> Lifecycle Policy Rules -> create a rule: action `Delete`, target `Objects`, 60 days, prefix `postgres/`. Script pruning is authoritative; this only catches stragglers if pruning ever fails. Do not add an OCI retention rule that forbids deletes, or script pruning will fail.
3. **Dedicated user and policy.** Create an IAM user `matchday-backup` in a group `MatchdayBackupWriters` with only:
   `Allow group MatchdayBackupWriters to read buckets in compartment <compartment> where target.bucket.name='matchday-backups'`
   `Allow group MatchdayBackupWriters to manage objects in compartment <compartment> where target.bucket.name='matchday-backups'`
4. **Customer Secret Key.** User `matchday-backup` -> Customer secret keys -> Generate. Copy the secret immediately (shown once). The listed **Access Key** is `BACKUP_S3_ACCESS_KEY_ID`; the generated secret is `BACKUP_S3_SECRET_ACCESS_KEY`.
5. **Endpoint.** `BACKUP_S3_ENDPOINT=https://<namespace>.compat.objectstorage.ap-singapore-1.oraclecloud.com` (path-style addressing is used).
6. **Encryption key (do this on your own machine, not the VM).**
   ```sh
   age-keygen -o matchday-backup.agekey      # prints "Public key: age1..."
   ```
   Put only the `age1...` public key in `BACKUP_AGE_RECIPIENT` (comma-separate several to allow a second holder). Store `matchday-backup.agekey` offline: a password manager entry plus a printed or USB copy in a second location. **If this private key is lost, every encrypted backup is unreadable.** Never put it on the VM or in the bucket. With no recipient the backup refuses to run unless `BACKUP_ALLOW_PLAINTEXT=1`.
7. **VM.**
   ```sh
   cd /opt/matchday/oci-src
   sudo install -d -m 700 -o 1000 -g 1000 /var/lib/matchday/backups   # uid/gid = MATCHDAY_BACKUP_UID/GID, the user running deploy-prod.sh
   # fill the "Database backups" block in infra/oci/.env.prod (chmod 600), then:
   docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile backup build --pull backup
   docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile backup run --rm --no-deps backup backup   # first manual run
   sudo cp infra/oci/backup/matchday-backup.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now matchday-backup.timer
   systemctl list-timers matchday-backup.timer
   ```
   The `.env.prod` placeholders (`CHANGE_ME...`) are rejected by `scripts/validate-production-config.mjs`, so a deploy will not proceed until the backup block is filled in.

## Restore drill (owner, one time, then quarterly)

Run on the VM (or any host with Docker and network access to the bucket, using a scratch Postgres). Never restore into `matchday_prod` during a drill.

```sh
cd /opt/matchday/oci-src
R="docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml --profile backup run --rm --no-deps"
# Put the offline private key in RAM-backed storage for the duration of the drill only.
install -m 400 -o 1000 /path/to/matchday-backup.agekey /dev/shm/matchday-backup.agekey
RESTORE="$R -v /dev/shm/matchday-backup.agekey:/identity/key.txt:ro --entrypoint /opt/matchday-backup/restore-postgres.sh backup"
```

1. Note the start time. List what exists: `$RESTORE --list`.
2. Take a fresh backup so counts can be compared exactly: `$R backup backup` (expect `BACKUP_STATUS=ok`).
3. Restore the newest daily into a scratch database:
   `$RESTORE --latest daily --target-db matchday_restore_drill --identity /identity/key.txt`
   It downloads, verifies the `.sha256` sidecar, decrypts, runs `pg_restore --exit-on-error --single-transaction`, and prints `RESTORE_STATUS=ok` followed by exact `table|count` rows.
4. Verify row counts against production (low-traffic moment; rows written after step 2 will differ slightly):
   ```sh
   $RESTORE --counts-only --target-db matchday_prod            > /tmp/counts-prod.txt
   $RESTORE --counts-only --target-db matchday_restore_drill   > /tmp/counts-restored.txt
   diff /tmp/counts-prod.txt /tmp/counts-restored.txt && echo COUNTS-MATCH
   ```
   Also spot-check a few representative reads, for example `docker compose ... exec -T postgres psql -U "$POSTGRES_USER" -d matchday_restore_drill -c 'select count(*) from <a core table>;'`, and confirm the migration ledger table has the same row count as production.
5. Drop the scratch database: `docker compose --env-file infra/oci/.env.prod -f infra/oci/compose.prod.yaml exec -T postgres dropdb -U "$POSTGRES_USER" matchday_restore_drill`; remove `/dev/shm/matchday-backup.agekey`.
6. Record: backup key and timestamp, size, restore start/end (observed RTO), age of the backup (observed RPO), count diff result, operator, remediation. Repeat once with `--latest premigration` if a snapshot exists.

Use `--key <object key>` instead of `--latest` to restore a specific object, `--file <path>` for a local copy (for example `/var/lib/matchday/backups/premigration/*.dump`, which is unencrypted), and `--replace-target` to recreate an existing scratch database.

## Restore decision path (real incident)

1. Freeze writes: `docker compose ... stop api worker api-green worker-green` (whichever slot is active) and record the incident timestamp.
2. Take a safety dump of the damaged database first (`pg_dump --format=custom` via `docker compose exec`), then pick the newest verified backup before the damage (a `premigration/` snapshot if a migration caused it).
3. Rehearse into a scratch database first as in the drill, and run `--counts-only` plus application reads.
4. Overwrite production only with incident-commander approval: `$RESTORE --key <key> --target-db matchday_prod --identity /identity/key.txt --allow-production-overwrite` (single transaction with `--clean --if-exists`; a failure rolls back and leaves the pre-restore state).
5. Restart services, confirm `/health/ready`, and preserve the audit record.
6. Rotate any credentials exposed by the incident.

## What exists and what remains unproved

Implemented in the repository and exercised by tests with test doubles (`infra/oci/backup/backup.test.mjs`, `infra/oci/deploy-prod.test.mjs`): nightly encrypted full dumps, verified off-host upload, retention pruning, size guard, failure signalling, pre-migration snapshots that gate migrations, and a restore script that refuses accidental production overwrite.

Still unproved or not provided:

- **No live proof yet.** Nothing has run against a real OCI bucket, real Customer Secret Keys, the real `age` binary, or the production database. The owner's first manual run and restore drill above are the proof; until step 6 is recorded, treat recovery as unproved.
- **No continuous WAL archiving / point-in-time recovery.** Worst-case data loss is up to about 24 hours (or back to the last pre-migration snapshot for migration faults).
- **No cross-region copy.** Free-tier single-region Object Storage protects against VM or disk loss, not against loss of the whole Singapore region or the tenancy.
- **No immutable retention.** The backup credential can delete objects, so a compromised VM could delete backups. Rotating that key and keeping the age private key offline limits, but does not remove, this risk. Restore uses the same credential; there is no separate read-only restore identity.
- **Alerting is a signal, not a service.** The heartbeat URL, `status/last-success` file and failed systemd unit exist; the owner must attach them to a monitor (`docs/runbooks/uptime-monitoring.md`).
- **Operational realities:** the local copy on the VM disk is convenience only; the age private key is the single point of failure for readability.

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
