# Gate F — public paid release preparation and QC contract

**Status:** PREPARED / BLOCKED

**Dependency chain:** Gate E independent `PASS` → commercial/legal/operational closure → production simulation → Gate F.

This commit is preparation only. It must be rebased onto the exact Gate E-certified source before any production-release decision.

## 1. Gate contract

Gate F is the first public paid release. It owns `OPS-001–018` and depends on the Phase 6 commercial and administrative scope required for a real paid product.

The minimum product and operational contract includes:

- Event Pass and AI top-ups;
- an idempotent billing ledger, webhook replay protection and reconciliation;
- security and accessibility review;
- current backup/restore evidence;
- monitoring, alerting and support operations;
- a zero-downtime deployment pipeline with automatic rollback;
- an operational status page and SLO dashboards;
- published Terms of Service, Privacy Policy and Cookie Policy;
- a verified cookie-consent mechanism;
- confirmed email deliverability;
- validated public-page SEO metadata;
- CDN configuration and cache-purge proof;
- a completed disaster-recovery drill;
- an incident-response runbook reviewed by the on-call team;
- a separate independent QA/QC `PASS` tied to the exact production candidate SHA.

Gate F is not passed by a successful application build or a preview deployment. It requires production-like provider, deployment, recovery, security, legal, billing and support evidence.

## 2. Current repository readiness audit

| Area | Existing foundation | Gate F gap |
| --- | --- | --- |
| Source quality | Pinned Node/pnpm, monorepo checks, migrations, unit/integration/browser commands and secret/dependency scans exist | Hosted CI execution and required-check enforcement are not currently dependable |
| Application architecture | Modular web/API/worker/packages structure with PostgreSQL, Redis, audit/outbox and health foundations | Production topology, isolation, autoscaling, draining and provider configuration are not proven |
| Deployment artifacts | Production build, deployment manifest and asset-origin verification exist | No exact-SHA staged promotion, zero-downtime rollout, automatic rollback or production smoke receipt |
| Database | Forward migrations, local migration checks and backup/restore verification exist | Managed production database, previous-version compatibility, read replica, WAL/cross-region backup and measured RTO/RPO are absent |
| Cache/queue | Redis/BullMQ foundations and cleanup oracles exist | Managed persistence, failover, queue dead-letter operations, capacity and recovery evidence are absent |
| Public delivery | Content hashing, image/build checks, public projections and cache-aware design foundations exist | CDN provider, purge-on-publication, ETag/freshness, stale-score prevention and geographic delivery evidence are absent |
| Security | Scoped access tokens, writer fencing, BFF same-origin checks, headers, RBAC/object checks and secret scans exist | Independent penetration test, production key rotation, WAF/rate-limit proof, admin MFA/break-glass and provider hardening are absent |
| Observability | Structured logging/metrics/tracing packages and health endpoints exist | Hosted logs, traces, error tracking, SLO dashboards, synthetic probes, alert routes and retention/PII-scrubbing evidence are absent |
| Billing | Configuration and AI accounting foundations exist | Event Pass, AI top-up purchase, immutable ledger, webhooks, refunds, receipts, tax/legal entity and reconciliation are not complete |
| Email | Notification and Mailpit foundations exist | Sending domain, SPF/DKIM/DMARC, bounce/complaint handling and client rendering evidence are absent |
| Legal/privacy | Policy structure and consent foundations exist | Final jurisdiction-specific legal review, published pages, retention/deletion implementation and DPA readiness are absent |
| SEO/marketing | Marketing/public page foundations exist | Final metadata, JSON-LD, sitemap, robots, social preview and crawlability audit are absent |
| Operations/support | Backup/security/environment documents exist | Staffed on-call, support ownership, status/incident communications, deployment freeze and release authority are absent |

## 3. Commercial and administrative closure

Before the Gate F production candidate is frozen, complete the Phase 6 scope required by the release contract.

