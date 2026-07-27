# Phase 4 Gate B local acceptance

Date: 27 July 2026

Branch: `fix/gate-b-local-remediation-20260724-132224`

Validated source commit: `4f9202e4e1c546bfef2a23bcfc7e26825c90b314`

Runtime: Node `24.18.0`, pnpm `10.33.0`

Local Gate B validation: PASS

## Acceptance result

- Strict WCAG A/AA gating is reusable and blocks moderate WCAG findings.
- Chromium and WebKit accessibility tests passed 68/68.
- Successful schedule/setup/format mutations preserve focus, selection, scroll
  and error context without hard document navigation.
- The state-preservation suite passed 20/20 with natural exit 0.
- The browser owns the complete organiser decision journey from competition
  creation through public moved-match verification.
- Phone Chromium, tablet WebKit and desktop Chromium each use independent
  aggregates.
- Two clean harness runs used distinct disposable PostgreSQL and Redis
  isolation and newly started production processes.
- Redis cleanup is namespace-owned, refuses dirty state, uses bounded
  `SCAN`/`UNLINK`, records `0 → 0` owned keys and preserves an unrelated
  near-prefix TTL guard.
- PostgreSQL migration, populated upgrade, integration, authorization,
  idempotency, concurrency, audit and outbox checks passed.
- Production dependency audit, build, visual comparison, console/network
  guards and public/private schedule isolation passed.
- Schema-v2 evidence is bound to the exact source SHA and retained bundle.
- Independent QA/QC recorded P0: 0 and P1: 0.

The immutable evidence, correction trail and accepted residual risks are
documented in:

- [`phase-4-final-evidence.md`](./phase-4-final-evidence.md)
- [`phase-4-local-run.md`](./phase-4-local-run.md)
- [`phase-4-verdict.md`](./phase-4-verdict.md)

This is local Gate B proof only. It does not claim a production deployment.
