# Phase 4 Gate B remediation progress

**Updated:** 23 July 2026  
**Branch:** `agent/gate-b-production-readiness-audit`  
**Plan:** `docs/qa/GATE_B_BLOCKER_REMEDIATION_PLAN.md`  
**Validation PR:** #7

## Current overall verdict

**Verdict: BLOCKED**

The known Gate B source gaps have been substantially remediated and the acceptance process is now fail-closed. Gate B still cannot receive PASS because the current environment cannot execute the pinned Node/PostgreSQL/Redis/Playwright suite, GitHub-hosted jobs fail before creating a step, and no real staging-provider or organiser receipts have been supplied.

Gate C must not begin.

## Phase status

| Phase | Source status | Executed evidence | Verdict | Blocking evidence |
|---|---|---|---|---|
| 0 — Baseline and evidence | Complete | Small helper checks only | BLOCKED | Full checkout and pinned runner unavailable |
| 1 — Correctness | Remediated through migration 0030 | Not executed against PostgreSQL | BLOCKED | Frozen install, typecheck, migration and integration results |
| 2 — Authenticated full-stack E2E | Implemented, including browser-owned critical decisions | Not executed | BLOCKED | Two clean Chromium/WebKit runs and database oracles |
| 3 — Dependencies | Known vulnerable versions absent; audit remains mandatory | Not executed | BLOCKED | `pnpm audit --prod` result from current lockfile |
| 4 — UX/accessibility | Reload removal, focus restoration, 320px/WCAG and visual policy implemented | Not executed | BLOCKED | Chromium/WebKit accessibility and visual artifacts |
| 5 — Reliability/performance | Deterministic multi-match performance qualification implemented | Not executed | BLOCKED | Pinned-runner latency results |
| 6 — Production AI | Complete decision: disabled/manual-first | Unit source added, not executed | BLOCKED | Full suite must confirm fail-closed production configuration |
| 7 — External evidence | Machine-verifiable gate and collection runbook implemented | Synthetic validator logic checked; real receipts absent | BLOCKED | OIDC, CDN/purge, hosted telemetry, managed restore and organiser receipts |
| 8 — Independent verdict | Not issued | None | BLOCKED | Depends on every prior required check passing |

## Source remediation completed

### Strict no-skip runner

The strict runner and pinned container now require:

- Node `24.18.x` and pnpm `10.33.0`;
- frozen lockfile installation;
- clean-output, formatting, lint and full monorepo typechecking;
- unit, migration, backup/restore and infrastructure integration tests;
- deterministic scheduler performance qualification;
- canonical Phase 2, Phase 3 and Phase 4 fixtures;
- OpenAPI, dependency audit and secret scanning;
- production build, deployment manifest and origin asset verification;
- Chromium and WebKit browser engines;
- the authenticated Gate B journey twice from clean isolation;
- the normal browser, accessibility and visual suites;
- commit-bound staging-provider and organiser evidence;
- whitespace validation.

Any failed or skipped required command makes the verdict FAIL.

The QA container includes PostgreSQL 18 client tools, Chromium, WebKit and a checksum-verified Gitleaks binary. PostgreSQL, Redis and Mailpit are supplied by the outer Compose project. Git metadata is mounted read-only at runtime so commit attribution, history secret scanning and whitespace checks remain available without baking repository history into the image.

### Correctness and database lineage

Implemented source remediation includes:

- preservation of valid unselected recommendation evidence;
- correct accepted-assignment versus solver-result hash domains;
- truthful completed and expired read-only setup documents;
- server-owned recommendation selection canonicalisation;
- deterministic minimum guarantee and maximum participation metrics;
- atomic materialisation and publication of every selected division format;
- read-only visibility of a selected published format when no editable draft exists;
- idempotent republication of the same exact format without duplicate audit or outbox evidence;
- serialized prevention of schedule rollback over a newer public revision;
- preservation of legitimate private schedule repairs while a stable revision is public;
- populated migration upgrades through migration `0030_phase4_idempotent_format_publication.sql`;
- production demo-data fail-closed configuration;
- production AI disabled outside the complete deterministic/manual path.

### Assisted Setup contract repair

Static review found that the existing web parser still expected an obsolete reduced recommendation shape. It rejected current canonical responses containing:

- `format_revision_id: null` before selection;
- guaranteed-match evidence;
- ranking coverage;
- available-slot evidence;
- per-division candidate and applied-format lineage.

`apps/web/lib/phase4-assisted-setup-current.ts` now validates the complete current contract and supports both selected and unselected evidence. It also validates the full recommendation selection request posted by the organiser UI. The exact app alias and BFF write boundary use this current parser.

### Schedule-to-setup evidence bridge

The schedule UI now persists canonical Assisted Setup evidence after actual organiser actions:

- accepting a solver option stores exact `schedule_review` evidence;
- publishing stores exact `review_publish` evidence;
- settings references are reduced to immutable pointers;
- assignment hashes, result revisions, job IDs, selected format IDs and publication revision IDs are preserved;
- accept and publish idempotency keys survive partial failure and are cleared only after setup evidence is stored;
- versioned publication responses validate the required `schedule_version` separately from the immutable revision response.

This closes the product integration gap where a schedule could be accepted and published but Assisted Setup could not be completed without fixture-only runtime calls.

### Schedule workspace UX

Successful option acceptance, publication, lock and unlock no longer call `window.location.reload()`.

The workspace now:

- uses `router.refresh()`;
- preserves selected objective, selected match, scroll and component state;
- announces success through an atomic polite live region;
- restores focus without scrolling;
- distinguishes transport failure from canonical setup-sync failure;
- has a static regression forbidding hard reloads on this surface.

