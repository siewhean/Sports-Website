# Gate C C1 exact-SHA local evidence

Local Gate C C1 validation: PASS

Validated scope: `ACC-001–010` only. Full Gate C remains incomplete.

Source SHA: `a896e4f48e005ad16c0360f6f41495d19282f12b`

Branch: `agent/gate-c-event-operations`

Certified Gate B base: `d432cb4f7c8b8c419acb1c8f556ed02dcd48b834`

Evidence collected: 28 July 2026, Asia/Singapore

Hosted GitHub Actions: Not executed because Actions allowance is unavailable.

## Environment

- Darwin `arm64`
- Node `v24.18.0`
- pnpm `10.33.0`
- PostgreSQL `18.4`
- Redis `8.2.7`
- Playwright `1.61.1`
- Chromium `149.0.7827.55`
- WebKit `26.5`

## Immutable evidence

- Ledger:
  `artifacts/qa/gate-c-access/a896e4f48e005ad16c0360f6f41495d19282f12b/ledgers/2026-07-27T16-44-18-151Z-a86c8de1-405e-4c36-9890-03ebceeb9bb6/ledger.json`
- Ledger SHA-256:
  `62216ec65f93d890e464f3e96263b39c2cb36c1167c930276ed4e9aaf8697208`
- Read-only bundle:
  `artifacts/qa/gate-c-access/a896e4f48e005ad16c0360f6f41495d19282f12b/bundles/2026-07-27T16-44-18-151Z-a86c8de1-405e-4c36-9890-03ebceeb9bb6.tar.gz`
- Bundle SHA-256:
  `9c055b6e11cb7c7cb2bc9a28c5ca56c8578d2f4d833941e9e60abce7aea9046c`
- Bundle size: `12,248,595` bytes; mode `0444`; 129 entries; zero
  symlinks.
- All 99 retained artifacts reopened with matching SHA-256 and byte size.
- The source tree was clean before and after the ledger.

The sanitized machine-readable summary is
[`gate-c-access-final-evidence.json`](./gate-c-access-final-evidence.json).

## Executed result

All 31 ledger commands exited `0`. The ledger contains the exact command,
duration and retained log hash for:

- toolchain versions, frozen install, unchanged lockfile and clean-output guard;
- format, lint, typecheck, 732 unit tests and the complete migration chain;
- backup/restore and 180 infrastructure integration tests, including API 95/95,
  database 58/58 and scheduler 3/3;
- fixture/Phase 2/Phase 3/Phase 4/OpenAPI validation;
- production dependency audit, secret scan, production build, deploy manifest
  and origin-delivery verification;
- Playwright browser installation, generic E2E, accessibility and visual suites;
- `git diff --check`, complete `pnpm check` and final clean-source guard; and
- two independent `pnpm test:e2e:gate-c-access:real` runs.

The generic E2E matrix passed 282 tests. Nine intentional skips were
project-applicability exclusions; every required project and check executed.
Accessibility passed 68/68 with zero WCAG A/AA violations. Visual comparison
passed 61/61.

Each real C1 run passed phone Chromium, phone WebKit and desktop Chromium. The
six projects used six distinct PostgreSQL identifiers and six distinct Redis
namespace identifiers. Every Redis receipt recorded owned keys `0 → 0`, and
all six unrelated guard keys survived.

Browser console and unexpected-request guards were clean. Production audit
reported no known vulnerabilities. The retained-artifact secret scan reported
zero findings.

`pnpm check` internally invokes non-infrastructure integration tasks and
therefore reports conditional infrastructure skips. These are not acceptance
skips: the separately required infrastructure command ran with real PostgreSQL
and Redis and passed all 180 tests.

## Evidence boundary

This is reproducible local exact-SHA evidence, not hosted CI and not a
production deployment attestation. It certifies the access, lease and transfer
packet only. Scoring breadth, offline operation, repair/public/fallback work and
the full Gate C release verdict remain outstanding.
