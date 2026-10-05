# Worker shutdown and email acknowledgement

This is source-side G3.1B behavior. It does not authorize a production rollout, and it does not provide exactly-once email delivery.

## Delivery and recovery

An outbox item starts pending. A database claim atomically locks eligible rows with `FOR UPDATE SKIP LOCKED`, then records processing state, a lease token and expiry before any send begins. Enqueue idempotency prevents duplicate outbox rows for one application idempotency key.

The provider must return a receipt with at least one accepted recipient before `markDelivered` runs. Delivery is recorded only after that database update succeeds. Both delivery and failure updates require the current processing state and exact lease token; an expired lease reclaimed by another worker fences the former owner out.

Provider rejection follows the existing classification, attempt limits and retry/dead-letter policy. Once the provider accepts a message, a database acknowledgement failure must never be classified as a provider rejection or call `markFailed`. The item remains processing with its durable lease. A failed in-flight batch during shutdown produces a nonzero application result; ordinary polling still reports failures and schedules subsequent polls.

The ambiguous window is provider acceptance followed by a crash or database failure before acknowledgement persists. Lease expiry permits a new claim and another send. The SMTP idempotency header is not evidence of provider-enforced deduplication. Forced shutdown can increase how often this existing crash window occurs compared with waiting indefinitely, but it does not introduce a separate release/requeue mechanism or bypass lease fencing. An SMTP timeout can also leave remote acceptance uncertain. Exactly-once delivery is not guaranteed.

The default lease is 60 seconds. A multi-item batch can outlive that lease, as in the existing architecture; no sum of transport limits or shutdown deadline proves that all claimed messages finish within their leases. This change does not renew, shorten or clear leases to finish shutdown.

## Timeout hierarchy

| Operation                                | Default bound    | Meaning                                                                |
| ---------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| SMTP DNS                                 | 10 seconds       | Client resolver timeout                                                |
| SMTP connection                          | 10 seconds       | Connection establishment timeout                                       |
| SMTP greeting                            | 10 seconds       | Initial server greeting timeout                                        |
| SMTP socket                              | 15 seconds       | Inactivity timeout, not an absolute send deadline                      |
| Email database connection                | 5 seconds        | Client connection timeout                                              |
| Email database statement                 | 10 seconds       | Server statement execution/lock-wait timeout, not network or pool wait |
| Email database close                     | 5 seconds        | Client closes overdue connections                                      |
| Queue drain                              | 30 seconds       | Existing worker runtime drain bound                                    |
| Telemetry flush                          | 5 seconds        | Shared runtime best-effort wait                                        |
| Telemetry shutdown                       | Up to 10 seconds | Internal flush and provider shutdown waits, each 5 seconds             |
| Whole process after signal               | 60 seconds       | Final watchdog; failure exit, not successful cancellation              |
| Declarative production worker stop grace | 70 seconds       | Exceeds the process deadline; source configuration only                |

Transport and statement timeouts are supported by the actual clients. They are not fabricated cancellation signals or complete end-to-end delivery bounds. Defaults reduce stalled-operation waits; a normally accepted and acknowledged message follows the same delivery state machine. Slow or unresponsive services can now produce ordinary timeout failures sooner, with the existing classification/retry behavior. No new environment configuration or secret is required.

## Signal lifecycle

SIGTERM and SIGINT share one shutdown operation, including during startup. Shutdown prevents new email polling before draining queue work, waits for in-flight background email work, closes its database handles, flushes telemetry, shuts telemetry down, flushes the logger and exits. A normal exit requires successful application draining and acknowledgement of the current batch. Telemetry exporter outages remain best effort and do not change a successful application result.

The 60-second watchdog is the final safety boundary for a stalled startup, claim, send, acknowledgement or close. Its expiry emits a generic diagnostic, flushes the logger best effort and exits nonzero. It does not manufacture delivery success, mark an accepted message failed, release a lease or return graceful success while a side effect remains unresolved. Actual process termination ends local work; lease expiry and the existing crash-recovery policy govern unresolved rows. Observer/logger failures must not disable that boundary.

Timing assumes the Node.js event loop is able to run; an operating-system freeze or synchronous event-loop block requires the orchestrator's independent termination boundary. Production certification must separately verify the deployed grace period and signal delivery. Future production Compose commands must continue to load `--env-file infra/oci/.env.prod` explicitly. No production connection or deployment is part of this source checkpoint.
