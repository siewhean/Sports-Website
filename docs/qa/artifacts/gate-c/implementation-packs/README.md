# Gate C implementation downloads

This directory is the GitHub publication point for the Gate C C1 follow-up and C2 preparation handoff artifacts.

## Safety boundary

- These files are implementation handoff material, not certified application source or release evidence.
- Do not apply C2 until the C1 follow-up has a clean exact-SHA `PASS` and an independent review with `P0: 0` and `P1: 0`.
- Review every patch, mbox and executable script before use.
- Apply C2 packages only in the order documented by the preparation bundle.

## Connector limitation

The connected GitHub API supports UTF-8 repository files but does not expose a raw binary upload parameter. The original ZIP bundles therefore cannot be committed byte-for-byte through this connector. Their reviewable extracted files, checksums and application instructions are published here; original ZIP digests are recorded in `SHA256SUMS`.

## Artifact branch

`artifacts/gate-c-implementation-packs-20260728`

This branch is based on `agent/gates-c-f-preparation-20260725` and must not be merged wholesale into `main` or an implementation branch.