### Billing and entitlements

- Define configuration for free, Event Pass, Organiser Pro and AI top-up products without embedding prices in domain logic.
- Implement a double-entry or equivalently reconcilable immutable billing/usage ledger.
- Use provider event IDs and idempotency keys to make webhook replay harmless.
- Separate provider payment status from internal entitlement state and record every transition.
- Implement failed, cancelled, refunded, disputed and manually adjusted states.
- Reconcile provider transactions, ledger entries and entitlements on a scheduled basis.
- Preserve manual competition operation when AI allowance or paid AI credit is exhausted.
- Generate receipts and a customer-visible billing history.
- Add support-safe adjustment tools with audit, approval and reason requirements.

Required tests include duplicate webhook delivery, out-of-order events, delayed payment confirmation, refund after use, provider outage, reconciliation mismatch, entitlement expiry/grace period, currency precision and cross-tenant denial.

### Export, support and privacy

- Complete published schedule, score-sheet, table, bracket, CSV, audit and full-competition JSON exports required by the product tier.
- Build read-only support lookup and audit investigation before any mutating support tool.
- Require scoped elevated authorization, reason and audit for every support mutation.
- Implement account/data deletion and retention jobs with legal-hold capability where required.
- Confirm public/minor/referee visibility and organiser consent controls.
- Publish and version legal pages and record acceptance where required.

### AI operations

- Track prompt/template/model versions, action outcome, latency and cost without retaining unnecessary sensitive source text.
- Enforce schema/business validation and deterministic acceptance of AI proposals.
- Add per-product quotas, cost alarms and provider failover/manual fallback.
- Prove cached and failed actions are not charged.

## 4. Production environment architecture

Provision physically or logically isolated environments:

- local;
- automated test;
- staging;
- production.

Production requirements:

- managed secret storage and short-lived deployment credentials;
- dedicated database, Redis/cache and object storage;
- least-privilege service identities;
- separate provider keys and webhook endpoints;
- infrastructure-as-code or an equivalently reviewable declarative configuration;
- immutable deployment artifact referenced by source SHA and build provenance;
- environment-drift detection;
- no production-enabled demo fixtures or test identities;
- restricted deep health endpoints and public liveness/readiness boundaries;
- documented regions, data residency, availability tier and disaster RPO/RTO.

The production candidate must be promoted from the same tested artifact. A rebuild during promotion invalidates the staging evidence unless reproducible-build identity is proven.

## 5. Deployment and migration pipeline (`OPS-001–003`, `OPS-013`, `OPS-015`, `OPS-018`)

Required pipeline:

1. exact-SHA checkout;
2. frozen dependency install and supply-chain verification;
3. full format/lint/type/unit/integration/migration/security/build/browser ledger;
4. build provenance and deployment manifest generation;
5. deploy immutable artifact to staging;
6. staging database expand migration;
7. authenticated smoke, synthetic, visual/accessibility and key event-operation tests;
8. backup checkpoint and rollback-readiness verification;
9. approval by release authority outside an active competition freeze window;
10. blue-green, canary or rolling production rollout;
11. readiness and error/latency guard evaluation;
12. automatic rollback on failed guard;
13. explicit promotion completion and public/cache smoke;
14. post-deploy migration/contract cleanup only in a later independently safe release.

Migration rules:

- expand before application rollout;
- preserve compatibility with the previous application version;
- backfill in bounded, observable, retryable jobs;
- no destructive rename/drop in the same release as code migration;
- test both old-app/new-schema and new-app/expanded-schema combinations;
- record lock duration, row count, query plan and rollback boundary for high-risk changes.

Feature flags must support a fail-closed kill switch for scoring, AI, billing and risky public features without requiring an emergency deploy.

## 6. Availability, cache and data operations (`OPS-004–012`, `OPS-014`, `OPS-016`)

### Monitoring and SLOs

Create dashboards and alerts for:

