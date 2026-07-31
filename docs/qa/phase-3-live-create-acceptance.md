# Phase 3 live create-competition acceptance

- Source SHA: `525204bdd3a4dc62438942f41436345ea19a3532`
- Branch: `fix/gate-c-c3-organiser-competition-create`
- Runtime: Node `v24.18.0`, pnpm `10.33.0`, local PostgreSQL 18.4, local Redis 8.2
- Browser: headed desktop Chromium, one worker
- Evidence collection: 2026-08-01 UTC

## Unmocked acceptance

A fresh PostgreSQL account and opaque hashed session were seeded with zero
writable organisations. The browser used the real Next.js BFF and Fastify API;
no request interception or mocked response was used.

The browser completed first-use workspace bootstrap, competition creation,
setup-route reload, and a subsequent create-page readback. The test observed
exactly one bootstrap `200` and one competition-create `201`. The sole console
exception is the deliberate first-use `404` for an absent setup draft; the UI
renders `Start assisted setup` and the guard permits exactly one such response.
No failed browser requests or other console/page errors were accepted.

## PostgreSQL oracle

The created aggregate returned exactly one competition, one owner workspace,
one organisation audit event, one organisation outbox event, one competition
audit event, and one competition outbox event.

## Retained local artifacts

Artifacts are ignored and retained under
`artifacts/qa/c3-live-create/525204bdd3a4dc62438942f41436345ea19a3532/`.

| Artifact               | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `test-source.ts`       | `2dbd4891a14ad828c2920a6f90790bf2e0bd0f39bd261b0a881585908fbadae6` |
| `playwright.log`       | `600a9d82e6468a74d25870d315536107a6998d6a2e3fe3d2e87c9e022f5f833f` |
| `postgres-oracle.json` | `a1ccbc71681fbc153c59d4653d848eb06899b7472ad80c58aed946c77758bff0` |

No cookies, session secrets, raw environment values, account identifiers, or
competition identifiers are retained in this document.
