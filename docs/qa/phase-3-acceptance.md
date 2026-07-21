# Phase 3 — Competition engine acceptance

**Date:** 20 July 2026

**Scope:** Phase 3 Gate A competition lifecycle, sport packs, capacity, format persistence, results, standings, and advancement. Phase 4 manual and drag-and-drop builders and `FMT-004` double elimination remain out of scope.

## Accepted implementation

- Competition, division, entry, import, seed, availability, withdrawal, replacement, duplication, archive, restore, free-plan, and sport-lock lifecycles are transactionally enforced.
- Versioned sport packs support immutable pinning, competition/division overrides, one current active version per sport, permissioned draft/activation, and adoption only by newly created competitions.
- Capacity preserves source-local windows and stable area IDs, applies per-area reserves, handles DST boundaries, and compares aggregate requirements across all selected division formats at publication time.
- Format graphs use immutable revisions, complete entrant coverage, division-population checks, deterministic IDs, direct-database validation, current-capacity evidence, and supported 8/12/16/24/48 templates.
- Server-owned results preserve immutable snapshot provenance, scored-match participant assignments, zero-played group members, group-only pools, withdrawals and forfeits, and best-across-groups automatic advancement.
- Production organiser capacity, results, settings, and internal sport-default surfaces use authenticated API contracts with revision conflicts, loading/empty/error/permission states, responsive layouts, and accessible interaction targets.

## Automated evidence

All Node commands used Node `24.18.0`.

| Gate                                                     | Result                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Repository format, lint, i18n, typecheck, and whitespace | PASS                                                                                                         |
| Domain tests                                             | PASS: 180/180, zero skips                                                                                    |
| Phase 2/3 API routes, OpenAPI, and live runtimes         | PASS: 35/35, zero skips                                                                                      |
| Full Phase 3 runtime                                     | PASS: 20/20                                                                                                  |
| Full API integration                                     | PASS: 61/61                                                                                                  |
| Database integration                                     | PASS: 26/26, zero skips                                                                                      |
| Clean-schema migrations                                  | PASS: 12/12                                                                                                  |
| Canonical fixtures                                       | PASS: five sports, five required sizes, 15 graph oracles, four timezone boundaries, and three invalid graphs |
| OpenAPI freshness and JSON validity                      | PASS                                                                                                         |
| Production dependency audit and secret scan              | PASS: no known production vulnerabilities or leaked secrets                                                  |
| Production build                                         | PASS                                                                                                         |
| Browser matrix                                           | PASS: 78/78 with retries disabled across desktop Chromium, tablet WebKit, phone WebKit, and phone Chromium   |
| Browser runtime guards                                   | PASS: no console warning/error, page error, or unapproved failed request                                     |

## Visual and user-like review

- Fresh capacity, sport-default admin, and results views were inspected on desktop and phone.
- No blocking clipping, overflow, overlap, touch-target, loading-state, or obvious contrast defect remained.
- Service-worker registration rejection is handled by product code. The browser guard allowlist is limited to Geist/GeistMono unused-preload warnings; stale speculative RSC request cancellations; WebKit access-control page errors for those RSC requests; exact cancelled same-origin `.woff`/`.woff2` font requests; and exact cancelled same-origin `/sw.js` requests. Other console warnings/errors, page errors, and failed requests remain enforced.

## Gate boundary

This acceptance closes the internal local Phase 3 Gate A only. It does not prove a deployed production-host smoke, a real authenticated administrator/device journey, external policy approval, hosted CI, live identity-provider/CDN/telemetry configuration, or managed backup evidence. The separate Phase 1 verdict remains the controlling external release boundary.
