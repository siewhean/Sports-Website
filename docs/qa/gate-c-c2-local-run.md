# Gate C C2 exact-SHA local evidence

Local Gate C C2 validation: PASS

Validated scope: `SCR-001–020` and the C2 portions of `RES-011`, `RES-013`,
and `RES-014` only. Full Gate C remains incomplete.

Source SHA: `48feb8f7e33f0f8d3e6223b77813ed6c019e8179`

Branch: `fix/gate-c-c2-public-projection-remediation`

C1 base: `f7496452b66bac7f42290420291b17ee3a4ad326`

Evidence collected: 28 July 2026, Asia/Singapore

Hosted CI was triggered, but its jobs failed before executing any steps because
of the external runner/account limitation. Hosted CI is not used as
certification evidence.

## Environment

- Darwin `arm64`
- Node `v24.18.0`
- pnpm `10.33.0`
- PostgreSQL `18.4`
- Redis `8.2.7`
- Mailpit `1.27.4` (`healthy`)
- Playwright `1.61.1`
- Chromium `149.0.7827.55`
- WebKit `26.5`

## Immutable evidence

- Ledger:
  `artifacts/qa/gate-c-c2/48feb8f7e33f0f8d3e6223b77813ed6c019e8179/ledgers/2026-07-28T11-35-44-251Z-8a320e90-de64-45ad-bb9e-5c2c4e72d876/ledger.json`
- Ledger SHA-256:
  `b19f6361aad3e5b49f03bda7e968660890f63654d9ba835f59977defa22a121b`
- Read-only bundle:
  `artifacts/qa/gate-c-c2/48feb8f7e33f0f8d3e6223b77813ed6c019e8179/bundles/2026-07-28T11-35-44-251Z-8a320e90-de64-45ad-bb9e-5c2c4e72d876.tar.gz`
- Bundle SHA-256:
  `5dad798e99c0cfb04f913a275500719fb3f6d0c93b3ed4335bfeaf939ca711c1`
- Bundle size: `75,182,939` bytes; mode `0444`; 213 entries; zero
  symlinks.
- All 183 retained artifacts were reopened with matching SHA-256 and byte
  size.
- The source tree was clean before and after the ledger.

The sanitized machine-readable summary is
[`gate-c-c2-final-evidence.json`](./gate-c-c2-final-evidence.json).

## Executed result

All 31 ledger commands exited `0`. The ledger retains the exact command,
duration, output and artifact hash for:

- pinned toolchain versions, frozen install, unchanged lockfile and clean-output
  guard;
- format, lint, typecheck and 825 unit tests;
- all 31 forward migrations, backup/restore and 195 real-infrastructure
  integration tests, including API 109/109, database 59/59 and scheduler 3/3;
- fixture, Phase 2, Phase 3, Phase 4 and OpenAPI validation;
- production dependency audit, secret scan, production build, deployment
  manifest and origin-delivery verification;
- Playwright browser installation, generic E2E, accessibility and visual suites;
- `git diff --check`, complete `pnpm check`, two isolated real C2 matrices and
  the final clean-source guard.

The generic E2E command passed 319 tests. Nine intentional skips were
project-applicability exclusions; every required C2 project and check executed.
The same command also reran the real Phase 4 organiser journey twice, passing
three browser projects in each run. Accessibility passed 86/86 with zero WCAG
A/AA violations. Visual comparison passed 76/76, including the 15 reviewed C2
five-sport scorer baselines.

Each dedicated C2 run passed phone Chromium, phone WebKit and desktop Chromium.
The six projects used six distinct PostgreSQL identifiers and six distinct
Redis namespace identifiers. Each project exercised all five sports, giving 30
sport journeys in total. Every Redis receipt recorded owned keys `0 → 0`, and
all six unrelated guard keys survived. Sixty scorer and organiser screenshots
were retained.

The real browser matrix proves canonical append, idempotent replay,
sport-specific completion, finalisation, immediate result publication,
organiser reopening, correction, refinalisation, immutable audit review and
critical downstream-conflict acknowledgement. Its database oracles prove
contiguous event sequence and aggregate versions, result-version lineage,
standings and advancement projections, audit/outbox exactness and public
schedule isolation.

Browser console, page-error and unexpected-request guards were clean.
Production audit reported no known vulnerabilities. The secret scan reported
zero findings.

`pnpm check` intentionally runs its integration tasks without
`RUN_INFRA_TESTS=1`, so conditional infrastructure cases are skipped inside the
umbrella command. These are not acceptance skips: the separately required
real-infrastructure command executed the complete PostgreSQL and Redis matrix
and passed all 195 tests.

The earlier exact-SHA record for `c5c85bcacc1acaa23ceca05ba905d836c8e77cfd`
is retained in the machine-readable summary as historical and reopened. It is
not current certification evidence.

## Evidence boundary

This is reproducible local exact-SHA evidence, not hosted CI and not a
production deployment attestation. It certifies only the five-sport scoring,
correction and C2 result-conflict packet. Offline operation, schedule repair,
public-page completion, fallback documents and the full Gate C release verdict
remain outstanding.