- availability and request error rate by surface;
- API/public/scoring latency percentiles;
- finalisation-to-public freshness;
- active and stale scoring leases;
- offline replay conflict/failure rate;
- queue depth, age, retries and dead letters;
- database connections, locks, replication lag and storage;
- Redis memory, persistence, evictions and failover;
- CDN cache hit/miss, purge delay and stale-version responses;
- deployment health and rollback events;
- backup success/age and restore verification;
- email delivery/bounce/complaint rates;
- billing webhook lag and reconciliation mismatch;
- AI cost, latency, quota and failure rate;
- security/rate-limit/WAF events;
- infrastructure cost and unexpected growth.

Every alert needs threshold, owner, escalation path, runbook link, test receipt and expected acknowledgement time. Synthetic probes must validate public pages, authentication boundaries, scoring access and confirmed-current publication behavior from outside the hosting environment.

### Backup and disaster recovery

- Automated encrypted backups and point-in-time recovery.
- Cross-region or independently isolated copies matching the approved RPO.
- Regular restore into an isolated environment.
- Consistency oracles for accounts, competitions, schedules, events, results, publications, audit and outbox.
- Timed RTO measurement and operator sign-off.
- Redis/queue recovery policy that cannot duplicate authoritative mutations.
- Object/PDF export recovery where these are durable customer records.
- Full regional/provider failure drill, DNS/traffic shift and customer communication exercise.

Do not claim both “no committed-write loss” and a nonzero disaster RPO without qualifying which failure modes each promise covers.

### CDN and public truth

- Content-hashed immutable static assets.
- Short/appropriate TTL for dynamic competition pages.
- Purge or tag invalidation on schedule/result publication.
- Monotonic schedule/result versions in responses.
- Confirmed-current origin fallback when cache/replica version is behind the client’s expected version.
- ETag/conditional request validation.
- Tests proving unpublished revisions and stale corrected results cannot leak.

## 7. Security release review

Complete an independent review and penetration test covering:

- authentication, recovery, session expiry and administrator MFA;
- object/tenant authorization and IDOR;
- scoring pass entropy, enumeration, lease transfer, replay and revocation;
- offline event manipulation and stale-generation fencing;
- billing webhooks, entitlement bypass and refund abuse;
- support/admin privilege and audited break-glass access;
- XSS, CSP, CSRF/same-origin BFF handling, SSRF, injection and file/PDF export;
- rate limiting, WAF/bot behavior and denial of service;
- secret/key storage, rotation and incident revocation;
- dependency, build provenance and deployment identity;
- logs, traces, analytics and error payloads for PII/secret leakage;
- backup encryption and restore authorization;
- public privacy and minor data controls.

Release requires zero unresolved critical/high findings. Lower findings require explicit risk acceptance, owner, due date and compensating control; they cannot contradict the Gate F release contract.

## 8. Accessibility, SEO, email and legal release review

### Accessibility

- WCAG 2.2 AA review across organiser, scoring, public, billing, support and legal surfaces.
- Keyboard, screen reader, 400% reflow, focus, status/error announcements, target size, contrast and reduced motion.
- Real Mobile Safari and Chrome Android checks.
- Accessible PDF/fallback review where feasible.

### SEO

- Unique canonical title/description and shareable deep links.
- Open Graph/social image verification.
- Valid event/organisation JSON-LD without private data.
- Sitemap and robots behavior.
- Crawlability/indexability rules for public versus private/archived content.
- Error/status handling that does not index private or transient pages.

### Email

- Verified sending domain with SPF, DKIM and DMARC alignment.
- Bounce/complaint/suppression processing.
- Password/access/conflict/billing/support templates tested across major clients.
- Idempotent delivery and retry/dead-letter behavior.
- No access secrets in analytics or inappropriate notification channels.

### Legal/privacy

