# Gate C C5 exact-SHA run boundary

Status: **operator reference for implemented tooling; not certification
evidence**.

## Phase 1: execute two exact-SHA ledgers

Run only from a clean published SHA with exact upstream parity, Node `v24.18.0`,
and pnpm `10.33.0`. All receipt paths must resolve below
`artifacts/qa/gate-c-c5/<SOURCE_SHA>/`; receipt files must be regular,
non-symlink, 1 byte to 5 MiB files.

Required environment:

| Variable                             | Boundary                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `GATE_C_C5_APPROVAL_RECEIPT`         | Exact `c5-pilot-2026-001` approval JSON                                                             |
| `GATE_C_C5_TARGET_RECEIPT`           | Passed, sealed, exact-SHA staging attestation for dedicated non-production/non-shared drill targets |
| `GATE_C_C5_C4_COMMAND_JSON`          | Exactly `["pnpm","test:e2e:phase4:real"]`                                                           |
| `GATE_C_C5_INTEGRATED_COMMAND_JSON`  | Exactly `["pnpm","--filter","@matchday/api","exec","tsx","scripts/run-gate-c-c5-integrated.ts"]`    |
| `GATE_C_C5_INTEGRATED_RECEIPT`       | Exact-SHA retained path containing a literal `{run}` placeholder                                    |
| `GATE_C_C5_CONTROLLED_FAILURES_JSON` | Exact-SHA manifest defining all twelve real drill hooks                                             |
| `PHASE2_E2E_WEB_BASE_URL`            | Trusted-HTTPS exact-SHA web deployment used by all six browser projects                             |
| `PHASE4_E2E_INFRA_MODE`              | `local` or `docker`; integrated C4 PostgreSQL and Redis URLs must remain loopback                   |

The ledger supplies `GATE_C_C5_SOURCE_SHA`, `GATE_C_C5_RUN_NUMBER`,
`GATE_C_C5_EVIDENCE_DIR`, `GATE_C_C5_APPROVED_PROFILE_SHA256`,
`GATE_C_C5_WORKLOAD_PROFILE_JSON`, and distinct Redis database numbers to each
run. Do not override those generated bindings.

```sh
pnpm evidence:gate-c-c5:execute
# equivalent public entrypoint: pnpm evidence:gate-c-c5:run
```

The command stops at the first failed gate and prints the new unsealed
`execution.json` path. Do not start run two manually and do not use the output
as a certification claim.

## Phase 2: prepare the immutable review bundle

After both runs complete, collect and retain the exact-SHA evidence bytes for
cache, Grafana, and physical devices. Set:

- `GATE_C_C5_LEDGER_DIRECTORY` to the unsealed ledger directory;
- `GATE_C_C5_IPHONE_RECEIPT`, `GATE_C_C5_IPAD_RECEIPT`, and
  `GATE_C_C5_ANDROID_RECEIPT` to three distinct device receipts;
- `GATE_C_C5_CACHE_RECEIPT` to the two-run cache receipt array;
- `GATE_C_C5_GRAFANA_RECEIPT` to the two-run Grafana receipt array;

Then prepare the review snapshot:

```sh
pnpm evidence:gate-c-c5:prepare-review
```

Preparation validates every deferred receipt and referenced retained byte,
copies execution, receipts, and retained evidence into `prepared-review/`,
seals that snapshot read-only, and emits its `review_bundle_sha256`. It does not
accept QA evidence and does not certify C5.

## Phase 3: independent QA and final sealing

Have the independent reviewer inspect the exact sealed `prepared-review/`
snapshot. Retain the review report below the exact-SHA evidence root and set
`GATE_C_C5_QA_RECEIPT` to a receipt whose `reviewed_bundle_sha256` equals the
digest emitted by preparation. Then run:

```sh
pnpm evidence:gate-c-c5:finalize
```

Finalization consumes only the sealed prepared snapshot plus QA, reopens and
rehashes the complete prepared tree, and refuses any mutation after preparation.
It also refuses a dirty or unpublished SHA, missing QA evidence bytes, skips,
errors, secrets, oversized files, or any QA verdict other than exact `PASS`
with zero P0/P1 findings.
