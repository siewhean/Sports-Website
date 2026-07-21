# Notifications foundation

Vendor-neutral application services for Phase 1 FND-022/FND-023:

- account-scoped in-app notifications, read/read-all, and per-type preferences;
- a hard invariant that every queued email references an existing in-app notification;
- versioned, deterministic transactional email templates;
- idempotent email outbox, leased claims, exponential retry, and dead-letter classification;
- SMTP provider port and an adapter compatible with an injected Mailpit/nodemailer-style transport;
- per-account/type rate limiting to bound notification storms.

Durable infrastructure adapters in this package include:

- `PostgresNotificationRepository`, which implements notification/preferences persistence, a transactional
  email-and-in-app unit of work, and fenced `FOR UPDATE SKIP LOCKED` outbox claims;
- `RedisNotificationRateLimiter`, which uses one atomic Lua sliding-window operation shared across workers;
- `createNodemailerSmtpEmailProvider`, which creates the concrete SMTP transport used by local Mailpit and
  production SMTP composition.

Production composition must still provide environment configuration, connection lifecycle management, and
operational bounce/deliverability handling. `MAILPIT_SMTP_DEFAULTS` is local-only configuration.

The SMTP boundary is at-least-once. Queue idempotency and lease fencing prevent duplicate durable state,
but an SMTP transport cannot guarantee exactly-once delivery if a worker loses its lease after the remote
server accepts a message. A production provider should honor the supplied idempotency key where supported.
