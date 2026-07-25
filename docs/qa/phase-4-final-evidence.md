# Phase 4 historical evidence manifest

Status: **HISTORICAL/SUPERSEDED**

Local validation: HISTORICAL PASS — NOT ACTIVE

Hosted GitHub Actions: Not executed because Actions allowance is unavailable

This schema-1 record is retained for audit history only. It was superseded by
changed Gate B source and must not be used as an active release-gate verdict.
Current certification requires a schema-v2 exact-SHA evidence bundle.

Validated source: `c87287f1acad2c1f2a51e374bbe8f4ab6f58d7ee`

Branch: `codex/gate-b-lockfile-integrity`

The historical machine-readable record is
[`phase-4-final-evidence.json`](./phase-4-final-evidence.json). Raw logs and
browser artifacts are retained under the ignored local directory
`artifacts/qa/gate-b-final-c87287f/`; the manifest binds them with SHA-256
digests and contains no credentials, database contents or browser session
material.

## Historical executed acceptance

- Pinned Node 24.18.0 and pnpm 10.33.0; frozen installation and unchanged
  lockfile passed.
- Formatting, lint, TypeScript, 684 unit tests, 27 forward migrations,
  backup/restore, and the complete infrastructure-enabled integration command
  passed. The database package passed 54/54 tests.
- The production dependency audit found no known vulnerabilities. OpenAPI,
  secrets, production build, deploy manifest and 54-asset origin delivery
  checks passed.
- Generic E2E passed 274 tests. The embedded real matrix passed another 3/3
  complete browser-owned organiser journeys.
- Accessibility passed 68/68 with zero WCAG A/AA violations. Visual comparison
  passed 13/13 with no unmatched diffs.
- Two additional clean-isolation real Gate B runs passed 3/3 each across phone
  Chromium, tablet WebKit and desktop Chromium. Each run created fresh database,
  Redis and process isolation; all three database oracles passed and Redis
  cleanup deleted 15/15 inspected queue keys.
- The previously marginal populated-upgrade test passed five uncached runs:
  minimum 1.07 s, median 1.09 s, maximum 1.11 s, against a narrowly scoped 15 s
  timeout on PostgreSQL 18.4 with no concurrent load.
- `git diff --check` and `pnpm check` passed.

The generic E2E matrix reports nine project-applicability omissions where a
case deliberately declares a narrower browser or viewport matrix. Every
browser required by those cases executed; no Gate B requirement was skipped.
The fail-closed command ledger therefore records zero skipped required checks.

Initial diagnostic attempts are retained, not rewritten: non-interactive pnpm
needed `CI=1`; the clean-output preflight found ignored output from prior work;
and the sandbox denied process or loopback operations for OpenAPI and asset
origin checks. The unchanged canonical commands subsequently passed under the
pinned local environment.

## Browser evidence boundary

Demo-backed fixtures provide stable visual regression. The real full-stack E2E
proves browser-owned decisions, BFF/API integration, database lineage, public
publication and Redis cleanup. These are complementary evidence, not identical
proof.

## Accepted non-blocking risks

- P2 — Sticky action rails may obscure intermediate phone/tablet content.
  Reachability and overflow checks pass. Owner: Frontend UX. Target: before the
  Gate C browser verdict.
- P3 — Some Phase 3 snapshot filenames overstate native-project coverage.
  Owner: QA Automation. Target: before the Gate C visual verdict.
- P3 — The scoped `next>sharp = 0.35.3` override remains. Production audit,
  build and image regressions pass. Owner: Platform Dependency. Target: the next
  stable dependency update.

Do not run the active schema-v2 gate against this historical file. A new
candidate must retain its immutable bundle and generated manifest under
`artifacts/qa/gate-b/<HEAD SHA>/`, then run:

```sh
pnpm evidence:phase4:validate
```
