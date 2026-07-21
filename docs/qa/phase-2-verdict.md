# Phase 2 — Independent QA/QC verdict

**Date:** 17 July 2026

Verdict: PASS

No findings. The three original release blockers and the subsequent Playwright TLS-artifact cleanup defect are resolved. Phase 2 passes its internal learning gate.

## Original-blocker recheck

- **Real phone correction, recovery, and publication:** PASS. `pnpm test:e2e:phase2:real` ran a production Next build, real Fastify app, and fully migrated disposable PostgreSQL database on a Pixel 7 Chromium profile. It proved access-token URL sanitisation, strict sealed HttpOnly scoring cookie, persisted `match_started`, scorer-attributed goal, reload recovery, final result v1, the real-slug receipt CTA, authenticated correction to v2, unchanged schedule v1, public re-rendering, audit/database oracles, and failure-propagating teardown.
- **Production organiser truthfulness:** PASS. With demo mode explicitly absent, `/organiser/competitions/singapore-open` returned `404` with no `Singapore Open 2026` or `POLO-12` fixture content. A valid UUID without a session redirected to `/forbidden`. Source and unit review confirmed production accepts UUIDs, uses the authenticated competition workspace API, forwards only the named session cookie for an allowed host, and reserves fixtures for explicit `MATCHDAY_PHASE2_DATA_MODE=demo`.
- **Scorer-secret containment:** PASS. The real browser ended on `/score`; the access token was absent from URL, DOM-visible cookies, local storage, and session storage. The sole scoring credential was `__Host-matchday-scoring-session` with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`. Recovery after reload succeeded without Web Storage credentials.

## Cleanup remediation recheck

- `apps/web/tests/helpers/https-proxy.mjs` now generates its RSA private key and one-day self-signed certificate through in-memory OpenSSL pipes; it creates no certificate directory or file.
- A fresh independent `pnpm test:e2e` run passed 72/72. Before and after that run, `find "$TMPDIR" -maxdepth 1 -type d -name 'matchday-playwright-tls-*'` returned empty.
- Post-run checks found no listeners on ports `3100`, `3101`, `3102`, or `4100`, and no Next, Playwright, HTTPS-proxy, or Phase 2 E2E process.
- No `matchday_phase2_e2e_*` database, `test_phase2_e2e_*` schema, or `matchday-phase2-e2e-*` temporary directory remained.

## Fresh local evidence

All Node commands used Node `24.18.0` and pnpm `10.33.0`. The Browser runtime was unavailable, so the repository's Playwright workflows were used.

- Real production phone/API/database E2E: PASS, 1/1.
- Organiser, scoring BFF, and scoring client tests: PASS, 3 files / 22 tests.
- Phase 2 API route, runtime, and OpenAPI tests with infrastructure enabled: PASS, 3 files / 5 tests.
- Browser regression matrix: PASS, 72/72 across desktop/phone Chromium and tablet/phone WebKit, including visual, responsive, accessibility, console, page-error, and failed-request guards.
- Formatting, lint/i18n, 14-workspace typecheck, OpenAPI freshness, production web build, HTTPS-proxy syntax, and post-run cleanup checks: PASS.

## Exit criteria

- Canonical competition through public final result: PASS.
- Independent score/standings parity and migrated persistence/API boundaries: PASS.
- Real phone scoring, correction, publication isolation, and sealed-cookie recovery: PASS.
- Production organiser and scorer-secret boundaries: PASS.
- Independent QA/QC verdict: PASS.

## Gate boundary

This verdict evaluates only the Phase 2 internal learning gate. The separate Phase 1 formal release gate remains `FAIL` for its documented hosted CI, live identity-provider, CDN/purge, telemetry, and managed-backup evidence gaps; the green local Phase 2 evidence does not resolve those external requirements.
