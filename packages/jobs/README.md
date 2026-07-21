# `@matchday/jobs`

Redis-backed BullMQ adapter for typed, retry-safe background work.

## Operational contract

- Callers must provide a stable business `idempotencyKey`; it is hashed with the
  job type into the BullMQ job ID.
- Queue-level deduplication lasts only while the BullMQ job record is retained.
  Handlers must also enforce business idempotency at the effect boundary; the
  queue does not promise exactly-once delivery.
- Jobs retry five times with exponential backoff unless explicitly overridden.
- Waiting and delayed jobs are removed on cancellation. Active handlers must
  call `throwIfCancellationRequested()` at safe checkpoints; cancellation then
  calls `discard()` so BullMQ does not retry the job.
- Exhausted jobs are copied to `<queue>.dead-letter`. After that write succeeds,
  `onDeadLettered` emits one payload-free terminal event for metrics and alert
  routing. Operators must also monitor dead-letter depth and use
  `retryDeadLetter()` only after correcting the cause.
- Job payloads may contain personal data. Redis encryption, access controls,
  persistence, retention, and payload minimisation are deployment obligations.

## Registry example

```ts
type Jobs = {
  "email.delivery": JobDefinition<{ deliveryId: string }, { sent: boolean }>;
};
```
