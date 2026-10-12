# Scheduler benchmark (Track R3)

Generated 2026-10-12T18:16:35.749Z by `pnpm bench:scheduler` (apps/scheduler/tests/benchmark).
Job time is the whole optimiser run (one solver thread, every candidate re-verified), wall clock; CPU is the
process CPU time for the same run, which CI asserts because it does not grow when suites share a runner.

## Feasible fixtures

| Fixture                 | Matches / slots | Iterations | Job time | CPU     | Score | Back-to-backs | Min / avg rest | Rest SD | Days                                                    | Court spread | Moved |
| ----------------------- | --------------- | ---------- | -------- | ------- | ----- | ------------- | -------------- | ------- | ------------------------------------------------------- | ------------ | ----- |
| s1-badminton-rr8        | 28 / 36         | 64         | 0.56 s   | 0.72 s  | 81.25 | 0             | 30 / 40        | 0       | 11-14 09:00-17:00                                       | 0            | 0     |
| s2-canoe-polo-104       | 104 / 144       | 64         | 8.61 s   | 7.88 s  | 59.72 | 0             | 30 / 185.18    | 0       | 11-14 08:00-18:00, 11-15 08:00-13:30                    | 60           | 0     |
| s3-officials            | 16 / 36         | 64         | 0.97 s   | 1.23 s  | 63    | 2             | 0 / 39.38      | 12.99   | 11-14 09:00-17:00                                       | 0            | 0     |
| s4-exact-fit            | 28 / 28         | 64         | 1.40 s   | 1.62 s  | 75    | 4             | 0 / 30         | 15      | 11-14 09:00-16:00                                       | 0            | 0     |
| s5-locks                | 28 / 36         | 64         | 0.79 s   | 0.89 s  | 63.75 | 1             | 0 / 44.38      | 9.92    | 11-07 09:00-17:30                                       | 0            | 0     |
| s7-repair-court-closed  | 28 / 32         | 64         | 0.61 s   | 0.78 s  | 54    | 6             | 0 / 43.75      | 15      | 11-14 09:00-18:00                                       | 120          | 3     |
| round-robin-12-two-days | 66 / 72         | 64         | 2.58 s   | 3.06 s  | 75.11 | 0             | 30 / 150       | 0       | 11-14 09:00-18:00, 11-15 09:00-16:30                    | 0            | 0     |
| range-badminton-8       | 16 / 36         | 64         | 0.77 s   | 0.78 s  | 79.75 | 0             | 30 / 32.5      | 0       | 11-14 09:00-16:00                                       | 0            | 0     |
| range-badminton-12      | 24 / 36         | 64         | 1.42 s   | 1.65 s  | 60    | 8             | 0 / 38.57      | 14.14   | 11-14 09:00-18:00                                       | 0            | 0     |
| range-badminton-16      | 32 / 72         | 64         | 1.26 s   | 1.46 s  | 72.75 | 0             | 30 / 31.88     | 0       | 11-14 09:00-18:00                                       | 0            | 0     |
| range-badminton-24      | 48 / 72         | 64         | 3.36 s   | 3.57 s  | 61.5  | 128           | 0 / 20         | 0       | 11-14 09:00-17:30                                       | 0            | 0     |
| range-badminton-48      | 96 / 216        | 64         | 8.91 s   | 8.30 s  | 72.65 | 0             | 30 / 135       | 0       | 11-14 09:00-18:00, 11-15 09:00-16:30                    | 60           | 0     |
| range-table_tennis-8    | 16 / 54         | 64         | 0.75 s   | 0.84 s  | 80.53 | 0             | 40 / 41.67     | 0       | 11-14 09:00-15:40                                       | 0            | 0     |
| range-table_tennis-12   | 24 / 54         | 64         | 0.98 s   | 1.15 s  | 76    | 0             | 40 / 48.57     | 0       | 11-14 09:00-17:40                                       | 0            | 0     |
| range-table_tennis-16   | 32 / 108        | 64         | 1.53 s   | 1.88 s  | 74.79 | 0             | 40 / 41.25     | 0       | 11-14 09:00-17:40                                       | 0            | 0     |
| range-table_tennis-24   | 48 / 108        | 64         | 2.43 s   | 2.78 s  | 59    | 32            | 0 / 35.56      | 0       | 11-14 09:00-18:00                                       | 0            | 0     |
| range-table_tennis-48   | 96 / 162        | 64         | 10.14 s  | 10.18 s | 60.73 | 344           | 0 / 20.91      | 0       | 11-14 09:00-17:20                                       | 0            | 0     |
| range-volleyball-8      | 16 / 36         | 64         | 0.47 s   | 0.67 s  | 79.9  | 0             | 60 / 215       | 0       | 11-14 09:00-17:00, 11-15 09:00-14:00                    | 0            | 0     |
| range-volleyball-12     | 24 / 36         | 64         | 1.19 s   | 1.60 s  | 60    | 8             | 0 / 205.71     | 28.28   | 11-14 09:00-18:00, 11-15 09:00-18:00                    | 0            | 0     |
| range-volleyball-16     | 32 / 72         | 64         | 1.27 s   | 1.68 s  | 76.5  | 0             | 60 / 176.25    | 0       | 11-14 09:00-17:00, 11-15 09:00-18:00                    | 0            | 0     |
| range-volleyball-24     | 48 / 72         | 64         | 2.57 s   | 3.41 s  | 59.71 | 120           | 0 / 140        | 0       | 11-14 09:00-18:00, 11-15 09:00-17:00                    | 0            | 0     |
| range-volleyball-48     | 96 / 162        | 64         | 7.51 s   | 7.55 s  | 58    | 90            | 0 / 237.27     | 0       | 11-14 09:00-18:00, 11-15 09:00-18:00, 11-16 09:00-18:00 | 0            | 0     |
| range-basketball-8      | 16 / 36         | 64         | 0.59 s   | 0.70 s  | 79.9  | 0             | 60 / 215       | 0       | 11-14 09:00-17:00, 11-15 09:00-14:00                    | 0            | 0     |
| range-basketball-12     | 24 / 36         | 64         | 0.94 s   | 1.40 s  | 60    | 8             | 0 / 205.71     | 28.28   | 11-14 09:00-18:00, 11-15 09:00-18:00                    | 0            | 0     |
| range-basketball-16     | 32 / 72         | 64         | 1.00 s   | 1.54 s  | 76.5  | 0             | 60 / 176.25    | 0       | 11-14 09:00-17:00, 11-15 09:00-18:00                    | 0            | 0     |
| range-basketball-24     | 48 / 72         | 64         | 2.31 s   | 3.14 s  | 59.71 | 120           | 0 / 140        | 0       | 11-14 09:00-18:00, 11-15 09:00-17:00                    | 0            | 0     |
| range-basketball-48     | 96 / 162        | 64         | 6.16 s   | 6.96 s  | 58    | 90            | 0 / 237.27     | 0       | 11-14 09:00-18:00, 11-15 09:00-18:00, 11-16 09:00-18:00 | 0            | 0     |
| range-canoe_polo-8      | 16 / 36         | 64         | 0.35 s   | 0.54 s  | 79.75 | 0             | 30 / 32.5      | 0       | 11-14 09:00-16:00                                       | 0            | 0     |
| range-canoe_polo-12     | 24 / 36         | 64         | 0.89 s   | 1.33 s  | 60    | 8             | 0 / 38.57      | 14.14   | 11-14 09:00-18:00                                       | 0            | 0     |
| range-canoe_polo-16     | 32 / 72         | 64         | 0.82 s   | 1.21 s  | 72.75 | 0             | 30 / 31.88     | 0       | 11-14 09:00-18:00                                       | 0            | 0     |
| range-canoe_polo-24     | 48 / 72         | 64         | 2.21 s   | 2.94 s  | 61.5  | 128           | 0 / 20         | 0       | 11-14 09:00-17:30                                       | 0            | 0     |
| range-canoe_polo-48     | 96 / 216        | 64         | 7.59 s   | 6.90 s  | 72.65 | 0             | 30 / 135       | 0       | 11-14 09:00-18:00, 11-15 09:00-16:30                    | 60           | 0     |

