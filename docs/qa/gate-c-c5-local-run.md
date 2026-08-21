# Gate C C5 Performance & Operational Drills local evidence

Local Gate C C5 validation: PASS

Validated scope: C5 sustained performance benchmarking (500 samples/op), latency budgets, 12 controlled failure drills, backup/restore rehearsal, dual HMAC rotation.

Source SHA: `8f7196478ce653b6f6dbb2940d89c92ae3d7cd92`
Branch: `integration/gate-c-final`

Evidence collected: 21 August 2026, Asia/Singapore

## Environment

- Darwin `arm64`
- Node `v24.18.0`
- pnpm `10.33.0`
- PostgreSQL `18.4`
- Redis `8.2.7`

## Performance Latencies (500 samples/operation)

| Operation              | Sample Count | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) | Budget p95           | Verdict  |
| :--------------------- | :----------- | :------- | :------- | :------- | :------- | :------------------- | :------- |
| **Score Event Ack**    | 500          | 7.69     | 9.69     | 10.00    | 13.55    | $\le 500\text{ ms}$  | **PASS** |
| **Public Truth Read**  | 500          | 14.20    | 16.52    | 16.73    | 16.93    | $\le 500\text{ ms}$  | **PASS** |
| **Result Convergence** | 500          | 16.60    | 18.83    | 20.95    | 21.15    | $\le 2000\text{ ms}$ | **PASS** |
| **Lease Takeover**     | 500          | 7.87     | 9.61     | 9.78     | 10.25    | $\le 2000\text{ ms}$ | **PASS** |
| **Repair Publication** | 500          | 7.93     | 9.53     | 9.71     | 10.08    | $\le 2000\text{ ms}$ | **PASS** |

## Controlled Failure & Recovery Drills

12/12 controlled failure drills executed successfully with deterministic recovery:

1. `postgres_interruption`: Safe retry after DB reconnect.
2. `redis_interruption`: Graceful fallback and recovery.
3. `api_interruption`: Worker drain and clean relaunch.
4. `web_interruption`: Offline storage fallback engaged.
5. `worker_interruption`: Job safely requeued.
6. `latency`: Timeout grace observed without score drop.
7. `connection_pressure`: Pool exhaustion queued safely.
8. `outbox_delay`: Eventual consistency verified.
9. `disk_pressure`: Quota boundaries enforced.
10. `pdf_failure`: Fallback export resilient.
11. `backup_restore`: Verified against PostgreSQL with zero data loss.
12. `projection_regeneration`: Rebuilt identically with monotonic versions.

## Operational Rehearsals

- **Backup & Restore**: Live rehearsal executed (`scripts/verify-backup-restore.sh`); 51 migrations and account tables verified with exact fingerprint match.
- **Dual HMAC Rotation**: Live rotation drill executed across 20 scorekeepers and 1,000 events with 0 score loss; runbook at `docs/operations/SCORING_ACCESS_HMAC_ROTATION.md`.

The sanitized machine-readable summary is [`gate-c-c5-final-evidence.json`](./gate-c-c5-final-evidence.json).
