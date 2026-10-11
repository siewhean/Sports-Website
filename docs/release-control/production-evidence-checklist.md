# Production evidence checklist

Source baseline `e8e0761c259f9857d9c459785fda0bfb01d50797`; observations dated 11 October 2026. Status: `GATE_F_PRODUCTION_CERTIFICATION=NOT_VERIFIED`.

| Evidence class      | Verified observation                                                                                                                                             | Limit                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Source              | Main and merged PR71/72/82/83/84/88/92/93                                                                                                                        | Later candidates need independent review                                         |
| Hosted CI           | Baseline run38117670424; both browser shards, GateD, five image jobs                                                                                             | Does not prove deployment                                                        |
| Published images    | api/web/worker/migrate/backup ARM64 manifests, revision and SLSA bindings                                                                                        | Does not prove running containers                                                |
| Vercel routing      | Alias API binds v1-preview.poladex.shop and sports-website-web.vercel.app to READY dpl_CmCo2cPCgGmsw2XnZACp2RbGrocL, SHA8f38feb0bb2c91a552033f013148568cae1b944b | Latest main attempt dpl_2FfmbwqwJEjHUYf7CLiAZd8RnyDD canceled/ignored-build      |
| Public API          | HTTP200 metadata reports8f38feb0bb2c91a552033f013148568cae1b944b and production; readiness healthy at observation                                                | Does not prove OCI host/container/image/web/worker identity or persistent health |
| Production recovery | PR88 restore claim exists                                                                                                                                        | No independently retained authenticated drill receipt verified                   |
| Operator / legal    | No new approvals or exercises performed                                                                                                                          | ADR0005 dispositions remain pending/deferred/waived                              |

Retain sanitized originals with UTC observation time, observer, authorization, exact candidate/deployed SHA, tree, commands, exit codes, provider identities, immutable artifact IDs and SHA-256 digests. Hashes prove retained-byte integrity, not authenticity. Never retain secrets, raw production row data or full Docker environment inspection.

Before Gate F production certification, obtain independently reviewed receipts for every gap in [OPS inventory](gate-f-gap-ledger.md): serving container revisions and image digests, migration ledger/compatibility, freeze and rollback, real backup schedule/upload/retention and isolated recovery, measured RPO/RTO and binding DR standards, dashboards/alerts/status/logs/probes/costs, cache purge, DNS/TLS, email and feature-flag controls. Provider acknowledgements are not replaceable by test fixtures. All receipts must bind the exact approved candidate and satisfy their actual validator contracts.

New combined candidate: head/tree/CI/artifact/security review and unresolved review threads are `PENDING` until produced. Historical PR69 run37813618555 and main evidence must not be reused to certify it.
