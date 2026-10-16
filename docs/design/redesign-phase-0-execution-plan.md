# MATCHDAY — reviewed execution plan for phases 0 and 1

Status: **Phase 0 pre-implementation plan. Source implementation has not started.**
Reviewed 16 October 2026. The complete 674-line `IMPLEMENTATION_PLAN.md` was read, including later phases, checkpoints and owner decisions. Its newer decisions govern over conflicting examples in `PLAN.md`.

## Verified baseline and working boundary

- Fetched `origin/main`: `538cc48798cea626bea56aec9627243ff52044ab`, matching the document's baseline.
- Current checkout: clean `feat/r8-release-candidate-rehearsal-launch`, HEAD `1930ccd72a0b69a678aa507ccd3b530b5b2bfac5`. Preserve this release-candidate checkout. Relevant scheduling/theme files were checked against `origin/main`.
- Implementation will use isolated worktrees from the then-current main, one PR per phase: `redesign/p0-scheduling-safety`, then `redesign/p1-tokens-themes-help`.
- Phase 0 ships alone first. Phase 1 implementation follows owner merge of Phase 0; planning and review can proceed in parallel. No agent merges, force-pushes, deploys, changes provider settings or touches production data.
- Before edits, publish the phase plan in its draft PR and obtain independent reviewer approval, as section 7 requires. Use available specialist and independent reviewer agents; the document's named Opus/Fable models are not available through this session's agent tools. Do not claim those named-model reviews occurred.
- Do not mark a checkpoint complete without retained output or an exact-head hosted CI link. No tests or runtime verification have been performed during this planning review.

## Owner clarification incorporated

The owner clarified: **“The organiser can choose how much buffer slot they want to have per court per day.”**

Therefore buffer counts are independently configurable for each court and competition-local date. This supersedes the document's assumption that the existing single per-court setting already means per day. It also adds a small existing-editor/API/data change to Phase 0; Phase 0 is no longer backend-only and a migration is now expected.

Current code reserves N slots per court across the entire calendar. Do not silently multiply existing N by the number of days or rewrite published/archived schedules.

## Phase 0 — scheduling safety and daily buffers

### Outcome

An organiser can set buffers per court/day. Capacity totals and normal scheduling agree on those exact buffers. Started and finished matches retain their published court, start and end, including after court-hours changes. Drafts and job completion cannot silently change the public schedule.

### Implementation sequence

1. **Capture baseline and failing regressions first.** Use disposable infrastructure and the existing test harness. Record scheduler benchmark output on the same fixtures/runtime before changing code. Reproduce the unpublished-baseline bug, reserve leakage, started/finished movement, and a match starting between job submission and publication.
2. **Add explicit daily buffer configuration.** Preferred additive representation: nullable `playing_areas.daily_reserve_slots jsonb`, mapping local `YYYY-MM-DD` to a nonnegative integer. NULL preserves the existing aggregate-per-court mode; an object explicitly selects daily mode, with missing/new dates meaning zero. Old clients omitting the field preserve stored daily settings. Validate date keys/counts and competition/area ownership. Never attach the setting to replaceable availability-window rows or infer a daily fallback from the old aggregate count.
3. **Share canonical capacity/slot construction.** Expose one domain calculation for reserve identities and usable slots, used by both capacity summaries and the API/solver. Update SQL capacity consumers too: `phase3_available_match_slots` gates format capacity and recommendation provenance, while the underlying capacity calculation used by `phase4_setup_seed_values` seeds setup evidence. Trace the later wrappers before changing these functions; preserve their other checks. Existing domain/API builders differ in unavailable-window splitting and slot IDs, so preserve published placements and deliberately handle persisted slot identity compatibility. Group daily reserves by competition-local date, not UTC or each availability interval; test multiple windows and overnight/DST boundaries. Excess requested buffers must have an explicit capacity warning/validation outcome, never silently become usable solver slots.
4. **Expose the smallest organiser control.** Extend the existing `CapacityEditor` with an integer buffer count for each court/day, using existing styles and translated copy. Show legacy settings accurately; switching to daily settings is an explicit organiser save. No venue timeline redesign or manual selection of particular reserve slots in this phase. Saving capacity creates no automatic publication.
5. **Use the published baseline exclusively.** Audit all callers of `loadPreviousRevisionBaseline`; retrieve the latest published revision and deterministically handle none. Clear stale client-provided placement maps when the server has no published baseline. Keep an explicitly named draft helper only if a verified caller needs draft semantics.
6. **Model immutable historical placements end to end.** Extend API/domain/worker contracts and strict scheduler decoding for started/finished reasons. Use actual persisted states (`in_progress`, `final`, `corrected`) and canonical walkover/forfeit result paths, not invented state strings. Preserve exact published placement when its old slot falls outside new capacity. Historical occupancy must still block collisions/rest/dependency/official conflicts and must never become a slot another match can use. Return `FIXED_OUTSIDE_CAPACITY` with plain copy; retain rejection of stale ordinary user locks where appropriate. A historical match occupying newly designated buffer space is never moved or falsely reported as a free emergency slot; new assignments still cannot consume buffers.
7. **Close every mutation/race path.** Apply `409 MATCH_NOT_MOVABLE` to move validation and committed moves. Trace actual routes before promising a separate swap endpoint; if swapping is represented by multiple moves, protect both matches atomically. Recheck current states and published placements during solver acceptance/review and publication, using match-row locks in an order compatible with scoring. A competition lock alone does not serialize scoring. Reject stale proposals/results before any revision/projection write. Keep existing explicit organiser publication and idempotent replay behavior.
8. **Update fixtures, simulations and evidence.** Extend scenarios 5 and 7; add scenario 10 for reserves. Record before/after benchmark results; finish independent review and all required CI on the exact PR head.

