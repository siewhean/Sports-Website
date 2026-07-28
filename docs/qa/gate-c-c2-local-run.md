# Gate C C2 exact-SHA local evidence

Local Gate C C2 validation: PASS

Validated scope: `SCR-001–020` and the C2 portions of `RES-011`, `RES-013`,
and `RES-014` only. Full Gate C remains incomplete.

Source SHA: `c5c85bcacc1acaa23ceca05ba905d836c8e77cfd`

Branch: `fix/gate-c-c2-preparation`

C1 base: `f7496452b66bac7f42290420291b17ee3a4ad326`

Evidence collected: 28 July 2026, Asia/Singapore

Hosted GitHub Actions: Not executed because Actions allowance is unavailable.

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
  `artifacts/qa/gate-c-c2/c5c85bcacc1acaa23ceca05ba905d836c8e77cfd/ledgers/2026-07-28T09-54-10-351Z-456c0aca-f231-4b2f-a2d1-4275c42b5d68/ledger.json`
- Ledger SHA-256:
  `ccb6caeb8057fc1737f088e926506b77b89411cf43cdc16d0863dc2608234d31`
- Read-only bundle:
  `artifacts/qa/gate-c-c2/c5c85bcacc1acaa23ceca05ba905d836c8e77cfd/bundles/2026-07-28T09-54-10-351Z-456c0aca-f231-4b2f-a2d1-4275c42b5d68.tar.gz`
- Bundle SHA-256:
  `e8e30ffe3989ce5f8facab5658061559da3d8597c8fe802dab95c60aa39247b6`
- Bundle size: `81,559,302` bytes; mode `0444`; 213 entries; zero
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
- format, lint, typecheck and 823 unit tests;
- all 30 forward migrations, backup/restore and 192 real-infrastructure
  integration tests, including API 107/107, database 58/58 and scheduler 3/3;
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
and passed all 192 tests.

## Evidence boundary

This is reproducible local exact-SHA evidence, not hosted CI and not a
production deployment attestation. It certifies only the five-sport scoring,
correction and C2 result-conflict packet. Offline operation, schedule repair,
public-page completion, fallback documents and the full Gate C release verdict
remain outstanding.
