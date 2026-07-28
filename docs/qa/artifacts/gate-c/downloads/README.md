# Gate C downloadable implementation artifacts

This directory publishes every file previously offered as a ChatGPT download for the Gate C C1 follow-up and deferred C2 preparation work.

## Integrity-preserving ZIP storage

The GitHub connector could not prove byte-for-byte integrity for direct binary blob uploads. ZIP archives are therefore committed as ordered Base64 parts under `<archive>.parts/`.

Reconstruct every ZIP from the repository root:

```bash
bash docs/qa/artifacts/gate-c/downloads/reconstruct.sh
```

The script joins each archive's `part-*.b64` files, decodes them using the available macOS or GNU Base64 command, and verifies the resulting SHA-256 digest against `SHA256SUMS`.

## Direct text artifacts

The C1 patch, format-patch, README, apply script, validation script and focused-resume script are stored directly as reviewable text files.

## Release boundary

These files are handoff artifacts. They are not certified application source and do not advance Gate C by themselves. C2 must not be applied until the C1 follow-up receives clean exact-SHA evidence and a fresh independent review with `P0: 0` and `P1: 0`.
