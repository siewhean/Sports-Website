# `@matchday/feature-flags`

Typed feature-flag registry and storage-port-driven evaluator.

Evaluation precedence is account, competition, organization, global, then the
typed registry default. Invalid overrides are ignored and reported in the
evaluation result. Storage failures fail safely to the registry default and can
be sent to observability through `onStorageError`.

`InMemoryFeatureFlagStorage` is intended for tests and local prototypes. A
production adapter must persist overrides, authorise writes, record audit events,
and invalidate any cache after an administrative change.

`PostgresFeatureFlagStorage` is the production persistence adapter. It validates
keys and values against the registry and requires a write-context provider for
actor, request ID, and reason. Its query port must preserve one PostgreSQL
transaction for the override mutation and immutable audit event.
