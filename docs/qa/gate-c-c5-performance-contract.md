# Gate C C5 performance and failure-test contract

Status: **IMPLEMENTED TOOLING / NOT CERTIFIED**. The repository contains the
fail-closed C5 runner, validators, browser matrix, and evidence sealing flow.
No workload, staging, physical-device, Grafana, or independent-review evidence
is established by source or unit tests alone.

## Approved pilot profile

The runner accepts only this exact approval object. Extra, missing, or changed
fields fail validation.

```json
{
  "profileId": "c5-pilot-2026-001",
  "durationSeconds": 3600,
  "scorekeeperCount": 2,
  "publicReaderCount": 150,
  "organiserWorkerCount": 5,
  "approval": {
    "owner": "Siew Hean, Tournament Director",
    "approvedAtUtc": "2026-07-04T08:30:00Z",
    "reference": "C5-PILOT-APPROVAL-2026-001"
  }
}
```

The hash-bound workload plan adds these immutable controls without changing the
approval JSON:

- minimum 150 successful samples per operation;
- maximum 7,200 score acknowledgements, 540,000 conditional reads, 7,200 lease
  takeovers, and 18,000 repair publications;
- exactly 300 public-convergence samples in two waves of 150;
- at most one sample per worker per second, with no catch-up overlap.

Each of the five operations must cover at least 3,600 seconds. The integrated
receipt must cover at least 18,000,000 milliseconds across the five serial
operations and record exact SHA, concurrency, elapsed time, sample count,
p50/p95/p99, errors, timeouts, cadence, and correctness.

## Pilot budgets and correctness gates

| Operation                             | Measure                                      |    Budget | Failure threshold                                           |
| ------------------------------------- | -------------------------------------------- | --------: | ----------------------------------------------------------- |
| Online score event acknowledgement    | API end-to-end p95                           | <= 500 ms | p95 > 500 ms or any correctness failure                     |
| Published public-result update        | acknowledgement to canonical public read p95 |    <= 2 s | p95 > 2 s or stale public version after convergence window  |
| Public current-truth conditional read | API p95                                      | <= 500 ms | p95 > 500 ms or incorrect 200/304 semantics                 |
| Lease takeover                        | authorised decision to fenced writer p95     |    <= 2 s | two active writers, stale generation accepted, or p95 > 2 s |
| Repair publication                    | organiser publish request p95                |    <= 2 s | non-atomic result/projection/receipt linkage or p95 > 2 s   |

A run fails on any timeout, expected or unexpected operation failure, duplicate
accepted write, stale writer, incorrect publication version, public/private
version mismatch, skipped check, or false correctness oracle. Every concurrent
public-convergence sample uses a separately provisioned disposable competition;
a later competition-global version does not satisfy an earlier sample.

Score-session resources are bounded to exactly 3,600 seconds, retain a
15-second-or-faster heartbeat, and must support abort and bounded shutdown.
Longer unapproved resource lifetimes are rejected.

## Integrated execution contract

The ledger runs two complete top-level passes. Each pass uses separate
PostgreSQL and Redis identities and executes, in fail-fast order:

1. the canonical local checks and exact-SHA Gate C access, C2, and C3 ledgers;
2. the real C4 boundary;
3. the C5 browser/service-worker matrix;
4. the integrated five-operation workload and controlled-failure suite.

The browser matrix is fixed to `desktop-chromium`, `desktop-firefox`,
`desktop-webkit`, `phone-chromium`, `phone-webkit`, and `tablet-webkit`. It uses
trusted HTTPS, service workers enabled, one worker, no retries, and rejects
failed, skipped, pending, or unexpected projects.

All twelve controlled failures are mandatory and serial:

- PostgreSQL, Redis, API, web, and worker interruption;
- latency, connection pressure, outbox delay, and disk pressure;
- PDF failure, backup/restore, and projection regeneration.

Each fault definition must specify one permitted injector and shell-free
injection, recovery, and cleanup argv. The manifest is bound to the exact SHA
and active disposable PostgreSQL/Redis identities, and must declare
`dedicated_c5_drill`, `production: false`, and `shared: false`. There is no fake
or skipped fallback.

The integrated C4 harness currently accepts only loopback PostgreSQL and Redis
infrastructure through `PHASE4_E2E_INFRA_MODE=local|docker`. The trusted-HTTPS
browser target and exact-SHA staging attestation are separate ledger inputs;
source implementation does not prove either is deployed or operational.

## Evidence boundary

Use the exact commands and receipt layout in
[`gate-c-c5-local-run.md`](./gate-c-c5-local-run.md). The execution command
requires a clean published SHA at exact upstream parity, Node `v24.18.0`, pnpm
`10.33.0`, the exact approval receipt, a dedicated non-production staging
target attestation, canonical command argv, and exact-SHA retained paths.

Execution writes an **unsealed** ledger only. Review preparation is a separate
command and requires all of the following external receipts, bound to the same
source and deployment SHA:

- two distinct cache lifecycle receipts proving
  `MISS -> HIT -> publication -> completed purge/204 -> fresh MISS -> HIT`,
  plus a bodyless origin `GET` of the identical public path/query returning
  `304` with the ingress ETag, Last-Modified value, and pre-publication version
  header while using an origin distinct from the edge;
- two distinct Grafana receipts proving workload, fault, recovery, alert
  routing, and alert recovery visibility;
- distinct trusted-HTTPS iPhone, iPad, and budget Android receipts covering all
  required offline/replay/finalisation journeys with zero errors or skips;

Preparation validates those receipts and their referenced bytes, snapshots
them with `execution.json` and the retained tree, seals the snapshot read-only,
and emits its canonical review-bundle SHA-256. Independent QA then inspects
that exact prepared snapshot and produces a receipt with `P0: 0`, `P1: 0`, and
`Verdict: PASS` bound to the prepared review-bundle hash.

Every retained artifact must be a regular non-symlink file of 1 byte through 5
MiB, remain below the exact-SHA evidence root, contain no secret-like fields or
sensitive topology, and match its referenced SHA-256. Finalization consumes
only the immutable prepared snapshot plus the bound QA receipt, reopens and
verifies every prepared hash, rejects mutation after preparation, writes the
final tree seal, and makes the complete ledger read-only.

## Current blockers

C5 remains **NOT CERTIFIED** until a final SHA is frozen, published at exact
upstream parity, deployed to the canonical staging target, and the two complete
one-hour-per-operation ledgers finish. Cache publication/purge evidence,
Grafana workload and drill evidence, all three physical-device journeys, and an
independent QA/QC PASS remain external execution requirements. Local or unit
validation of the implemented tooling cannot close those blockers.
