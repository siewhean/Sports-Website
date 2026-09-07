# Gate D current status

**Audit date:** 7 September 2026

**Status:** HOLD — scoring SLO failed; pilot and human/device evidence remain incomplete.

## Verified deployed candidate

Product candidate `0c1666c2a44f471a9adc0ce4a9b277b641587280` passed all five required hosted CI jobs in [run 34037201479](https://github.com/siewhean/Sports-Website/actions/runs/34037201479). Qualification control commit `43401d5fd4321165918ca99da62418e04c548f57` tested that candidate in [staging run 34037229008](https://github.com/siewhean/Sports-Website/actions/runs/34037229008), which failed on 6 September.

| Check                        | Observed result                                                         | Verdict                      |
| ---------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| QA-010 public reads, 2x peak | 200 successful requests; p95 1213.21 ms; zero errors                    | PASS for this candidate only |
| QA-011 scoring, 2x peak      | 240 writes across 24 streams; p95 1602.08 ms; zero errors; limit 500 ms | FAIL                         |
| QA-011 result propagation    | Scoring budget assertion aborted before measurement                     | NOT RUN                      |

The [retained staging artifact](https://github.com/siewhean/Sports-Website/actions/runs/34037229008/artifacts/9990695421) contains only the seed receipt and QA-010 receipt. QA-010 receipt digest is `d4fb4402660990df40cff83d57ab5e211341258a159b606bfac8e8b79ddf4535`. There is no passing QA-011 receipt from this run. Earlier component artifacts must not substitute for staging evidence.

## Scoring remediation

Render application logs for `matchday-gate-d-api` (`srv-dabbmk2jobas73c0de20`), queried on 7 September for `2026-09-06T13:58:13Z` through `2026-09-06T13:58:23.209Z`, contained 240 scoring request durations: server p50 499.12 ms, p95 1211.21 ms, maximum 1493.60 ms. These diagnostic timings confirm substantial server latency; they exclude client/network time and are not replacement certification receipts.

The local remediation combines the locked match-context and existing-stream reads into one database call. It retains stream validation, first-write creation, writer fencing, idempotency, and atomic event/audit/outbox writes. Regression results and independent review must be recorded before promoting this change. Its staging performance is unmeasured; the 500 ms scoring limit and frozen workload remain unchanged.

## Required closure

1. Validate the remediation, freeze a new product SHA, pass all five exact-SHA hosted CI jobs, and deploy that exact candidate to controlled staging.
2. Run the unchanged QA-010/QA-011 workloads; retain passing scoring and result-propagation receipts bound to that deployed SHA. A failed run remains failed.
3. Complete the [local pilot](pilots/local-pilot-01/summary.md), which is still **NOT YET RUN**, and supply all human/physical receipts required by `scripts/validate-gate-d-freeze.mjs`: accessibility, browser/device matrix, budget Android, incident/event-day tabletops, restore drill, deployed SEO crawl, local pilot, standings oracle, organiser interventions, zero Critical/High defects, and independent review.
4. Run the final freeze validator with those receipts. Local regression success does not certify Gate D or complete Gate E/F.
