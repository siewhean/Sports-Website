# Phase 4 Gate B exact-SHA evidence

Local Gate B validation: PASS

Source SHA: `4f9202e4e1c546bfef2a23bcfc7e26825c90b314`

Branch: `fix/gate-b-local-remediation-20260724-132224`

Evidence collected: 27 July 2026, Asia/Singapore

The active schema-v2 record is
[`phase-4-final-evidence.json`](./phase-4-final-evidence.json). Immutable raw
artifacts remain outside Git under
`artifacts/qa/gate-b/4f9202e4e1c546bfef2a23bcfc7e26825c90b314/`.

## Integrity

- Schema-v2 manifest SHA-256:
  `93e9c1dfc502c0290f95838fa01286edf5fd923493cb8791f3e80d9cb9e2a030`
- Immutable evidence bundle SHA-256:
  `fdc97255d072825e70a70e60afe069b44489f06b6ac4c9cc9d7ff086d3f70b69`
- Independent review SHA-256:
  `54c0a10a63adcf82bed38add6d3ccecc82ff04100053838486f27a61c697649a`
- Final independent rehash attestation SHA-256:
  `66f7b1b91cb6a3ba3bce09b9e05fc579a9ff13ae958f63969477e847b3e21f65`
- Canonical immutable URI:
  `artifact://gate-b/4f9202e4e1c546bfef2a23bcfc7e26825c90b314/fdc97255d072825e70a70e60afe069b44489f06b6ac4c9cc9d7ff086d3f70b69`

The schema-v2 writer derived the bundle digest, byte size and URI from the
retained regular file. The validator reopened and rehashed the bundle, all 30
canonical command logs, accessibility and visual artifacts, and the review
document. It rejected caller-supplied digest/URI fields by construction.

## Executed evidence

- Node `v24.18.0`; pnpm `10.33.0`; PostgreSQL `18.4`; Redis `8.2.7`.
- Playwright `1.61.1`; Chromium `149.0.7827.55`; WebKit `26.5`.
- Frozen install, unchanged lockfile, clean-output guard, format, lint,
  typecheck and 697 unit tests passed.
- All 27 migrations, backup/restore, API 90/90, database 54/54 and the remaining
  infrastructure integration suites passed.
- The populated-upgrade test passed five of five exact-SHA runs in
  `563–627 ms` against its scoped `15,000 ms` timeout.
- Production audit reported no known vulnerabilities. OpenAPI, secret scan,
  production build, deployment manifest and origin delivery passed.
- General browser matrix: 278 passed, 9 documented project-applicability skips,
  zero failures.
- Real organiser journey: two independent runs; each passed phone Chromium,
  tablet WebKit and desktop Chromium against distinct disposable PostgreSQL and
  Redis isolation.
- Redis owned-key boundaries were `0 → 0` in both runs. Distinct namespace
  hashes were recorded and the unrelated near-prefix TTL guard survived.
- Accessibility: 68/68. Visual comparison: 57/57. State preservation repeat:
  20/20 with natural exit 0.
- `git diff --check` and `pnpm check` passed.

## Evidence boundary

Demo-backed fixtures provide stable visual regression. The real full-stack
journey proves persistence, browser-to-BFF/API integration, database lineage,
publication and Redis cleanup. They are complementary, not identical evidence.

The retained evidence is local release-gate proof. It does not claim a hosted
runner or production deployment.

## Historical records

Earlier schema-v1 manifests and verdicts are superseded. They remain available
in Git history but are not an acceptance source for this SHA.
