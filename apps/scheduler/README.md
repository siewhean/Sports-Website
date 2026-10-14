# Scheduling worker

`@matchday/scheduler` is an isolated BullMQ worker. It has no business HTTP API. The application API persists a strict immutable job first, commits that transaction, and then calls the exported `ScheduleEnqueuePort`:

```ts
interface ScheduleEnqueuePort {
  enqueueSchedule(payload: {
    schemaVersion: 1;
    jobId: string;
    competitionId: string;
    inputHash: string;
    correlationId: string;
  }): Promise<{ id: string; name: "schedule.optimize"; duplicate: boolean }>;
}
```

Use `new ScheduleJobQueue({ queueName: schedulerQueueName(environment), redisUrl })` in the API adapter. The scheduler exports this boundary; the application API must still wire it into its schedule creation transaction. `jobId` is the idempotency key. The queue payload is a reference, not a mutable problem copy. Cancellation is requested through the fenced PostgreSQL function/API mutation; removing an active BullMQ job is not the product cancellation contract.

## Lifecycle guarantees

- PostgreSQL fences one queued/running job per competition and every worker mutation carries an opaque fence token.
- Input is verified against the persisted SHA-256 canonical hash and a strict, unknown-key-rejecting transport schema before solving.
- Domain candidates are deterministic, independently validated, and checkpointed only when their explained quality score strictly improves.
- Every accepted checkpoint is immutable and monotonically revisioned. A retry/continue starts after the stored solver iteration and retains the prior best.
- Cancellation is polled at most every `SCHEDULER_CANCELLATION_POLL_MS` (maximum 1000 ms) and the domain adapter yields between bounded iterations. Cancel, retry, crash, and dead-letter paths never delete the current best.
- Progress contains only measured iteration, explored-candidate count, checkpoint revision, and current quality score. It does not invent a percentage.

## Run

```sh
export DATABASE_URL='postgres://matchday:matchday@127.0.0.1:5432/matchday'
export REDIS_URL='redis://127.0.0.1:6379'
pnpm --filter @matchday/scheduler build
pnpm --filter @matchday/scheduler start
```

Health endpoints default to `127.0.0.1:4010`:

- `GET /health/live` checks process lifecycle.
- `GET /health/ready` requires the BullMQ worker and PostgreSQL store to be ready.

Configuration: `SCHEDULER_WORKER_ID`, `SCHEDULER_CONCURRENCY` (1–32), `SCHEDULER_MAX_ITERATIONS` (1–256), `SCHEDULER_LEASE_MS` (5000–300000), `SCHEDULER_CANCELLATION_POLL_MS` (10–1000), `SCHEDULER_MAX_YIELD_MS`, `SCHEDULER_SHUTDOWN_TIMEOUT_MS`, `SCHEDULER_HEALTH_HOST`, and `SCHEDULER_HEALTH_PORT`.

## Operations

Alert on readiness failure, queue age/depth, `scheduler.jobs.failed`, `scheduler.jobs.dead_lettered`, lease loss, and cancellation observation latency above the configured bound. Terminal dead letters contain only the queue/job identity and failure class in hooks; the immutable input remains in PostgreSQL under normal retention controls.

Before restarting a dead letter, inspect the PostgreSQL job failure class and retained best. Correct permanent/invalid input rather than replaying it. Do not re-enqueue transient dead letters until the application API implements an authenticated, audited recovery operation; that API integration is outside this isolated worker. Graceful shutdown marks readiness unavailable, stops intake, waits up to the configured timeout for active work, then closes PostgreSQL. A second signal forces exit.

Verification:

```sh
pnpm --filter @matchday/scheduler typecheck
pnpm --filter @matchday/scheduler lint
pnpm --filter @matchday/scheduler test:unit
RUN_INFRA_TESTS=1 pnpm --filter @matchday/scheduler test:integration
pnpm --filter @matchday/scheduler build
```

## Benchmark (Track R3)

`pnpm bench:scheduler` runs the fixtures in `tests/benchmark` as production jobs (64 iterations each, one solver thread, every candidate re-verified) and writes `docs/qa/r3-scheduler-benchmark.md` and `.json`. For each fixture it records job time, score, back-to-backs, minimum and average rest, rest spread, day lengths, court spread and matches moved.

The same suite runs in CI with the scheduler unit tests (`test:unit`; the range fixtures run 4 iterations there) and asserts the Track R3 targets:

- Every feasible fixture yields a valid schedule, so there are no false `no_solution` results. The feasible fixtures are the October QA scenarios and all five sports at 8/12/16/24/48 entries, including multi-day venues, officials and locks.
- Job time: at most 5 s for S1 and at most 15 s for S2 (104 canoe polo matches).
- Back-to-backs: 0 wherever the fixture stores a witness schedule with 0 (S1, S2). More than 0 where the fixture proves 0 is impossible (S4 exact fit).
- Re-planning after a court closes moves exactly the displaced matches.
- Every infeasible fixture returns `no_solution` with a named diagnostic whose message states the fix.
- The format suggestion check stays within 2 s for five formats per request.

The solver strategy behind these numbers is recorded in `docs/decisions/0007-scheduler-solver-strategy.md`.
