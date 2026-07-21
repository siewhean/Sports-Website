# Phase 1 — Production foundation acceptance

**Date:** 17 July 2026

**Scope:** FND-001 through FND-028 and the reusable design-system foundation.

## Requirement traceability

| Requirement | Local implementation evidence                                                                                                                                                | Status                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| FND-001     | pnpm/Turborepo workspace; web, API, worker, shared packages, and local infrastructure                                                                                        | Verified locally                                          |
| FND-002     | Prettier, ESLint, TypeScript, Vitest, Playwright, Gitleaks, and a pre-commit hook                                                                                            | Verified locally                                          |
| FND-003     | `.github/workflows/ci.yml` runs static, test, migration, backup, build, browser, and secret gates; a clean-copy guard rejects generated outputs                              | Workflow and clean-copy path verified; hosted run pending |
| FND-004     | Typed local/test/staging/production contract and production-safe validation                                                                                                  | Contract verified; hosted resources pending               |
| FND-005     | Generic OIDC code/PKCE/state/nonce flow, account linking, opaque sessions, signed replay-safe provider revocation, hosted recovery, profile, CSRF, and fail-closed bootstrap | Local protocol verified; live tenant pending              |
| FND-006     | Organisations and memberships with database-enforced active-owner invariant and concurrency tests                                                                            | Verified locally                                          |
| FND-007     | Organiser, official, public, and platform-admin authorization primitives                                                                                                     | Verified locally                                          |
| FND-008     | Ordered, idempotent, advisory-locked migration runner and clean-schema check                                                                                                 | Verified locally                                          |
| FND-009     | Transactional audit writer/viewer and append-only database enforcement                                                                                                       | Verified locally                                          |
| FND-010     | Redacted structured logging, correlation, and fail-open error-reporter port                                                                                                  | Core verified; hosted tracker pending                     |
| FND-011     | OpenTelemetry traces/metrics and request context                                                                                                                             | SDK verified; live collector receipt pending              |
| FND-012     | Typed BullMQ registry, retries, idempotency, cancellation, dead letters, payload-free terminal-failure signals, and graceful worker lifecycle                                | Verified against Redis                                    |
| FND-013     | Typed persistent flags with scoped overrides and transactional audit                                                                                                         | Verified against PostgreSQL                               |
| FND-014     | Deterministic account, organisation, and membership factories                                                                                                                | Verified locally                                          |
| FND-015     | Backup/restore runbook and deterministic restore verification                                                                                                                | Local restore verified; managed retention/region pending  |
| FND-016     | Live, ready, and token-protected deep health endpoints with degraded-state coverage                                                                                          | Verified locally                                          |
| FND-017     | Exact-origin CORS with wildcard and unsafe production config rejection                                                                                                       | Verified locally                                          |
| FND-018     | API Helmet policy and nonce-based web CSP with frame, content, referrer, and permissions controls                                                                            | Verified in API runtime and browser                       |
| FND-019     | Redis-backed anonymous IP and validated-account rate limits with standard headers                                                                                            | Verified across API instances                             |
| FND-020     | Structured error envelope containing code, message, and request ID                                                                                                           | Verified locally                                          |
| FND-021     | Generated/accepted request IDs propagated through logs, responses, audit, jobs, and telemetry                                                                                | Verified locally                                          |
| FND-022     | Transactional email templates, outbox fencing, idempotency, retry, and exact-one-recipient delivery                                                                          | Verified with Mailpit                                     |
| FND-023     | In-app store, channel preferences, outbox, and delivery invariants                                                                                                           | Verified locally                                          |
| FND-024     | Content-hashed Next.js assets, AVIF/WebP negotiation, private-safe service worker, build-bound digest manifest/origin verifier, and durable observable edge-purge contract   | Origin controls verified; deployed CDN evidence pending   |
| FND-025     | `/api/v1` prefix and explicit version negotiation                                                                                                                            | Verified locally                                          |
| FND-026     | Granular persisted consent that gates every optional adapter                                                                                                                 | Verified in Playwright                                    |
| FND-027     | Route-derived OpenAPI generation and drift check                                                                                                                             | Verified locally                                          |
| FND-028     | Typed `en-SG`, `en-XA`, and `ar` catalogues plus AST drift gate over route/component sinks                                                                                   | 404 messages; 23/23 fixtures; 0 findings                  |

