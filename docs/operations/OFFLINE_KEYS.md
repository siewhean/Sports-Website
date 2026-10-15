# Offline Backup Key Storage Protocol

**Deliverable R5.7:** Ensure the decryption private key (`~/matchday-backup.agekey`) is protected against single-device loss, hardware failure, and hostile intrusion by maintaining two distinct offline backups.

## Key Overview

- **Key Path**: `~/matchday-backup.agekey`
- **Algorithm**: `age` asymmetric encryption (`X25519` keypair)
- **Role**: All nightly database dumps and pre-migration snapshots stored in OCI Object Storage are encrypted with the public recipient key before upload. Only this private key can decrypt backups for restore.
- **Rule**: This key **must never be committed to source control**, never baked into Docker images, and never stored persistently on the production VM filesystem.

---

## Redundant Storage Requirements (Two Offline Locations)

The owner must confirm storage in two separate offline locations:

### Location 1: Hardware-Encrypted Offline Storage (Primary Disaster Media)

- **Medium**: Dedicated hardware-encrypted USB flash drive (e.g. Apricorn Aegis, Kingston IronKey) or LUKS/FileVault-encrypted offline volume.
- **Access**: PIN/passphrase known to the owner.
- **Location**: Primary secure physical storage (e.g. fireproof home safe or key safe).

### Location 2: Physical Secure Vault / Encrypted Secondary Media (Secondary Media)

- **Medium**: High-durability archival paper printout (QR/text with key fingerprint) in a sealed tamper-evident envelope, or a second encrypted offline token stored in a separate geographical location (e.g. bank safety deposit box or secondary office safe).
- **Access**: Restricted access under owner control.

---

## Procedure for Generating & Storing Offline Copies

```sh
# 1. Verify key permissions locally:
chmod 400 ~/matchday-backup.agekey

# 2. Extract public recipient key (safe for public verification and compose config):
age-keygen -y ~/matchday-backup.agekey

# 3. Mount encrypted offline volume (e.g. /Volumes/SecureVault):
cp ~/matchday-backup.agekey /Volumes/SecureVault/matchday-backup.agekey
chmod 400 /Volumes/SecureVault/matchday-backup.agekey

# 4. Safely unmount media:
diskutil unmount /Volumes/SecureVault
```

## Checkpoint Confirmation

When both offline copies are placed in their respective secure locations, record the verification date and update Checkpoint CP5 in `docs/EXECUTION_ROADMAP.md`.
