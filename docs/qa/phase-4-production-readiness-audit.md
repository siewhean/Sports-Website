# Phase 4 — Gate B production-readiness audit

**Audit date:** 22 July 2026  
**Audited commit:** `4b62a48a90d648cd3f2c9deb360c2bd34ca74e10`  
**Remediation branch:** `agent/gate-b-production-readiness-audit`  
**Requirements authority:** `sports_competition_platform_implementation_plan.md`  
**Execution authority:** `docs/EXECUTION_ROADMAP.md`

## Verdict

**Verdict: FAIL**

The audited commit provides substantial and useful **local Organiser Alpha** evidence. It is not production-ready, and the existing local `Verdict: PASS` must not be interpreted as a production-release verdict.

The review found no evidence of a known data-loss exploit in the published schedule path, but it found multiple P1 correctness and release-readiness defects that invalidate a production-readiness claim.

### Finding count

- P0: 0
- P1: 9
- P2: 5
- P3: 0

## Scope boundary

Gate B covers the organiser workflow: Assisted Setup, canonical format editing, capacity-first recommendations, background scheduling, alternatives, locks, moves, revision comparison and explicit publication.

Gate B does **not** make the full platform production-ready. Event-day access, concurrent scoring, offline replay, result corrections and public operation belong to Gate C. Billing, pilots, security hardening and production operations remain later gates.

The formal Phase 1 verdict is also still `FAIL` because live identity-provider, CDN/purge, hosted telemetry, managed backup/restore and production-provider evidence remain incomplete.

## Positive findings

The audit confirmed strong implementation foundations:

- Object-level organisation and competition authorisation.
- Opaque hashed sessions, expiry, revocation and timing-safe secret comparison.
- Host-only HttpOnly cookies, CSRF validation and exact origin checks.
- OIDC PKCE, state and nonce support.
- Immutable format and schedule revision lineages.
- PostgreSQL constraints, advisory locks and optimistic revisions.
- Idempotency receipts for retryable writes.
- Audit and outbox evidence around critical mutations.
- Deterministic sport packs, capacity, format validation and scheduling.
- Server-owned sport selection and settings references for all five launch sports.
- Explicit public/draft schedule separation.
- Strong local unit, PostgreSQL, Redis, browser, accessibility and visual evidence recorded for commit `4b62a48`.

These are meaningful strengths. They do not cancel the findings below.

## P1 findings

### PR-B-001 — Browser evidence is not authenticated full-stack E2E

The Playwright matrix uses the production-built Next.js application but sets `MATCHDAY_PHASE2_DATA_MODE=demo`. It does not prove the browser journey through the Next BFF, Fastify API, authenticated session, PostgreSQL and Redis worker as one deployed path.

**Impact:** Contract mismatches between browser, BFF and API can escape the existing Gate B browser suite. The completed-setup permission mismatch found by this audit is one example.

**Required closure:** Add an authenticated browser test against real local PostgreSQL, Redis and API processes. The journey must create/resume a competition, select sport, edit capacity/settings/entries, select a recommendation, generate/accept/edit/publish a schedule, complete setup, reload and verify the public projection.

### PR-B-002 — Valid unselected recommendations can disappear on resume

Generated recommendation cards intentionally carry `format_revision_id: null` until the organiser selects one. The pre-audit database stale-evidence function required every recommendation to point to a persisted format revision. Because the active browser calls the explicit resume mutation on mount, a normal reload at the recommendation step could clear valid recommendations.

**Remediation:** Migration `0025_phase4_unselected_recommendation_resume.sql` now validates immutable recommendation-set and candidate evidence while allowing null revision IDs before selection. A selected candidate must point to exact applied revisions.

**Validation required:** Run the new populated PostgreSQL regression and an authenticated reload test at Step 6.

### PR-B-003 — Schedule and publication resume used the wrong hash domain

The accepted schedule revision has an `assignment_hash`; the broader solver option has a `result_hash`. Assisted Setup pins the accepted assignment hash. The pre-audit database resume functions compared it with the option result hash, so a reload at schedule review or after publication could invalidate correct evidence.

**Remediation:** Migration `0026_phase4_schedule_resume_hash_domains.sql` validates the exact accepted revision, assignment hash, source job/option, format definition and publication pointer.

**Validation required:** Resume once after accepting an option and once after publishing. Neither resume may increment the setup revision or clear evidence when canonical inputs are unchanged.

### PR-B-004 — Completed setup responses violated the browser contract

Completed and expired setup documents were marked `read_only: true` but could retain `permission: "write"`. The web parser correctly rejects that contradiction. A real completion, reload or resume could therefore be treated as an invalid response.

**Remediation:** `ReliableGateBPhase4Runtime` now normalises autosave, read and resume documents to truthful read permission and the correct `read_only` or `expired` autosave state.

**Validation required:** Complete setup through the real BFF, verify the response parses, reload it and verify the read-only review remains accessible.

### PR-B-005 — Format draft participation metrics were misleading

The format workspace calculated `guaranteed_matches` as floor(total match participations / entries), which is an average rather than a minimum guarantee. It also labelled the competition-wide match count as the per-entry maximum.

For an eight-entry championship-focus format, this could report four guaranteed matches although entries eliminated after group play are guaranteed only three. The per-entry maximum is five, not sixteen.

**Remediation:** Production format workspace responses now use the deterministic domain `calculateFormatMetrics` function for match count, minimum guaranteed matches and maximum per-entry matches.

**Validation required:** Verify every 8/12/16/24/48 template and manually edited graph displays metrics equal to domain-oracle results.

### PR-B-006 — Client recommendation fields were only partially canonicalised

