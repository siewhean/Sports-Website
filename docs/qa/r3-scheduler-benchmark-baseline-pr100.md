# Scheduler benchmark (Track R3)

Generated 2026-10-12T15:41:14.749Z by `pnpm bench:scheduler` (apps/scheduler/tests/benchmark).
Job time is the whole optimiser run (one solver thread, every candidate re-verified).

## Feasible fixtures

| Fixture                 | Matches / slots | Iterations | Job time | Score | Back-to-backs | Min / avg rest | Rest SD | Days                                                    | Court spread | Moved |
| ----------------------- | --------------- | ---------- | -------- | ----- | ------------- | -------------- | ------- | ------------------------------------------------------- | ------------ | ----- |
| s1-badminton-rr8        | 28 / 36         | 64         | 0.54 s   | 63.75 | 4             | 0 / 44.38      | 15      | 11-14 09:30-18:00                                       | 0            | 0     |
| s2-canoe-polo-104       | 104 / 144       | 64         | 5.08 s   | 58.5  | 16            | 0 / 205.59     | 19.85   | 11-14 08:00-17:30, 11-15 08:00-16:00                    | 60           | 0     |
| s3-officials            | 16 / 36         | 16         | 0.27 s   | 66    | 12            | 0 / 30         | 0       | 11-14 09:00-16:00                                       | 0            | 0     |
| s4-exact-fit            | 28 / 28         | 16         | 0.29 s   | 75    | 8             | 0 / 30         | 9.92    | 11-14 09:00-16:00                                       | 0            | 0     |
| s5-locks                | 28 / 36         | 16         | 0.27 s   | 60    | 1             | 0 / 47.5       | 9.92    | 11-07 09:00-18:00                                       | 0            | 0     |
| s7-repair-court-closed  | 28 / 32         | 64         | 0.37 s   | 54    | 6             | 0 / 43.75      | 15      | 11-14 09:00-18:00                                       | 120          | 3     |
| round-robin-12-two-days | 66 / 72         | 16         | 0.80 s   | 73.75 | 0             | 30 / 158.5     | 0       | 11-14 09:00-18:00, 11-15 09:00-18:00                    | 60           | 0     |
| range-badminton-8       | 16 / 36         | 4          | 0.18 s   | 75.25 | 0             | 30 / 47.5      | 0       | 11-14 09:00-17:30                                       | 0            | 0     |
| range-badminton-12      | 24 / 36         | 4          | 0.31 s   | 65    | 28            | 0 / 30         | 0       | 11-14 09:00-17:00                                       | 0            | 0     |
| range-badminton-16      | 32 / 72         | 4          | 0.42 s   | 62    | 40            | 0 / 24.38      | 0       | 11-14 09:00-17:00                                       | 60           | 0     |
| range-badminton-24      | 48 / 72         | 4          | 0.47 s   | 61.5  | 128           | 0 / 19.58      | 0       | 11-14 09:00-17:30                                       | 0            | 0     |
| range-badminton-48      | 96 / 216        | 4          | 1.34 s   | 59.5  | 48            | 0 / 128.64     | 0       | 11-14 09:00-18:00, 11-15 09:00-15:30                    | 60           | 0     |
| range-table_tennis-8    | 16 / 54         | 4          | 0.22 s   | 78.29 | 0             | 60 / 61.67     | 0       | 11-14 09:00-17:40                                       | 0            | 0     |
| range-table_tennis-12   | 24 / 54         | 4          | 0.26 s   | 75    | 0             | 40 / 51.43     | 0       | 11-14 09:00-18:00                                       | 0            | 0     |
| range-table_tennis-16   | 32 / 108        | 4          | 0.36 s   | 65.32 | 107           | 0 / 23.75      | 7.81    | 11-14 09:00-15:20                                       | 80           | 0     |
| range-table_tennis-24   | 48 / 108        | 4          | 0.50 s   | 59    | 58            | 0 / 35.09      | 0       | 11-14 09:00-18:00                                       | 40           | 0     |
| range-table_tennis-48   | 96 / 162        | 4          | 2.13 s   | 64.82 | 408           | 0 / 15.38      | 0       | 11-14 09:00-16:20                                       | 80           | 0     |
| range-volleyball-8      | 16 / 36         | 4          | 0.19 s   | 79.9  | 0             | 60 / 215       | 0       | 11-14 09:00-17:00, 11-15 09:00-14:00                    | 0            | 0     |
| range-volleyball-12     | 24 / 36         | 4          | 0.26 s   | 61.43 | 28            | 0 / 187.14     | 0       | 11-14 09:00-18:00, 11-15 09:00-16:00                    | 0            | 0     |
| range-volleyball-16     | 32 / 72         | 4          | 0.32 s   | 76.5  | 0             | 60 / 176.25    | 0       | 11-14 09:00-17:00, 11-15 09:00-18:00                    | 0            | 0     |
| range-volleyball-24     | 48 / 72         | 4          | 0.42 s   | 59.71 | 123           | 0 / 138.89     | 0       | 11-14 09:00-18:00, 11-15 09:00-17:00                    | 120          | 0     |
| range-volleyball-48     | 96 / 162        | 4          | 1.05 s   | 58    | 138           | 0 / 235.11     | 0       | 11-14 09:00-18:00, 11-15 09:00-18:00, 11-16 09:00-18:00 | 240          | 0     |
| range-basketball-8      | 16 / 36         | 4          | 0.22 s   | 79.9  | 0             | 60 / 215       | 0       | 11-14 09:00-17:00, 11-15 09:00-14:00                    | 0            | 0     |
| range-basketball-12     | 24 / 36         | 4          | 0.23 s   | 61.43 | 30            | 0 / 185.71     | 0       | 11-14 09:00-18:00, 11-15 09:00-16:00                    | 0            | 0     |
| range-basketball-16     | 32 / 72         | 4          | 0.38 s   | 76.5  | 0             | 60 / 176.25    | 0       | 11-14 09:00-17:00, 11-15 09:00-18:00                    | 0            | 0     |
| range-basketball-24     | 48 / 72         | 4          | 0.44 s   | 59.71 | 123           | 0 / 138.89     | 0       | 11-14 09:00-18:00, 11-15 09:00-17:00                    | 120          | 0     |
| range-basketball-48     | 96 / 162        | 4          | 1.09 s   | 58    | 138           | 0 / 235.11     | 0       | 11-14 09:00-18:00, 11-15 09:00-18:00, 11-16 09:00-18:00 | 240          | 0     |
| range-canoe_polo-8      | 16 / 36         | 4          | 0.18 s   | 75.25 | 0             | 30 / 47.5      | 0       | 11-14 09:00-17:30                                       | 0            | 0     |
| range-canoe_polo-12     | 24 / 36         | 4          | 0.29 s   | 65    | 38            | 0 / 29.29      | 0       | 11-14 09:00-17:00                                       | 0            | 0     |
| range-canoe_polo-16     | 32 / 72         | 4          | 0.43 s   | 62    | 30            | 0 / 24.38      | 0       | 11-14 09:00-17:00                                       | 0            | 0     |
| range-canoe_polo-24     | 48 / 72         | 4          | 0.43 s   | 61.5  | 128           | 0 / 19.58      | 0       | 11-14 09:00-17:30                                       | 0            | 0     |
| range-canoe_polo-48     | 96 / 216        | 4          | 1.22 s   | 59.5  | 48            | 0 / 128.64     | 0       | 11-14 09:00-18:00, 11-15 09:00-15:30                    | 60           | 0     |

