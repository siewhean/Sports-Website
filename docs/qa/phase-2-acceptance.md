# Phase 2 — Canoe Polo vertical-slice acceptance

**Date:** 17 July 2026

**Scope:** The 14-step Canoe Polo slice at source lines 3181–3201 and the Phase 2 exit evidence in `docs/EXECUTION_ROADMAP.md`.

## Requirement traceability

| Step | Deliverable                         | Local implementation evidence                                                                                          | Status           |
| ---: | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
|    1 | Account and competition creation    | Phase 1 identity foundation plus authenticated competition creation in the migrated-database runtime test              | Verified locally |
|    2 | Canoe Polo settings                 | Typed settings, database constraints, organiser rules surface, and API mutation/read model                             | Verified locally |
|    3 | One division with 8/16 teams        | Division and entry persistence, exact seed bounds, 8/16 independent fixtures, and organiser entry surface              | Verified locally |
|    4 | Capacity setup                      | Continuous availability-window capacity calculation, database consistency checks, and capacity surface                 | Verified locally |
|    5 | Balanced group-to-knockout template | Deterministic two-group, semi-final, bronze, and final graph                                                           | Verified locally |
|    6 | Deterministic match generation      | Namespaced deterministic match IDs, idempotent generation, dependency validation, and 8/16 golden oracles              | Verified locally |
|    7 | Basic schedule generation           | Deterministic 30-minute assignments with area availability and dependency ordering                                     | Verified locally |
|    8 | Published schedule                  | Immutable published revision, isolated schedule/result versions, public projection, and audit/outbox writes            | Verified locally |
|    9 | Match-specific QR access            | Hashed opaque tokens and short codes, expiry/revocation, throttled exchange, and secret-free reads                     | Verified locally |
|   10 | Mobile scorecard                    | Same-origin BFF, sealed HttpOnly session recovery, fencing, persisted match start, append/finalise, and phone-first UI | Verified locally |
|   11 | Immediate result publication        | Atomic finalisation, result versioning, public projection refresh, and acknowledgement receipt                         | Verified locally |
|   12 | Table and bracket recalculation     | Explainable standings, advancement, correction-conflict analysis, and published snapshots                              | Verified locally |
|   13 | Audit history                       | Append-only database/API audit storage and migrated-runtime correction oracle                                          | Verified locally |
|   14 | Public competition page             | Server-only typed API projection with results, schedule, table, bracket, publication version, and freshness            | Verified locally |

## Exit evidence

- A migrated-PostgreSQL integration executes the complete 14-step competition from creation through published final result. It also proves idempotency, one-writer fencing, correction conflicts, result/schedule publication isolation, audit records, hashed access material, and public readback.
- Independent Node-only fixtures validate 8-entry and 16-entry capacities, graph/schedule counts, score reduction, correction behavior, publication versions, audit evidence, and QR/access oracles.
- Production web routes use authenticated organiser reads plus the real public and scoring APIs by default. Deterministic demo mode is explicit and limited to local visual/E2E fixtures.
- The scoring browser holds its writer credential only in a sealed `Secure; HttpOnly; SameSite=Strict; Path=/` cookie. The access token is removed from the URL after exchange and neither token nor writer secret is stored in Web Storage.
- A real Pixel 7 Chromium journey runs a production Next build and Fastify against a disposable, fully migrated PostgreSQL database. It proves access exchange, persisted `match_started`, scorer-attributed goal, reload recovery, final publication, the receipt CTA, authenticated correction, independent result versions, audit evidence, cleanup, and public readback.
- The organiser surface is a Phase 2 operational/read-model slice. Unsupported real-workspace sections remain neutral rather than showing fixture data; complete autosaving mutation flows and expanded live/audit projections remain owned by Phase 4 and are not claimed here.

## Automated evidence

All commands used Node `24.18.0` and pnpm `10.33.0`.

| Gate                        | Result                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository `check`          | PASS: formatting, lint/i18n, 14-workspace typecheck, unit/integration, fixtures, OpenAPI, dependency audit, secret scan, build, deployment manifest, and origin asset verification |
| Domain                      | PASS: 4 files / 19 tests, including format, schedule, scoring, standings, bracket, and correction behavior                                                                         |
| Phase 2 golden fixtures     | PASS: independent 8-entry and 16-entry validator                                                                                                                                   |
| API                         | PASS: 13 unit and 32 infrastructure integration tests                                                                                                                              |
| Database                    | PASS: 12/12 infrastructure integration tests, including 10 Phase 2 constraint tests                                                                                                |
| Migrations                  | PASS: six migrations from an empty schema and concurrent/idempotent checks                                                                                                         |
| Backup/restore              | PASS: restored one deterministic account row and matching fingerprint                                                                                                              |
| Browser matrix              | PASS: 72/72 across desktop/phone Chromium and tablet/phone WebKit; preserved Phase 0/1 plus Phase 2                                                                                |
| Real phone/API/database E2E | PASS: production web + Fastify + disposable migrated PostgreSQL; v1 final result, v2 correction, recovery, HttpOnly credential, audit/DB oracle, and leak-free teardown            |
| Accessibility/runtime       | PASS: post-interaction Axe checks and strict console, page-error, and failed-request guards                                                                                        |
| Responsive interaction      | PASS: 320px no-overflow, at least 48px scoring controls, reduced motion, and forced colors                                                                                         |
| Clean-checkout output guard | PASS in an output-free temporary copy; the working tree intentionally contains build outputs after verification                                                                    |

## Visual and user-like review

- Organiser: competition context remains visible while setup, rules, entries, capacity, format, schedule, publication, access, and audit surfaces use one restrained operating-system visual language.
- Scorer: the phone view prioritises score and writer state; goal entry requires team-specific scorer attribution, period, and manual event time before append.
- Public: final result is above the fold, followed by published-only schedule, table, bracket, version, and freshness evidence.
- Desktop Chromium, phone Chromium, tablet WebKit, and phone WebKit baselines exist under `apps/web/tests/phase-2-visual.spec.ts-snapshots/`.
- No blocking clipping, horizontal overflow, touch-target, contrast, console, page, request, or service-worker defect remained in the final 72-test browser matrix.

## Gate boundary

Phase 2 is explicitly an internal learning gate. The unresolved external Phase 1 evidence in `docs/qa/phase-1-verdict.md` still prevents a formal release advance: hosted CI, live identity provider, deployed CDN/purge receipts, hosted telemetry, and managed backup evidence cannot be inferred from these local results.