### Files and migration

Verified existing source locations:

- `packages/domain/src/capacity.ts`, `packages/domain/src/schedule-constraints.ts`.
- `packages/contracts/src/phase-3.ts`, `packages/contracts/src/phase-4-schedule.ts`.
- `apps/api/src/phase-3-routes.ts`, `apps/api/src/phase-3-runtime.ts`.
- `apps/api/src/phase-4-runtime.ts`, `apps/api/src/phase-4-schedule-baseline.ts`.
- `apps/scheduler/src/domain-optimizer.ts` and applicable scheduler problem/contract adapters identified during route tracing.
- `apps/web/lib/phase3-capacity.ts`, `apps/web/components/phase3/CapacityEditor.tsx`, existing UI message catalogue.
- `apps/api/scripts/simulate-tournament.ts` and corresponding capacity/schedule tests.

Migration: `0075` is currently free; recheck at PR creation. Add the nullable setting without backfilling existing or archived rows and validate its shape. Update SQL `phase4_capacity_hash`, `phase3_available_match_slots`, and the underlying setup-capacity calculation feeding `phase4_setup_seed_values`, preserving subsequent wrapper behavior and recommendation-evidence trigger invariants. Preserve legacy hash behavior for NULL mode; daily edits must invalidate stale jobs. Test down/forward behavior and archived row checksums with the R8 replica fixture. For the additive nullable column, compare all original stored fields before/after and explicitly verify the new field remains NULL on archived rows; do not mistake a changed whole-row JSON shape for rewritten historical data. Do not reserve later migration numbers now.

### Acceptance evidence

- Unit/property: at least 200 reproducible random capacity cases; count and reserve identity agreement; zero new solver assignments in reserve slots; independent counts by court/day; explicit zero; multiple windows, unavailable intervals, DST, over-reservation and legacy compatibility.
- Domain/worker: strict reason decoding, immutable outside-grid occupancy, collision/rest/dependency/official constraints and persisted slot compatibility.
- Integration: started/final/corrected and exceptional outcomes unchanged; all exposed move/swap paths protected; no-published/newer-draft baseline cases; scoring-start-versus-publication race; old-client daily-setting preservation; capacity-save-without-publish projection unchanged; archived rows unchanged. Assert SQL/domain/API available-slot agreement in both daily and legacy modes, successful format recommendations and their provenance triggers, and setup seed totals after save/reload.
- Existing focused suites include `apps/api/tests/unit/phase-4-schedule-baseline.test.ts`, `apps/api/tests/integration/schedule-delay.test.ts`, `packages/domain/tests/phase-3-capacity.test.ts`, `packages/domain/tests/phase-4-schedule-constraints.test.ts`, and `apps/scheduler/tests/unit/qa-012-schedule-matrix.test.ts`.
- Simulations: scenarios 5/7 extended and new 10, then fast profile all scenarios; zero unexpected HTTP 5xx with retained logs.
- `pnpm bench:scheduler`: comparable before/after measurements, regression no greater than 10%. This command writes QA reports; run it only in the isolated implementation checkout.
- Because daily inputs add UI scope, keyboard/label/error checks, screenshots and axe at 375/768/1280 in Dark and Light also apply to the touched editor.