## Automated evidence

All commands used Node `24.18.0` and pnpm `10.33.0`.

| Gate                    | Result                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Frozen install          | PASS; output-free clean copy installed offline from the frozen lockfile                                                |
| Format                  | PASS                                                                                                                   |
| Lint and i18n audit     | PASS; 31 files, 404 registered prototype messages, 23/23 audit fixtures, 0 findings                                    |
| Typecheck               | PASS; 14 workspaces                                                                                                    |
| Unit tests              | PASS; 21 Turbo tasks including required upstream builds                                                                |
| Integration tests       | PASS; 15 Turbo tasks; API 28/28 and worker 4/4                                                                         |
| Clean-schema migrations | PASS; five migrations, repeat run empty                                                                                |
| Backup/restore          | PASS; restored deterministic account fingerprint                                                                       |
| Canonical fixtures      | PASS; five competitions and 15 format oracles                                                                          |
| OpenAPI drift           | PASS                                                                                                                   |
| Dependency audit        | PASS; production graph has no known vulnerabilities at the moderate blocking threshold                                 |
| Secret scan             | PASS; no leaks                                                                                                         |
| Build                   | PASS; 14 workspaces and production Next.js route table                                                                 |
| Asset origin contract   | PASS; build ID plus size/SHA-256 for every manifest asset, gzip, ETag/304, private routes, service worker, and headers |
| Browser E2E             | PASS; 32/32                                                                                                            |
| Accessibility           | PASS; 11/11 serious/critical axe checks                                                                                |
| Visual regression       | PASS; desktop, tablet, and phone baselines                                                                             |
| Compose validation      | PASS                                                                                                                   |
| Whitespace validation   | PASS                                                                                                                   |

Visual baselines:

- `apps/web/tests/foundation.spec.ts-snapshots/home-desktop-chromium-darwin.png`
- `apps/web/tests/foundation.spec.ts-snapshots/organiser-tablet-chromium-darwin.png`
- `apps/web/tests/foundation.spec.ts-snapshots/public-phone-chromium-darwin.png`

## Runtime evidence

- Built API started on `127.0.0.1:4000`; `/health/live` returned `200` with security headers and a request ID.
- Deterministic discovery/JWKS/token fixtures passed the full OIDC callback; transient provider timeout returned fail-closed `503` and cleared the flow cookie. Signed issuer/subject and issuer/`sid` events transactionally revoked mapped sessions with replay fencing and audit evidence. Default local mode still returns `503 IDENTITY_PROVIDER_UNAVAILABLE` and issues no session.
- A production build was bound to its manifest build ID; every served manifest asset matched its byte size and SHA-256. Playwright proved private documents and mutable images stay out of Cache Storage, the embedded offline fallback is `503 private, no-store`, and Next serves genuine AVIF and WebP responses.
- Built worker reached `ready`, handled `SIGINT`, transitioned through `stopping` to `stopped`, and exited `0`.
- Local PostgreSQL, Redis, and Mailpit evidence is green. OpenTelemetry SDK export is covered with in-memory exporters; Docker did not provide a reliable newly-created Collector runtime during this pass.

## External release evidence still required

The local engineering surface does not prove a hosted CI run, isolated staging/production resources, a selected and configured live OIDC tenant, a hosted error tracker/collector, managed backup retention or regional restore, or real CDN cache and purge behavior. These require provider decisions and credentials from Phase 0. They must not be inferred from local adapters or runbooks.
