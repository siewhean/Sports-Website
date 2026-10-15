# Quarterly Backup Restore Drill Ledger

**Deliverable R5.6:** Regular recovery rehearsal ensuring backups remain decryptable, restorable, and structurally identical to production truth without risking live service disruption.

## Schedule

| Drill #     | Scheduled Date      | Target Environment                             | Backup Kind    | Execution Script                    | Status    |
| :---------- | :------------------ | :--------------------------------------------- | :------------- | :---------------------------------- | :-------- |
| **Drill 1** | **10 January 2027** | VM RAM / scratch DB (`matchday_restore_drill`) | `daily`        | `infra/oci/backup/restore-drill.sh` | Scheduled |
| **Drill 2** | **10 April 2027**   | VM RAM / scratch DB (`matchday_restore_drill`) | `daily`        | `infra/oci/backup/restore-drill.sh` | Pending   |
| **Drill 3** | **10 July 2027**    | VM RAM / scratch DB (`matchday_restore_drill`) | `weekly`       | `infra/oci/backup/restore-drill.sh` | Pending   |
| **Drill 4** | **10 October 2027** | VM RAM / scratch DB (`matchday_restore_drill`) | `premigration` | `infra/oci/backup/restore-drill.sh` | Pending   |

---

## Drill Execution Protocol

Drills are executed by the operator from their local machine holding the offline `matchday-backup.agekey`:

```sh
# Run automated restore drill against the newest daily backup:
infra/oci/backup/restore-drill.sh \
  --key ~/matchday-backup.agekey \
  --host opc@129.146.6.204 \
  --ssh-key ~/.ssh/matchday-c5-staging-oracle.key \
  --latest daily
```

### Safety Guarantees Built into `restore-drill.sh`

1. **Key Isolation**: The age private key is staged strictly into the VM's volatile, RAM-backed `/dev/shm` filesystem and shredded (`shred -u` / `rm -f`) upon exit.
2. **Database Isolation**: The drill restores exclusively into an isolated scratch database (`matchday_restore_drill`), never touching `matchday_prod`.
3. **Verification**: Compares exact per-table row counts between production and the restored snapshot.
4. **Cleanup**: Automatically drops the scratch database and purges temporary count files on both success and failure via an exit trap.

---

## Log Template

```markdown
### Drill Entry: YYYY-MM-DD

- **Operator**: <name/identity>
- **Target Host**: opc@129.146.6.204
- **Backup Key Restored**: <s3_object_key>
- **Backup Created At**: YYYY-MM-DDTHH:MM:SSZ
- **Drill Start Time**: YYYY-MM-DDTHH:MM:SSZ
- **Drill End Time**: YYYY-MM-DDTHH:MM:SSZ
- **Observed RTO**: <seconds>
- **Observed RPO**: <seconds>
- **Row Count Diff**: COUNTS-MATCH (0 discrepancies)
- **Result**: PASS
- **Notes / Observations**: None.
```
