# ADR 0007 — Scheduler solver strategy: no exact solver (CP-SAT) for now

**Status:** Accepted
**Date:** 12 October 2026
**Applies to:** Track R3 (R3.7), `packages/domain` scheduling and `apps/scheduler`

## Context

The original baseline proposed a Python CP solver. What shipped is a deterministic TypeScript greedy constructor. PR #99 added feasibility-first relaxation and diagnostics, and PR #100 added local search and minimal-change repair. Track R3 asks whether an exact solver such as OR-Tools CP-SAT is still needed. This ADR answers that question from the R3 benchmark suite (`apps/scheduler/tests/benchmark`, report in `docs/qa/r3-scheduler-benchmark.md`).

The remaining gap after #100 was back-to-back matches. S1 had 4 in a full job run and S2 (canoe polo, 104 matches) had 16. It was unclear whether those numbers reflected solver weakness or real capacity limits.

## Decision

Do not add CP-SAT or another exact solver now. Keep the in-process TypeScript solver and add a **bounded rest-aware construction** (`constructRestAwareSchedule`):

1. A depth-first search places matches slot by slot in time order. It admits a back-to-back only within an allowance, trying allowances 0, 1, 2, 4, … up to a ceiling.
2. Every placement passes the same hard and required checks as local search, and the result is fully re-validated.
3. Pruning uses free-slot capacity and a per-entry bound on how many matches still fit with a full buffer between them. Same-time interchangeable slots are deduplicated.
4. A deterministic node budget bounds the search (120 000 nodes, about 1 s). It never uses wall time.
5. Its result goes through the same local search. The job offers it first and uses its back-to-back count as a ceiling for every later candidate.

This search is also the witness search. When it succeeds at allowance 0, the schedule it returns proves that 0 back-to-backs is reachable.

## Evidence (benchmark, 64-iteration jobs, local M-series; CI asserts the same targets)

| Fixture                                                                        | Before (#100)         | After                  |
| ------------------------------------------------------------------------------ | --------------------- | ---------------------- |
| S1 8-team RR, 2 courts, 1 day: back-to-backs / score / job time                | 4 / 63.75 / 0.54 s    | **0** / 81.25 / 0.32 s |
| S2 canoe polo 104, 4 courts, 2 days, limit 4: back-to-backs / score / job time | 16 / 58.5 / 5.1 s     | **0** / 59.72 / 5.2 s  |
| S3 officials: back-to-backs                                                    | 12                    | 2                      |
| S4 exact fit 28/28: back-to-backs (0 provably impossible)                      | 8                     | 4                      |
| S7 re-plan after court closure: moved                                          | 3 of 28 (3 displaced) | 3 of 28                |
| Feasible fixtures with no_solution (32 fixtures)                               | 0                     | 0                      |
| Worst job time, 48 entries                                                     | –                     | 7.7 s                  |

On S1 and S2 the search finds a 0 witness in 32 and 121 nodes respectively, both in under 25 ms. An exact solver could not improve on 0. The remaining back-to-backs fall into two groups:

- **Provable floors.** In S4, every slot is full. Consecutive half-hours would have to alternate between one set of four entries and its complement, so cross-set matches could never be played.
- **Knockout-heavy range fixtures.** At 24 and 48 entries, each knockout match counts every possible participant, so one gap that is too short counts many times. For these fixtures no 0 witness is known and the target makes no claim. A CP model would face the same conservative possible-participant rule.

## Why not CP-SAT now

- Every Track R3 target is met without it, on the fixtures that define those targets.
- It would add a native or Python dependency to the API and scheduler images (arm64 builds), a second model of every hard rule, and a translation layer. Two models can diverge. Today `validateSchedule` remains the single authority.
- Determinism and bounded time come for free with node and move budgets. With CP-SAT they need fixed seeds, a single worker and time limits, and the result then depends on the machine.

## Revisit when

- A real fixture shows a false no_solution that the bounded search and relaxation ladder miss, or the job-time targets are breached.
- Products need proven optimality, for example contractual minimum rest across hundreds of matches. Even then, start with CP-SAT as an offline witness and lower-bound tool in the benchmark, not in the request path.
- The possible-participant rule for knockouts is refined (for example per-round rest), and that makes exact optimisation worthwhile at 24+ entries.

## Consequences

- A job spends up to about 1 s more on the rest-aware search. Infeasible inputs pay the full budget before returning `no_solution` with diagnostics.
- When the rest-aware search succeeds, or after the first offered candidate otherwise, a later candidate with more back-to-backs is not offered even if its score is higher. Re-planning with preserve-existing is exempt, because keeping matches in place outranks spacing.
- Locked-pair conflicts and knockout windows bounded by sequential group play now produce named diagnostics. Official diagnostics state the fix.