- Final Terms, Privacy and Cookie policies published and linked.
- Consent categories and withdrawal verified.
- Retention/deletion jobs tested.
- Data processing terms for target jurisdictions.
- Legal entity, currency, tax/receipt obligations and support contact finalized.
- Independent legal review receipt current for the release scope.

## 9. Production simulation

Run an isolated staging production simulation using the exact candidate artifact.

Mandatory drills:

1. normal deployment with uninterrupted organiser/public/scoring traffic;
2. failed readiness check and automatic rollback;
3. incompatible/high-risk migration blocked before production;
4. application rollback while expanded schema remains;
5. database restore and consistency verification;
6. database/region failover;
7. Redis interruption and queue recovery;
8. CDN stale-score purge and confirmed-current fallback;
9. expired certificate/DNS alert simulation;
10. scoring/public SLO breach alert and on-call acknowledgement;
11. billing provider outage/webhook backlog/reconciliation;
12. email delivery failure and support fallback;
13. secret/key revocation;
14. status-page and incident communication exercise;
15. deployment-freeze enforcement during a simulated active competition.

Record exact start/end time, candidate SHA, artifact digest, environment, operator, alerts, rollback/restore durations and final state. Partial or manually stopped drills are failures.

## 10. Exact-SHA Gate F evidence

Publish an immutable evidence bundle tied to the exact production candidate and promoted artifact.

Required contents:

- source SHA, artifact digest and build provenance;
- clean-tree and dependency lock proof;
- complete command/test ledger with zero unexpected skip;
- staging and production deployment IDs;
- migration compatibility and timing records;
- rollout, readiness and automatic rollback receipts;
- SLO dashboards and baseline window;
- synthetic probes and alert-routing receipts;
- backup, restore, failover and disaster-recovery report;
- CDN configuration, purge and freshness evidence;
- billing/entitlement reconciliation and provider-test receipts;
- security/penetration report and finding closure;
- accessibility, SEO, email and legal review receipts;
- status/support/on-call and incident-runbook attestations;
- production configuration redaction review;
- independent QA/QC report containing exact reviewed SHA, artifact digest, `P0: 0`, `P1: 0` and final verdict.

Do not include credentials, private keys, full connection strings, session cookies, access tokens, customer personal data or unredacted provider payloads.

## 11. Go/no-go checklist

- [ ] Gates B, C, D and E have independent exact-SHA `PASS` records.
- [ ] Phase 6 commercial/admin/export/privacy scope required for release is complete.
- [ ] Production environment is isolated and declaratively configured.
- [ ] Same tested artifact is promoted to production.
- [ ] Full automated/security/accessibility/visual ledger passes with no unexpected skip.
- [ ] Expand-contract migration and previous-version compatibility pass.
- [ ] Zero-downtime rollout and automatic rollback pass.
- [ ] Backups, restore, failover and disaster-recovery drill pass within approved objectives.
- [ ] Monitoring, SLO dashboards, synthetics and alert routing are live and tested.
- [ ] CDN purge and confirmed-current public truth pass.
- [ ] Billing, webhook replay and reconciliation pass.
- [ ] Status page, support process, on-call rota, incident and freeze runbooks are active.
- [ ] Security/penetration critical and high findings are zero.
- [ ] Accessibility, SEO, email and legal reviews are current.
- [ ] SSL/DNS, key rotation and provider credentials are production-ready.
- [ ] Independent review matches the exact candidate SHA and artifact digest.
- [ ] `P0: 0` and `P1: 0`.

## 12. Gate F QC verdict

**Verdict: BLOCKED**

The repository has meaningful application, local validation and architectural foundations, but no source-only change can certify Gate F. The gate remains blocked by prior-gate completion, commercial/billing implementation, managed production infrastructure, hosted CI/deployment evidence, penetration/legal/accessibility/email/SEO reviews, on-call/support operations, CDN freshness, backup/failover/DR drills and a production simulation tied to the exact promoted artifact.
