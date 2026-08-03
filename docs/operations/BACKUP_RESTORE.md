# Database backup and restore

## Foundation contract

PostgreSQL backups must be encrypted, access-controlled, monitored, and restorable into an isolated database. A backup is not considered valid until a restore has completed and schema constraints plus deterministic data fingerprints have been checked.

Phase 1 proves the procedure locally with a disposable source and restore database:

```sh
docker compose -f infra/local/compose.yaml up -d --wait
BACKUP_VERIFY_POSTGRES_MODE=docker pnpm backup:verify
```

When Docker is not available, the verifier can instead use a local PostgreSQL
maintenance database. This mode is deliberately limited to Unix-socket or
loopback PostgreSQL and refuses any non-local host. It still creates only
generated disposable `matchday_backup_test_*` and `matchday_restore_test_*`
databases:

```sh
BACKUP_VERIFY_POSTGRES_MODE=local \
  BACKUP_VERIFY_ADMIN_DATABASE_URL=postgresql:///postgres \
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
