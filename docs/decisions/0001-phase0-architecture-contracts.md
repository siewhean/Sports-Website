# ADR 0001 — Phase 0 Architecture Contracts

**Status:** Provisionally accepted for prototype and foundation design; stakeholder confirmation remains required where noted.

**Date:** 16 July 2026

**Source baseline:** Implementation plan v2.0 (16 July 2026)

## Context

Live scorekeeping, weak connectivity, one-writer authority, immediate public results, and private schedule revisions create consistency requirements that must be fixed before database and API implementation. These contracts refine the source specification without changing its product scope.

The original Phase 0 decision work began against the v1.x plan. This revision is reconciled to v2.0, including its production requirements for caching, versioned APIs, CDN delivery, realtime infrastructure, primary-write routing, observability, privacy consent, notifications, deployment safety, and regional recovery. Those additions do not reverse the contracts below; they make provider selection, qualified durability, public projection versions, and adapter boundaries release-gate dependencies rather than prototype assumptions.

## Decisions

### 1. Versioned REST and transport boundaries

- The authoritative business API is REST/JSON under `/api/v1` with command-style domain actions.
- Mutations use client UUID idempotency keys, request IDs, structured errors, schema validation, and generated OpenAPI/client types.
- SSE publishes public read updates. WebSocket carries scoring-session presence and lease state. Neither creates a second business API.
- Internal modules call typed application services rather than HTTP.

### 2. Scoring authority and fencing

- Each match has one server-authoritative write session and a monotonic `fencing_generation`.
- Acquire, transfer, takeover, revocation, and lease expiry increment the generation atomically.
- Every score mutation includes session ID, device-session ID, fencing generation, client event UUID, client sequence, and expected aggregate version.
- The current fence is checked in the same transaction that appends the event and advances state. A browser tab is never treated as identity.

### 3. Lease lifecycle

- Presence heartbeat defaults to 30 seconds; three missed heartbeats show an unreachable warning.
- Connection presence and offline write authority are separate. A missed heartbeat never appoints a second writer.
- Transfer or takeover is explicit, increments the fence, and records audit evidence.

### 4. Offline replay and transfer conflicts

- IndexedDB events replay idempotently in client sequence for the current fencing generation.
- Duplicates succeed; gaps return the expected sequence.
- Old-generation events after transfer or revocation are never merged automatically.
- Stale events enter an audited conflict inbox. An organiser may discard them with a reason or convert selected facts into new correction events linked to the originals.
- Offline finalisation is `pending_sync`; it never claims result publication before server acceptance.
- Prototype default: up to four hours of offline scoring for an already-opened match. This duration and permitted-action policy still require design-partner approval.

### 5. Public publication versions

- Each competition has separate monotonic result and schedule publication versions.
- Finalisation or correction atomically updates the public result projection, increments its version, writes audit/outbox records, and purges relevant cache entries.
- Private schedule drafts never change the public schedule version. Organiser publication increments it.
- HTTP returns the publication version and ETag. SSE includes stream and version; gaps trigger a confirmed-current HTTP refetch.

### 6. Identity and provider adapters

- Authentication is managed behind an `IdentityProvider` port; the application stores no passwords.
- Unique provider issuer/subject identities map to immutable internal account IDs.
- Provider claims establish identity only. Organisation-, competition-, match-, and object-level authorisation remains domain-owned.
- Identity, payments, email, storage, analytics, monitoring, error tracking, AI, hosting, and solver integrations expose adapter contracts and never leak provider SDK types into domain packages.

### 7. Qualified durability

- Acknowledged writes have RPO 0 for process, host, and availability-zone failure using managed multi-AZ PostgreSQL.
- Full regional disaster target is RPO no more than 15 minutes and RTO under one hour using WAL/PITR and cross-region backups.
- Claims of zero committed-write loss do not apply to full-region loss unless synchronous multi-region quorum storage is selected.
- Restore tests are monthly and full disaster-recovery drills quarterly.

### 8. Privacy by default

- Public projections expose team identity, schedule, results, tables, and brackets by default. Contact data is never public.
- Player/referee names are opt-in per competition. Minor players remain team-only unless the organiser explicitly confirms consent; actor, time, and policy version are audited.
- Essential cookies operate before consent. Analytics and marketing adapters remain disabled until category consent.
- Export, deletion, retention, and consent are backend policies, not UI-only flags.

## Confirmation required before the dependent gate

- Four-hour offline duration, permitted offline actions, expiry behaviour, and transfer reconciliation UX.
- Public player/referee fields, minors, consent evidence, contact visibility, export, deletion, and jurisdiction-specific retention.
- Identity, payment, email, storage, hosting, observability, analytics, error-tracking, monitoring, and solver providers.
- Single-region multi-AZ versus multi-region availability and the accepted regional RPO.
- Administrator MFA, organiser high-risk-action MFA, and audited break-glass access.
- Event Pass/Pro prices, legal entity, currency, product name, domain, support identity, and launch jurisdictions.
- Expected peak active competitions, scoring devices, spectators, browser/device floor, and event-day support model.

## Consequences

- Stale offline score events require explicit reconciliation instead of last-write-wins.
- Public result freshness can be proven independently of CDN TTL or replica lag.
- Provider selection can change without rewriting deterministic domain code.
- The product cannot claim the Phase 0, pilot, or production gate until the corresponding confirmations and external evidence exist.
