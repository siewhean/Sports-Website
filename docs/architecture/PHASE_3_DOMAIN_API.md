# Phase 3 domain and API boundary

**Status:** Implementation contract for Gate A

## Boundary

Phase 3 extends the Phase 2 vertical slice without replacing its published schedule, scoring-access, or event-ledger paths. The pure domain package owns validation, deterministic calculations, immutable commands, and sport-pack definitions. PostgreSQL owns durable identities, tenancy, revision uniqueness, append-only evidence, and publish-time guardrails. Fastify owns authenticated orchestration, transactions, idempotency, and secret-free response models.

The manual and drag-and-drop format builders remain Phase 4. Phase 3 may expose validated graph and recommendation contracts, but it must not claim those builder tasks.

## Persistence model

- Expand `competitions` to all five sport codes, location fields, lifecycle timestamps, archive/restore metadata, and the one-sport lock once any match has started.
- Generalise `divisions` and `division_entries` for 8/12/16/24/48 templates, team/individual/placeholder entries, lifecycle state, seed, availability constraints, withdrawal, and replacement lineage.
- Persist each bulk import as one transaction and one import record. Any invalid row rolls back the entire import; audit/outbox evidence is written only on commit.
- Store immutable, versioned sport-pack identity separately from competition and division override documents. Existing competitions keep their selected pack version when defaults change.
- Persist playing areas, local availability/unavailable intervals, slot length, and fixed reserve slots. Store timezone-qualified inputs; calculate capacity in the domain from absolute intervals.
- Keep `format_revisions` immutable. Drafts may be replaced only by creating a new revision; publish requires database-backed structural validation evidence and an exact definition hash.
- Store standings snapshots against the result/publication version and calculation input hash so read models can prove which results produced a table.
- Enforce the free-plan 16-entry limit transactionally across every active division in a competition. Upgrade changes entitlement only; it never drops entries.

## API rules

- Reads require an active owner, organiser, or viewer membership as appropriate. Mutations require owner/organiser, same-origin validation, CSRF, and a transaction-capable database client.
- Every successful mutation writes an append-only audit record and outbox event in the same transaction. Rejected commands write neither partial business rows nor success evidence.
- Optimistic revision/hash inputs reject stale settings and format writes with a conflict response.
- CSV and paste imports return row-addressable validation errors without echoing unnecessary source data.
- Responses expose pack version, recommendation/customisation state, capacity assumptions, format revision/hash, and standings snapshot version; they never expose session, import, or access secrets.
- The Phase 2 endpoints remain compatible while the general Phase 3 routes become the canonical organiser contract.

## Publish guardrail

A format revision can publish only when the stored definition hash matches the validated definition, every referenced entry/stage exists, the graph is acyclic and reachable, advancement slots are unambiguous, generated match IDs/counts are deterministic, and the selected recommendation fits calculated capacity. PostgreSQL rejects a publish without that evidence even if an API caller bypasses the normal route.

## Verification contract

- Domain property/invariant tests cover all five sports and 8/12/16/24/48 entry fixtures.
- Database tests prove tenant isolation, atomic import rollback, free-limit serialization, immutable revisions, invalid-graph publish rejection, and snapshot version integrity.
- API integration tests use a fully migrated disposable PostgreSQL database and prove permissions, CSRF, audit/outbox atomicity, conflict handling, and secret-free reads.
- Browser tests cover reusable settings editing, internal defaults administration, capacity summary states, mobile layout, accessibility, and strict console/request failure guards.
