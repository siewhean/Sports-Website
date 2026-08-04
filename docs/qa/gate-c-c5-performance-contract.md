# Gate C C5 performance and failure-test contract

Status: `IN PROGRESS` — this is a test contract, not performance evidence.

## Scope

C5 validates the integrated C1–C4 path: score writes, lease takeover,
duplicate/reversal/finalisation behavior, repair/publication races, and
conditional public reads. It does not replace the required physical iOS and
budget-Android evidence.

## Pilot budgets

| Operation                             | Measure                                      |    Budget | Failure threshold                                           |
| ------------------------------------- | -------------------------------------------- | --------: | ----------------------------------------------------------- |
| Online score event acknowledgement    | API end-to-end p95                           | <= 500 ms | p95 > 500 ms or any correctness failure                     |
| Published public-result update        | acknowledgement to canonical public read p95 |    <= 2 s | p95 > 2 s or stale public version after convergence window  |
| Public current-truth conditional read | API p95                                      | <= 500 ms | p95 > 500 ms or incorrect 200/304 semantics                 |
| Lease takeover                        | authorised decision to fenced writer p95     |    <= 2 s | two active writers, stale generation accepted, or p95 > 2 s |
| Repair publication                    | organiser publish request p95                |    <= 2 s | non-atomic result/projection/receipt linkage or p95 > 2 s   |

The concurrency volume remains an external pilot decision. C5 harnesses must
declare the chosen scorekeeper, public-reader, and organiser-worker counts in
their retained receipt; a PASS is prohibited until the pilot owner records the
expected concurrency and approves it against these budgets.

## Harness rules

- Use disposable PostgreSQL schemas, a unique Redis namespace/database, and
  isolated authenticated test principals per run.
- Record source SHA, command, duration, sample count, p50/p95/p99, error rate,
  timeout count, and correctness-oracle result.
- Exercise both success and controlled failure: PostgreSQL/Redis/API/web/worker
  interruption, latency, connection pressure, outbox delay, PDF failure,
  backup/restore, and projection regeneration.
- Reject a run with a nonzero unexpected error rate, a duplicate accepted
  write, stale writer acceptance, leaked credential, or public/private version
  mismatch even when latency meets budget.
- A `public_result_convergence` sample must prove that canonical public
  freshness has the exact `result_version` returned by that sample's
  finalisation receipt and that the finalised match is publicly visible. A
  shared competition may not serve concurrent convergence samples: result
  versions are competition-global, so every concurrent sample needs an
  independently provisioned disposable public aggregate. A later version is a
  correctness failure, not evidence that the earlier result converged.
- Never direct load traffic at production or a shared environment.

## Required C5 external evidence

- Trusted HTTPS physical iPhone/iPad and budget Android journeys.
- Pilot concurrency and load approval.
- Operational owner approval for exported fallback documents and event-day
  incident/runbook procedures.

These are release-gate requirements, not tests that may be skipped.
