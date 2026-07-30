# Gate C C5 performance and reliability budgets

Status: **readiness baseline only**. These budgets become certifying only after
C4 has an exact-SHA PASS, the C5 branch is created from the C4 evidence commit,
and a calibration run confirms that the local test environment is not the
bottleneck.

## Assumptions

- Test data is synthetic and contains no real participants or credentials.
- PostgreSQL, Redis, API, web, and worker versions are pinned in the evidence receipt.
- Normal and peak tests run without injected infrastructure faults.
- Degraded tests inject one bounded fault at a time.
- Physical-device network tests use a trusted HTTPS origin.
- A failed correctness invariant fails the run regardless of latency.
- Percentiles are calculated from successful requests only; failures are reported separately.
- Each workload has at least 1,000 measured requests after warm-up unless the operation is intentionally low volume.

## Candidate budgets

| Operation / resource | Normal p50 | Normal p95 | Normal p99 | Peak p95 | Peak p99 | Hard maximum |
|---|---:|---:|---:|---:|---:|---:|
| Score-event append | 120 ms | 350 ms | 700 ms | 600 ms | 1,200 ms | 2,500 ms |
| Session refresh / writer renewal | 100 ms | 300 ms | 600 ms | 500 ms | 1,000 ms | 2,000 ms |
| Public projection read | 80 ms | 250 ms | 500 ms | 400 ms | 800 ms | 1,500 ms |
| Conditional public read (`304`) | 40 ms | 150 ms | 300 ms | 250 ms | 500 ms | 1,000 ms |
| Repair analysis | 180 ms | 700 ms | 1,500 ms | 1,200 ms | 2,500 ms | 5,000 ms |
| Repair draft save | 150 ms | 500 ms | 1,000 ms | 900 ms | 1,800 ms | 3,500 ms |
| Repair publication | 300 ms | 1,200 ms | 2,500 ms | 2,000 ms | 4,000 ms | 8,000 ms |
| Schedule PDF generation | 500 ms | 2,500 ms | 5,000 ms | 4,000 ms | 8,000 ms | 15,000 ms |
| Score-sheet generation | 300 ms | 1,500 ms | 3,000 ms | 2,500 ms | 5,000 ms | 10,000 ms |
| Offline replay, per command | 150 ms | 500 ms | 1,000 ms | 900 ms | 1,800 ms | 3,500 ms |

## Reliability budgets

| Signal | Normal | Peak | Degraded / recovery |
|---|---:|---:|---:|
| HTTP error rate excluding deliberately rejected conflicts | ≤ 0.10% | ≤ 0.50% | Every failure must match the injected fault contract |
| Accepted score-event loss | 0 | 0 | 0 |
| Duplicate canonical mutations | 0 | 0 | 0 |
| Cross-match or cross-tenant contamination | 0 | 0 | 0 |
| Repair publication winners per idempotency key | exactly 1 | exactly 1 | exactly 1 after retry |
| Public schedule/result version mismatch | 0 | 0 | 0 |
| Pending offline command loss | 0 | 0 | 0 |
| Deadlocks | 0 | 0 | 0 unless a dedicated deadlock test proves safe retry |
| PostgreSQL pool saturation | < 80% sustained | < 95% sustained | Recover below 80% within 60 s |
| Redis owned-key leakage after a run | 0 | 0 | 0 |
| Event-loop delay p99 | < 100 ms | < 250 ms | < 500 ms during bounded recovery |
| Process memory growth after steady state | < 10% | < 20% | Return within 10% of baseline after recovery |

## Recovery budgets

| Fault | Recovery-time objective | Data-loss objective |
|---|---:|---:|
| API or web process restart | 60 s | 0 accepted writes |
| Redis restart | 90 s | 0 canonical data; cache/lease state reconstructed safely |
| PostgreSQL restart | 180 s | 0 committed writes |
| Worker restart | 120 s | 0 accepted jobs; retries remain idempotent |
| Network partition / reconnect storm | 300 s after connectivity returns | 0 acknowledged or locally retained commands |
| Public projection regeneration | 300 s | 0 version mismatch |
| Backup restore | 30 min for the large profile | RPO = last verified backup; exact delta reported |

## Freeze procedure

1. Run a low-volume calibration against the final C4 candidate.
2. Record host CPU, memory, disk, PostgreSQL, Redis, and browser versions.
3. Confirm the host stays below 70% CPU and 80% memory during calibration.
4. Adjust a budget only with a written rationale and independent review.
5. Commit the final values before any certifying C5 run.
6. Any later budget change invalidates prior C5 evidence.