### Real authenticated browser journey

The real E2E harness uses:

```text
Playwright
→ production Next.js
→ same-origin BFF
→ Fastify API
→ real identity session and CSRF
→ isolated PostgreSQL database/schema
→ Redis queue
→ actual scheduler worker
→ public projection
```

The browser suite now creates a dedicated competition through authenticated HTTP prerequisites, then drives these critical decisions through the rendered organiser UI:

1. select the server-owned recommendation;
2. generate a Balanced schedule through Redis;
3. wait for and accept the real current-best option;
4. persist schedule review evidence through the UI integration;
5. lock a scheduled match;
6. publish the schedule;
7. persist publication evidence;
8. complete Assisted Setup;
9. verify read-only completion and the exact published assignment hash.

The dedicated journey is isolated from the fixed unselected, accepted and completed oracle fixtures. The real matrix contains phone Chromium, desktop Chromium and desktop WebKit. The complete journey runs on both desktop engines.

### Accessibility and visual portability

Source changes include:

- WCAG A/AA-tagged Axe failures as blockers;
- 320 CSS-pixel reflow coverage;
- structured non-drag schedule movement path coverage in the existing suite;
- Chromium and WebKit installation aligned with configured projects;
- standard browser tests isolated from the special real Gate B state file;
- explicit canonical snapshot paths and bounded cross-platform pixel drift;
- no snapshot regeneration during normal validation.

### Dependency and supply-chain controls

The current lockfile resolves the previously named dependency paths above their published fixes:

- `fast-uri` at patched versions;
- `sharp` 0.34.5;
- Sharp libvips optional packages at 1.2.4.

A deterministic known-advisory assertion runs before, but does not replace, `pnpm audit --prod --audit-level moderate`.

The secret scan uses Git history when Git metadata is present and a directory scan in the image-only fallback. The QA image installs a pinned Gitleaks release with verified upstream checksums.

### External evidence gate

Gate B now refuses PASS unless these five ignored files exist under `artifacts/qa/gate-b/external`:

- `oidc.json`;
- `cdn.json`;
- `telemetry.json`;
- `restore.json`;
- `organisers.json`.

The validator requires:

- exact tested-commit binding;
- staging environment evidence no older than the configured limit;
- no secrets, cookies, credentials, tokens or private keys;
- OIDC PKCE/recovery/revocation/signature/replay receipts;
- CDN TLS, Brotli, MISS→HIT, private bypass, AVIF/WebP and purge receipts;
- hosted trace, error, alert and request-correlation receipts;
- encrypted retained cross-region restore with equal row counts and SHA-256 fingerprints;
- restore evidence at the actual latest repository migration;
- chronologically consistent collection, purge, backup, restore and review timestamps;
- one local and one national-level organiser, each passing the five critical organiser tasks with no blocking findings.

Collection templates and privacy rules are documented in `docs/qa/GATE_B_EXTERNAL_EVIDENCE.md`.

## Limited checks executed in the audit environment

The available environment is Node `22.16.0` without pnpm, Docker, PostgreSQL, Redis or a complete MATCHDAY checkout. The following limited checks have been performed:

- the original Gate B evidence helper self-test exposed and then verified a Bearer-redaction fix;
- the external evidence validator logic accepted a complete synthetic bundle and rejected commit mismatch and secret-bearing evidence before the latest chronology tightening;
- standalone strict TypeScript checks with stubbed contract modules passed for the current Assisted Setup adapter and schedule-to-setup synchronisation module;
- source-level API registration, BFF, scheduler, identity, publication and parser contracts were reviewed after each change.

These are narrow checks only. They are not Gate B application evidence and do not replace the pinned runner.

## Evidence still unavailable

The following required outcomes remain unexecuted or absent:

- Node `24.18.x` container run;
- pnpm `10.33.0` frozen installation;
- formatting, ESLint and full monorepo typechecking;
- clean and populated PostgreSQL migrations through migration 0030;
- infrastructure integration tests and local backup/restore;
- current-lockfile production dependency audit;
- production web/API build and origin asset verification;
- real scheduler and authenticated browser journey twice from clean isolation;
- Chromium and WebKit screenshots, traces, accessibility and visual results;
- real OIDC tenant receipts;
- real CDN/purge receipts;
- hosted telemetry/error/alert receipts;
- managed retained cross-region restore receipt;
- two independent organiser attestations.

GitHub Actions currently creates `quality` and `secrets` jobs but fails before creating any step or log. This is an external runner/account failure and provides no application PASS or FAIL evidence.

The connected Vercel account has no linked MATCHDAY project or checkout, and the available connector cannot create a new project from this repository. It cannot substitute for the pinned validation environment.

## Required completion sequence

1. Freeze the final Gate B commit.
2. Deploy that exact commit to staging with the chosen identity, CDN, telemetry and managed database providers.
3. Collect all five external evidence files against that commit.
4. Run:

```bash
pnpm qa:gate-b:runner-self-test
pnpm qa:gate-b:external-self-test
pnpm qa:gate-b:external
bash scripts/run-gate-b-container.sh
```

5. Repair the first executable failure and rerun from clean isolation.
6. Repeat until every required check executes with zero failures and zero skips.
7. Issue `docs/qa/phase-4-final-verdict.md` only when the generated summary says exactly:

```text
Verdict: PASS
```

## Advancement rule

Gate B remains `BLOCKED`. No merge recommendation and no Gate C work are permitted until the exact no-skip PASS evidence exists.
