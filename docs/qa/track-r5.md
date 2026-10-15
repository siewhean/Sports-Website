# QA Record: Track R5 — Monitoring, Alerting, Operations

- **Branch**: `feat/r5-monitoring-alerting-operations`
- **Scope**: Deliverables R5.1–R5.7; CP5 verification baseline; PR triage; `RENDER_API_ORIGIN` removal.
- **Date**: 2026-10-14
- **Operator**: Agentic Pair Programmer

---

## 1. Requirement Traceability

| ID       | Description                     | Implementation Artefacts                                                    | Verification                                                                                  |
| :------- | :------------------------------ | :-------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| **R5.1** | Better Stack uptime monitors    | `docs/runbooks/uptime-monitoring.md`                                        | API ready (`/health/ready`), public competition page, web home checks codified                |
| **R5.2** | Backup heartbeat                | `infra/oci/backup/matchday-backup.sh`, `docs/runbooks/uptime-monitoring.md` | `BACKUP_HEARTBEAT_URL` integration; 24h interval / 2h grace                                   |
| **R5.3** | Sentry alert rules              | `docs/operations/SENTRY.md`                                                 | Issue alerts (production first seen), metric alerts (>20 errors / 5 min), fatal/DLQ alerts    |
| **R5.4** | Status page in site footer      | `apps/web/components/foundation/SiteChrome.tsx`                             | Wire `NEXT_PUBLIC_STATUS_PAGE_URL` with external rel/target; tested in `site-chrome.test.tsx` |
| **R5.5** | Housekeeping: RENDER_API_ORIGIN | `apps/web/lib/*`, `next.config.ts`, `turbo.json`, `VERCEL_PREVIEW.md`       | Standardized on `API_ORIGIN` & `MATCHDAY_API_BASE_URL`; all web tests pass                    |
| **R5.5** | Housekeeping: Upstash DB        | `docs/operations/UPSTASH_CLEANUP.md`                                        | Step-by-step deletion and credential purge runbook                                            |
| **R5.5** | Housekeeping: Stale PRs         | GitHub CLI batch closure                                                    | 19 PRs closed (#7–#19, #55, #57, #58, #67–#70, #94–#96) with auditable notes                  |
| **R5.5** | Housekeeping: Untracked scripts | `docs/operations/LAUNCH_CHECKLIST.md`                                       | Confirmed absence of `production-certification.spec.ts` & `issue-pass-oci.cjs`                |
| **R5.6** | Quarterly restore drill         | `docs/operations/RESTORE_DRILL_LOG.md`                                      | Scheduled first drill 10 January 2027 using `infra/oci/backup/restore-drill.sh`               |
| **R5.7** | Offline backup key guidance     | `docs/operations/OFFLINE_KEYS.md`                                           | Redundant offline media protocol (2 distinct physical locations)                              |

---

## 2. Changed Files

### Application & Configuration

- `apps/web/components/foundation/SiteChrome.tsx`: Added `statusHref` reading `NEXT_PUBLIC_STATUS_PAGE_URL` with external link attributes.
- `apps/web/lib/casual-bff.server.ts`: Removed `RENDER_API_ORIGIN` fallback.
- `apps/web/lib/identity-session.server.ts`: Replaced `RENDER_API_ORIGIN` with `API_ORIGIN`.
- `apps/web/lib/phase2-public.server.ts`: Replaced `RENDER_API_ORIGIN` with `API_ORIGIN`.
- `apps/web/lib/public-versions-bff.server.ts`: Replaced `RENDER_API_ORIGIN` with `API_ORIGIN`.
- `apps/web/next.config.ts`: Updated `apiOrigin()` default parameter to `API_ORIGIN ?? MATCHDAY_API_BASE_URL`.
- `turbo.json`: Removed `RENDER_API_ORIGIN` from build task environment inputs.

### Tests

- `apps/web/tests/unit/site-chrome.test.tsx`: Unit tests verifying internal fallback and external status page links.
- `apps/web/tests/unit/casual-bff.test.ts`: Cleaned up `RENDER_API_ORIGIN` environment stubs.
- `apps/web/tests/unit/next-config.test.ts`: Cleaned up `RENDER_API_ORIGIN` and tested `MATCHDAY_API_BASE_URL` fallback.
- `apps/web/tests/unit/public-versions-bff.test.ts`: Cleaned up `RENDER_API_ORIGIN` environment stubs.

### Documentation & Operations

- `docs/operations/SENTRY.md`: Expanded with concrete alert rule definitions, thresholds, filters, and staging verification.
- `docs/operations/UPSTASH_CLEANUP.md`: Runbook for decommissioning unused Upstash Redis instance.
- `docs/operations/RESTORE_DRILL_LOG.md`: Schedule and protocol for quarterly database restore rehearsals.
- `docs/operations/OFFLINE_KEYS.md`: Protocol for storing `~/matchday-backup.agekey` offline across two locations.
- `docs/operations/VERCEL_PREVIEW.md`: Updated noting `RENDER_API_ORIGIN` retirement.
- `docs/operations/LAUNCH_CHECKLIST.md`: Documented resolution of untracked scripts.
- `docs/runbooks/uptime-monitoring.md`: Updated for Better Stack monitors, heartbeat, and status page.
- `docs/EXECUTION_ROADMAP.md`: Updated Track R5 deliverables and checked off CP5 open PR criterion.

---

## 3. Verification Evidence

### Web Unit Tests

- Command: `pnpm --filter @matchday/web test`
- Result: 100/100 test files passed (918 tests passed, 0 failures).

### PR Housekeeping Verification

- Executed `gh pr close` with specific notes across 19 PRs.
- `gh pr list --state open` confirmed only active PRs remain (#100, #102, #103, #104–#108, #109, #110, #111).

---

## 4. Residual Risks & Next Actions

- **Owner Action**: Verify/delete `RENDER_API_ORIGIN` from Vercel Project Settings > Environment Variables.
- **Owner Action**: Delete legacy Upstash Redis database via console.upstash.com.
- **Owner Action**: Sign up / configure Better Stack checks and status page using URLs in `docs/runbooks/uptime-monitoring.md`.
- **Owner Action**: Store `~/matchday-backup.agekey` in two offline locations and record confirmation in CP5.
