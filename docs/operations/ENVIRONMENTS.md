# Environment contract

All runtime configuration is parsed by `@matchday/config`; application modules must not read unvalidated environment variables directly. Secrets are injected at runtime and must never be committed.

| Environment  | Purpose                                  | Data and dependency contract                                                                                                            |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `local`      | Developer workstation                    | Loopback-only Postgres, Redis, Mailpit, API, and web origins. Checked-in values are non-secret local defaults.                          |
| `test`       | Unit, integration, CI, and disposable QA | Isolated schemas/databases and deterministic factories. External providers use test adapters or local emulators.                        |
| `staging`    | Production-like release verification     | Separate accounts, databases, queues, buckets, identity tenant, sending domain, and observability project. No production personal data. |
| `production` | Live service                             | Explicit database, Redis, deep-health token, and HTTPS CORS origins are mandatory. Secrets come from the deployment secret store.       |

## Required variables

| Key                                                       | Rule                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_ENV`                                                 | One of `local`, `test`, `staging`, `production`.                                                                                                 |
| `API_HOST` / `API_PORT`                                   | Bind address and port; ingress owns public TLS.                                                                                                  |
| `API_ALLOWED_ORIGINS`                                     | Comma-separated exact origins. Wildcards are forbidden; production origins must use HTTPS.                                                       |
| `API_TRUSTED_PROXIES`                                     | Optional comma-separated ingress IP/CIDR allowlist. Empty is safest; unrestricted ranges are forbidden.                                          |
| `MATCHDAY_API_BASE_URL`                                   | Server-only API origin used by web BFF routes. Use the deployment's intended API/web topology and never expose credentials in the URL.           |
| `MATCHDAY_PUBLIC_ORIGIN`                                  | Exact browser-facing CSRF authority for credentialed web mutations. Required for every non-loopback deployment and HTTPS outside local loopback. |
| `DATABASE_URL`                                            | PostgreSQL connection URL. Explicit in production and redacted from diagnostics.                                                                 |
| `REDIS_URL`                                               | Redis connection URL for cache, rate limiting, queue, and coordination. Explicit in production.                                                  |
| `SCORING_ACCESS_FALLBACK_CODE_HMAC_SECRET`                | Independent 32+ byte fallback-code HMAC primary used for single-key `v1` compatibility.                                                          |
| `SCORING_ACCESS_FALLBACK_CODE_HMAC_KEYRING`               | Optional secret-store JSON keyring for overlap rotation. New codes use `primary`; retained codes may use `verificationOnly`.                     |
| `LOG_LEVEL`                                               | Structured logger threshold; use `silent` only in deterministic tests.                                                                           |
| `DEEP_HEALTH_TOKEN`                                       | At least 32 characters and explicit in production. The deployment must additionally keep `/health/deep` on private ingress.                      |
| `IDENTITY_CSRF_HMAC_SECRET`                               | Independent secret of at least 32 characters outside local/test; never browser-visible.                                                          |
| `IDENTITY_PROVIDER`                                       | `disabled` only in local/test; staging and production require `oidc`.                                                                            |
| `IDENTITY_OIDC_ISSUER`                                    | Exact OIDC issuer string from discovery metadata. HTTPS outside local/test.                                                                      |
| `IDENTITY_OIDC_CLIENT_ID` / `IDENTITY_OIDC_CLIENT_SECRET` | Confidential OIDC client registration. The secret comes only from the runtime secret store.                                                      |
| `IDENTITY_OIDC_CALLBACK_URI`                              | Exact registered API callback ending `/api/v1/identity/callback`; HTTPS outside local/test.                                                      |
| `IDENTITY_FLOW_SEAL_KEY`                                  | Base64url encoding of exactly 32 random bytes, separate from the CSRF and OIDC client secrets.                                                   |
| `IDENTITY_PROVIDER_EVENT_HMAC_SECRET`                     | Dedicated 32+ byte server-only key shared only with the narrow signed provider-event bridge.                                                     |
| `IDENTITY_COOKIE_SITE`                                    | Scheme plus registrable-domain boundary shared by every credentialed frontend origin, callback, and post-auth destination.                       |
| `IDENTITY_POST_AUTH_REDIRECT_URIS`                        | Comma-separated exact application destinations. Origin-wide or wildcard redirects are not supported.                                             |
| `IDENTITY_RECOVERY_MODE`                                  | Provider-hosted recovery initiated through the server-owned OIDC authorization flow. OIDC itself has no reset API.                               |
| `EDGE_CACHE_PURGE_ENDPOINT`                               | Exact provider-neutral HTTPS purge endpoint. Required by staging/production workers; embedded credentials, query, and fragments are forbidden.   |
| `EDGE_CACHE_PURGE_BEARER_TOKEN`                           | Worker-only purge credential of at least 32 bytes. Required by staging/production workers, secret-store injected, and never logged.              |

## Separation and promotion

- No staging or production resource may share credentials, data stores, queues, buckets, identity tenants, or webhook secrets.
- Staging and production use different OIDC tenants/client registrations, callback URIs, client secrets, and flow-seal keys.
- Non-loopback web deployments must set `MATCHDAY_PUBLIC_ORIGIN`; organiser mutations fail closed rather than trusting forwarded host/protocol as the CSRF authority.
- Fallback-code HMAC keyring material must be distinct from rate-limit, identity, cookie, and scoring-session secrets. Old fallback keys remain verification-only until the cutover inventory is fully revoked, expired, or rotated.
- Builds are immutable. Promotion changes environment configuration, not application source.
- Database changes use expand-contract migrations and must pass the clean-schema check before deployment.
- A release may proceed only after config validation, migration compatibility, health checks, backup status, and rollback readiness are recorded.
- Provider-specific variables are added only alongside a typed adapter and validation schema; optional unset integrations must fail closed or use an explicit no-op.

The repository proves local/test behavior and rejects unsafe production configuration. Actual staging/production resources, secret injection, domains, and provider tenants remain deployment evidence rather than local claims.