## Phase 1 — four accent families, themes and contextual help

### Outcome

Keep MATCHDAY's identity with lime actions, red errors, blue information/live and amber warnings. Both themes meet the specified contrast targets. A clean profile starts Dark; saved preference is applied before paint. Help works with mouse, touch and keyboard.

### Implementation sequence

1. **Define canonical tokens and pair coverage.** Update CSS and TypeScript tokens together, with consistency checks. Base-derived neutrals and accent-derived variants use valid `color-mix(in oklab, ...)`. Separate interactive control borders from decorative lines. Remove separate success/pitch hues while retaining compatibility aliases mapped to approved families until consumers are converted. Recompute actual contrast; do not copy older `PLAN.md` success/pitch/lime-live values or ratios as proof.
2. **Convert all affected consumers.** Audit CSS modules, inline styles, gradients and alpha values across the prescribed scan roots. Include QR generation in `AccessPassManager.tsx` and generated OG images: those consumers need canonical concrete colors, not unresolved CSS variables. Preserve their behavior and test contrast/readability. No broad allowlist hiding existing violations.
3. **Make one theme resolver.** Reuse `matchday-theme` and validated `dark|light|system` values; use cookie plus localStorage, with Dark fallback. Render server theme from the cookie, then reconcile local preference/system mode before paint. Handle denied storage, invalid values, hydration and system changes. The layout already renders per request; preserve existing caching/security behavior.
4. **Preserve CSP.** Bootstrap script receives the existing `x-nonce`; do not weaken `script-src` or add `unsafe-inline`. Check the nonce-bearing document and `theme-color` behavior in the production build harness. A DOMContentLoaded screenshot alone is insufficient: inspect initial HTML/bootstrap state and capture observable initial paint with delayed hydration.
5. **Reuse the existing theme control.** Add a small shared account/preferences disclosure in `SiteChrome` and `ProductionShell`; no existing account menu was found. Preserve authenticated organiser navigation and anonymous sign-in from `IdentityStatus`. No database preference sync/migration is planned.
6. **Add `InfoTip` and `PageHelp` in web foundation.** Use shared UI messages. InfoTip has an accessible name, stable description association, hover/focus persistence, tap and Enter/Space activation, Escape and outside dismissal. No required task information or interactive controls live only in a tooltip. PageHelp supplies the one-line primitive; page-count/copy enforcement remains Phase 2.
7. **Enforce palette rules and test.** Add checker, fixture tests and an initially empty reviewed exception file; run it in `quality-fast` without weakening any existing gate. Parse color-bearing source/declaration contexts rather than matching English words. Check aliases, fallbacks/cycles, hex/rgb/hsl/oklch/named colors, gradients and alpha; test fifth accents fail. Validate derivation families, not numerically identical hue after mixing. Use existing dependencies; a new parser dependency, if actually required, is a documented review point rather than an implicit install.
8. **Capture visual/runtime evidence and independent QA.** Build the shared UI package before browser tests. Extend existing mobile project match filters so new specs actually execute on phones/tablets. Retain all six viewport/theme screenshot sets, contrast ratios and console/page-error output. Update visual baselines only after reviewing intended changes; absent Linux baselines or an informational visual job do not prove visual acceptance.

### Files

- `apps/web/app/globals.css`, `packages/ui/src/tokens.ts`, `packages/ui/tests/tokens.test.ts`.
- `apps/web/app/layout.tsx`, `apps/web/components/foundation/ThemeControl.tsx`.
- `apps/web/components/foundation/SiteChrome.tsx`, `ProductionShell.tsx`, `IdentityStatus.tsx`.
- New foundation `InfoTip.tsx`, `PageHelp.tsx`, shared preference/disclosure helpers and focused tests.
- `packages/ui/src/i18n.ts` for applicable rendered messages; affected CSS/modules/image-color consumers.
- New `scripts/check-palette.mjs`, fixture tests, `scripts/palette-allowlist.json`; `.github/workflows/ci.yml` adds the required checker step.
- `apps/web/playwright.config.ts`, existing `responsive-pages-accessibility.spec.ts`, new theme/help specs and reviewed visual baselines.