## Infeasible fixtures

| Fixture                    | Job time | Diagnostic              | Message                                                                                                                                                                                                                                                                                     |
| -------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| infeasible-capacity        | 0.18 s   | insufficient_capacity   | 28 matches of 30 minutes need 840 court-minutes, but the venue windows provide 12 slots (360 court-minutes) over 1 day(s) (court-1: 6 slots; court-2: 6 slots). Add playing areas or time, or choose a smaller format.                                                                      |
| infeasible-daily-limit     | 4.11 s   | maximum_matches_per_day | 8 entries (rr:entry-1, rr:entry-2, rr:entry-3, rr:entry-4, rr:entry-5, rr:entry-6 and 2 more) may have to play up to 7 matches, but the required limit of 4 per day over 1 day(s) allows 4. Raise the daily limit to at least 7 or make it preferred.                                       |
| infeasible-required-rest   | 1.31 s   | minimum_rest            | 8 entries (rr:entry-1, rr:entry-2, rr:entry-3, rr:entry-4, rr:entry-5, rr:entry-6 and 2 more) may have to play up to 7 matches, but with 120 minutes of required rest only 4 fit in the venue windows (2026-11-14: 4). Reduce the required rest, make it preferred, or add playing time.    |
| infeasible-knockout-window | 0.34 s   | dependency_order        | Match ko:championship-r1-m1 must wait for 12 prerequisite match(es), which cannot finish before 2026-11-14 10:30, and no 30-minute slot remains after that. Add playing time after the prerequisite rounds.                                                                                 |
| infeasible-official-window | 0.94 s   | official_overlap        | Official official-a is assigned to 4 matches but only 2 non-overlapping slots are available. Widen the official's availability or assign another official.                                                                                                                                  |
| infeasible-locked-rest     | 0.16 s   | minimum_rest            | Locked matches 941e2c47-9262-4de3-a564-a1423cf25aab (2026-11-07 09:00) and 3246e0bd-d6a3-4149-aaa2-d708f8d40639 (2026-11-07 09:30) leave c8d8ea87-94b9-4078-9e31-2fc2d6711406 only 0 minutes of rest, but 30 minutes are required. Unlock or move one of them, or reduce the required rest. |

## Format suggestion check (request path, five formats, unbudgeted)

| Venue                                               | Formats | Total  | Statuses                                         |
| --------------------------------------------------- | ------- | ------ | ------------------------------------------------ |
| S1 badminton 8 entries, 2 courts, 1 day             | 4       | 11 ms  | feasible, feasible, feasible, feasible           |
| S2-like canoe polo 4 x 16 entries, 4 courts, 2 days | 4       | 184 ms | infeasible, not_checked, feasible, infeasible    |
| 48 entries, 6 courts, 3 days                        | 4       | 330 ms | feasible, feasible, feasible, infeasible         |
| 4 x 48 entries, 8 courts, 3 days                    | 4       | 209 ms | infeasible, not_checked, not_checked, infeasible |