The browser posts the complete recommendation selection object. The pre-audit canonical check verified graph identity and some counts but did not verify every persisted name, advantage, guarantee, ranking, warning or feasibility field.

**Remediation:** The reliable runtime now accepts only the selected recommendation ID and capacity acknowledgement from the client and rebuilds the stored selection from the current server-owned recommendation evidence.

**Validation required:** Submit forged display fields and metrics. The persisted document must retain the canonical server values.

### PR-B-007 — Production dependency audit is red

The audited lockfile contains vulnerable dependency paths reported by `pnpm audit`:

- `fast-uri` through Fastify serialization.
- `fast-uri` through Swagger schema resolution.
- `sharp` / inherited libvips through the Next.js image path.

**Required closure:** Upgrade compatible direct parents or regenerate a tested lockfile with patched versions. Do not silence the audit. Re-run Fastify serialization, OpenAPI, Next production build, image optimisation and visual tests.

### PR-B-008 — Production AI has no live provider adapter

The current provider factory supports disabled mode and a deterministic local/test stub. The stub is explicitly forbidden in staging/production. Deployed text-to-brief therefore falls back manually unless another provider is implemented.

**Impact:** The Gate B AI trial is locally proven, but the advertised premium AI capability is not production-ready.

**Required closure:** Either implement and test a production provider adapter with schema validation, timeouts, retries, privacy controls and usage accounting, or keep the AI feature disabled and remove production-facing promises until that work is complete.

### PR-B-009 — Phase 1 production foundation remains failed

The existing Phase 1 verdict records missing live evidence for the identity tenant, CDN/purge, hosted telemetry/error tracking, managed backup retention/regional restore and production provider configuration.

**Required closure:** Do not label Gate B or the overall application production-ready until those dependencies have staging evidence and the Phase 1 verdict is rerun.

## P2 findings

### PR-B-010 — Demo mode did not fail closed in deployed environments

A deployment misconfigured with `MATCHDAY_PHASE2_DATA_MODE=demo` could serve deterministic organiser data.

**Remediation:** `apps/web/next.config.ts` now rejects demo mode in staging/production and requires the server API origin there.

### PR-B-011 — Visual-test execution is platform-dependent

The repository records macOS-specific visual baselines while the future Ubuntu workflow installs only Chromium even though the Playwright matrix includes WebKit projects.

**Required closure:** Define the supported visual-baseline platform. Either install WebKit and commit Linux baselines, or run visual approval on a pinned macOS runner while Linux runs functional responsive and accessibility tests.

### PR-B-012 — Duplicate format-save helper remains a latent regression risk

The active format editor imports the corrected helper from `phase4-format-persistence.ts`, but another exported helper in `phase4-format.ts` still uses the older parent field semantics.

**Required closure:** Delete the duplicate or make both implementations delegate to one tested function.

### PR-B-013 — Schedule mutations rely heavily on full-page reloads

Several successful schedule commands reload the whole page. This is functionally safe but loses focus, comparison context and screen-reader position.

**Required closure:** Replace nonessential reloads with returned server documents, router refreshes with focus restoration, and live announcements. Retain reload only for unrecoverable conflicts.

### PR-B-014 — Production performance evidence is incomplete

Gate B has deterministic solver tests and functional browser evidence, but no production-like measurement for schedule-job latency, concurrent organisers, large multi-division schedules, API p95 or browser interaction latency.

**Required closure:** Add a staging performance profile and measurable thresholds before broad production rollout.

## Remediation branch changes

The audit created `agent/gate-b-production-readiness-audit` from commit `4b62a48` and added:

- Truthful completed/expired setup response normalisation.
- Server-owned recommendation selection canonicalisation.
- Deterministic format participation metrics in production responses.
- Migration 0025 for unselected recommendation resume.
- Migration 0026 for accepted schedule/publication hash domains.
- Clean and populated migration-chain coverage through migrations 0025/0026.
- Unit regressions for read-only contracts, metrics and forged recommendation fields.
- PostgreSQL regression for unselected recommendation resume.
- A staging/production fail-closed demo-data guard.

These changes have **not** received executable validation in the audit environment. They must not be described as passing until the required commands run in a complete checkout with Node 24.18, pnpm 10.33, PostgreSQL, Redis, Chromium and WebKit.

## Required validation before a new verdict

Run at minimum:

```text
pnpm install --frozen-lockfile
pnpm ci:assert-clean-outputs
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm db:migrate:check
pnpm backup:verify
RUN_INFRA_TESTS=1 pnpm test:integration
pnpm validate:fixtures
pnpm validate:phase2
pnpm validate:phase3
pnpm validate:phase4
pnpm openapi:check
pnpm dependencies:audit
pnpm secrets:scan
pnpm build
pnpm deploy:manifest
pnpm asset-delivery:verify:origin
pnpm test:e2e
pnpm test:a11y
pnpm test:visual
git diff --check
```

Add focused evidence for:

1. Unselected recommendations survive resume.
2. Accepted schedule review survives resume.
3. Published review survives resume.
4. Completed setup parses through the real BFF and reloads read-only.
5. Forged recommendation fields are discarded.
6. Correct format metrics are displayed after read, save and template application.
7. Demo mode is rejected in staging/production.
8. The complete authenticated organiser journey passes without demo data.
9. Dependency audit returns zero unaccepted production advisories.

## Release interpretation

After the remediation passes, Gate B may be labelled:

> Locally verified Organiser Alpha suitable for controlled staging and design-partner testing.

It still must not be labelled:

> Production-ready sports competition platform.

That wider claim requires Gate C event-operation reliability, pilot gates, commercial controls, security review and Gate F production operations.