Read relevant installed Next.js documentation under `apps/web/node_modules/next/dist/docs/` before web edits, as `apps/web/AGENTS.md` requires. If package resolution differs, resolve that installed Next package first.

### Acceptance evidence

- Both themes: every enumerated text/background pair at least 4.5:1; interactive border/icon pairs at least 3:1; list computed pairs/ratios and relevant rendered backgrounds.
- Palette fixtures: stray magenta/fifth accent fail; approved base/accent derivations and valid `color-mix(in oklab, ...)` pass; invalid/unresolved derivations fail with useful locations.
- Clean profile Dark, persistence after reload, Same-as-device changes, invalid/blocked storage handling, matching bootstrap/hydration and changing browser theme-color.
- InfoTip hover, keyboard, touch and dismissal, with no console/page errors.
- Axe with WCAG 2.2 AA/target-size coverage on **all organiser, official and public routes**, at 375/768/1280 in both themes. Inventory those routes with appropriate authenticated/public fixtures; global token changes affect every route. Retain the required screenshots for changed screens and the full original checkpoint coverage rather than selecting only representative routes.

## Shared validation, review and rollout

The **complete original section 6.2 global checklist and section 6.3 Phase 0/1 checkpoints remain required**, including archived-data preservation, evidence-script truth, drag alternatives where applicable, secret/fixture review, truthful roadmap status and all route/theme/viewport coverage. This document adds details and the owner-requested daily-buffer coverage; its shorter command list does not replace or reduce any original gate. The explicitly stated unflagged rollout exceptions below are recorded as such.

Use the repository-pinned Node 24 and pnpm 10.33 toolchain. Before final certification run source gates, migrations/integration against disposable C-locale Postgres and Mailpit, production build, both browser shards, real Gate D, and tournament simulation. Retain exact commands, logs, head/tree and CI links. Global implementation checks include `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm openapi:check`, `pnpm secrets:scan`, `pnpm build`, `RUN_INFRA_TESTS=1 pnpm test:integration`, and `pnpm simulate:tournament --profile=fast`, using the existing harness/configuration. Phase 1 adds the palette checker and theme/help/visual evidence.

An independent reviewer checks the plan before edits and the final implementation/checkpoints after tests, including terminal and browser errors. Existing required checks remain enabled. Do not treat demo browser tests, mocks or a green workflow as deployment, production or physical-device proof.

Specific rollout text governs the generic flag checklist: Phase 0 safety corrections and Phase 1 global token/contrast changes are explicitly unflagged. Record those exceptions in the PR checkpoint table instead of inventing unused flags or enabling later-phase features. Additional daily-buffer configuration is additive and requires an explicit organiser save; it does not silently rewrite existing settings or schedules.

## Findings from the rest of the document — outside phases 0 and 1

- D36 and Phase 12's checkpoints say captain management is view/withdraw only, but a magic-link bullet still says view/edit and the route list includes PATCH. Align those sections to the binding view-only decision before Phase 12 code.
- D34 contains creation-date wording, while Phase 4 specifies start-date selection. Make the start-date rule consistent before Phase 4; do not change sport defaults in this work.
- O16/D37 remains unconfirmed. Do not silently implement the proposed two-year retention. It does not block phases 0 or 1.
- Primary federation verification remains a Phase 4 release gate; this review does not certify the cited rules or legal coverage.
- Phase 9 still requires owner-approved timing/approval ADR; Phase 12 production enablement still requires recorded owner legal review.
- Reconcile the generic feature-flag rule with the explicit Phase 0/1 exceptions in the phase PRs, and treat older prototype examples as superseded where later decisions differ.

## Current status

Owner authorized implementation on 16 October 2026. This document is published before Phase 0 code, for independent draft-PR plan review. The release-candidate checkout is preserved. No source implementation or live action has been performed at this plan commit.