## Infeasible fixtures

| Fixture                    | Job time | Diagnostic              | Message                                                                                                                                                                                                                                                                                  |
| -------------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| infeasible-capacity        | 0.15 s   | insufficient_capacity   | 28 matches of 30 minutes need 840 court-minutes, but the venue windows provide 12 slots (360 court-minutes) over 1 day(s) (court-1: 6 slots; court-2: 6 slots). Add playing areas or time, or choose a smaller format.                                                                   |
| infeasible-daily-limit     | 0.15 s   | maximum_matches_per_day | 8 entries (rr:entry-1, rr:entry-2, rr:entry-3, rr:entry-4, rr:entry-5, rr:entry-6 and 2 more) may have to play up to 7 matches, but the required limit of 4 per day over 1 day(s) allows 4. Raise the daily limit to at least 7 or make it preferred.                                    |
| infeasible-required-rest   | 0.15 s   | minimum_rest            | 8 entries (rr:entry-1, rr:entry-2, rr:entry-3, rr:entry-4, rr:entry-5, rr:entry-6 and 2 more) may have to play up to 7 matches, but with 120 minutes of required rest only 4 fit in the venue windows (2026-11-14: 4). Reduce the required rest, make it preferred, or add playing time. |
| infeasible-knockout-window | 0.14 s   | **none**                |                                                                                                                                                                                                                                                                                          |
| infeasible-official-window | 0.13 s   | official_overlap        | Official official-a is assigned to 4 matches but only 2 non-overlapping slots are available                                                                                                                                                                                              |
| infeasible-locked-rest     | 0.13 s   | **none**                |                                                                                                                                                                                                                                                                                          |

## Format suggestion check (request path, five formats, unbudgeted)

| Venue                                               | Formats | Total  | Statuses                                         |
| --------------------------------------------------- | ------- | ------ | ------------------------------------------------ |
| S1 badminton 8 entries, 2 courts, 1 day             | 4       | 11 ms  | feasible, feasible, feasible, feasible           |
| S2-like canoe polo 4 x 16 entries, 4 courts, 2 days | 4       | 171 ms | infeasible, not_checked, feasible, infeasible    |
| 48 entries, 6 courts, 3 days                        | 4       | 290 ms | feasible, feasible, feasible, infeasible         |
| 4 x 48 entries, 8 courts, 3 days                    | 4       | 177 ms | infeasible, not_checked, not_checked, infeasible |
