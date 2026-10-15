# Track R6 QA Audit Report: Organiser UX, Design System, and Code Health

**Date:** 15 October 2026  
**Scope:** Track R6 (Deliverables R6.1–R6.6, Checkpoint CP6)  
**Branch:** `feat/r6-organiser-ux-design-system-code-health`

---

## 1. Summary of Changes

- **R6.1 Organiser Journey Error Messaging & Form Validation**:
  - Replaced generic `"Check this field."` and `"Check the highlighted competition detail."` messages with field-specific guidance naming both the field and the required remedy.
  - Enforced compile-time exhaustiveness: `CompetitionCreateFieldKey` (all 12 fields) strictly typed in `packages/ui/src/i18n.ts` and `CompetitionCreateForm.tsx`, eliminating any generic fallback (`fieldErrorMessage(field)` directly indexes `messages.organiserCreate.fieldErrors[field]`).
  - Added pure validation helpers `validateDivisionInput` and `validateEntryInput` in `apps/web/lib/phase3-entries.ts` with field-and-fix error messages (`divisionNameRequired`, `divisionLimitInvalid`, `entryNameRequired`, `entrySeedInvalid`).
  - Fixed blank-seed handling in `EntriesEditor.tsx`: the entry form is `noValidate` and the seed is optional, so a blank seed reaches `validateEntryInput` and is sent as `seed: null` (accepted by the API). Browser proof: `apps/web/tests/entries-blank-seed.spec.ts`.
  - The free-plan entry limit is enforced by the server only (`FREE_ENTRY_LIMIT_REACHED`, 422); the editor shows the server's error instead of pre-empting the request, which `phase-3-responsive.spec.ts` exercises (18 writes, 16 accepted).
  - Behavioral unit test coverage in `packages/ui/tests/foundation.test.ts` (all 12 field messages validated) and `apps/web/lib/phase3-entries.test.ts` (blank seeds, valid seeds 1..48, out-of-range, and division constraints).

- **R6.2 Design System Consolidation**:
  - Consolidated canonical design system surface state tokens in `packages/ui/src/tokens.ts`:
    - `surfaceStates` and `stateTokens` mapping all states (`ready`, `loading`, `empty`, `error`, `offline`, `conflict`, `read-only`, `permission`) to ARIA roles and tones. Contract: only `error` is `role="alert"`; recoverable states (`offline`, `conflict`, `read-only`, `permission`) are `role="status"` with a `warning`/`neutral` tone.
    - Canonical responsive breakpoints (`phone: 375px`, `tablet: 768px`, `desktop: 1280px`) live in TypeScript only; CSS custom properties cannot be used in `@media` conditions, so no `--breakpoint-*` variables are declared.
    - Component standards for minimum touch targets (48px), radii (6/10/16/9999px) and focus rings (2px width, 2px offset).
  - `apps/web/app/globals.css` declares `--touch-target-min`, `--radius-sm|md|lg|full`, `--focus-ring-width` and `--focus-ring-offset`, and they are consumed: 98 value-identical declarations across 26 CSS files now use them (37 touch-target minimums, 35 radii, 6 focus-ring widths, 20 focus-ring offsets). Declarations with other values (e.g. fixed `width: 48px`, compound radii) were left alone, so nothing changes visually.
  - `apps/web/components/phase2/SurfaceState.tsx` consumes `stateTokens[state]?.role`; `apps/web/tests/unit/surface-state-roles.test.ts` checks the rendered role for every state.
  - `packages/ui/tests/tokens.test.ts` checks the role contract and breakpoint definitions.

- **R6.3 Internal Phase/Gate URLs (Deferred / Not Done)**:
  - Replaced user-facing phase/gate references across UI text (e.g. `"Phase 3 capacity service"` → `"venue capacity service"`).
  - Product route rewrites and re-exports were removed per audit feedback since frontend call sites continue to use internal phase/gate API routes; R6.3 is marked as Not Done / Deferred on the roadmap until frontend call sites migrate in a dedicated pass.

- **R6.4 Dead Prototype Code Elimination**:
  - Removed obsolete prototype routes: `apps/web/app/format/page.tsx`, `apps/web/app/score/prototype/page.tsx`, `apps/web/app/setup/page.tsx`.
  - Removed prototype components: `FormatDesignerPrototype.tsx` (+CSS), `ScorekeeperPrototype.tsx` (+CSS), `AssistedSetupPrototype.tsx` (+CSS), `PrototypeShell.tsx` (+CSS), `prototype/`, `scorekeeper/`.
  - Cleaned broken references in `apps/web/app/organiser/page.tsx` (removed dead `/format` demo link), `robots.ts` (removed disallowed dead prototype paths), `ConsentManager.tsx`, and `playwright.config.ts` (removed polling of deleted `/setup`).
  - Deleted 25 obsolete browser tests across 4 deleted test files (`prototypes.spec.ts` [10], `scorekeeper-phase0.spec.ts` [3], `format-designer-interactions.spec.ts` [6], `assisted-setup.spec.ts` [6]) and deleted `playwright.format-designer.config.ts`.
  - Removed 4 obsolete prototype unit tests (`scorekeeper-events.test.ts`).

- **R6.5 Multi-Viewport & Multi-Device Accessibility (WCAG A/AA) & Walkthrough**:
  - Added multi-viewport automated accessibility test suite `apps/web/tests/responsive-pages-accessibility.spec.ts`:
    - Tests 9 core routes: `/`, `/pricing`, `/sign-in`, `/competitions/singapore-open`, `/score`, and four organiser routes (`/organiser/competitions`, `/organiser/competitions/new`, `/organiser/competitions/singapore-open/schedule`, `/organiser/competitions/singapore-open/settings`).
    - **The organiser routes are demo-fixture coverage, not signed-in coverage.** The browser-e2e webServer runs with `MATCHDAY_ALLOW_DEMO_FIXTURES=1` and `MATCHDAY_PHASE2_DATA_MODE=demo`, so those pages render from fixtures without a session. The earlier session cookie and server-side route mock had no effect and were removed. The only mock left is the client-side organisation list fetch on `/organiser/competitions/new`. Signed-in, real-API organiser journeys are covered by the real-API Playwright configs, not by this suite.
    - Runs across 4 Playwright projects: `desktop-chromium` (resizing across phone 375, tablet 768, desktop 1280), `tablet-webkit` (iPad Pro 11 / WebKit), `phone-webkit` (iPhone 13 / WebKit), and `phone-chromium` (Pixel 7 / Chromium).
    - 36 scenarios (9 routes × 4 projects); all passed locally with zero WCAG A/AA violations.
  - Added keyboard-only walkthrough `apps/web/tests/organiser-keyboard-journey.spec.ts` (demo fixtures, with the create-competition POST mocked in the browser):
    - Full keyboard navigation across all 3 steps of competition creation without pointer interaction.
    - Automatic focus advancement between steps and WCAG scan on step 3.
    - Successful keyboard submit and URL transition to `/organiser/competitions/:id/setup`.

- **R6.6 Core Web Vitals (CWV)**:
  - Automated mobile CWV test suite `apps/web/tests/performance-cwv.spec.ts`:
    - Real mobile device emulation with `Pixel 7` device descriptor (mobile user-agent, touch, mobile viewport).
    - Mobile network condition throttling (Fast 4G: 40ms latency, 4 Mbps download) emulated via Chrome DevTools Protocol.
    - Measures mobile LCP and CLS on the public competition and scoring pages, and logs `[cwv]` values to the run output.
    - CLS must be ≤ 0.1 (web.dev "good") everywhere. LCP must be ≤ 2,500 ms ("good") on local runs only; on CI the limit is a 4,000 ms regression ceiling. **CI therefore does not certify "good" LCP.** R6.6's LCP half stays unproven until it is measured on representative hardware or in field data.
  - CLS fix: on CI the public competition page measured CLS 0.148. The cause was the Geist font swap. next/font's generated `GeistSans Fallback` face only tries `local(Arial)`, and Linux has no Arial, so text first painted in a wide, unadjusted system font and reflowed when Geist loaded. `globals.css` now adds a `Geist Metric Fallback` face (Arial → Liberation Sans → Arimo, all Arial-metric-compatible) with the same overrides, ahead of the generic families in `--font-sans`. A local reproduction (fallback face disabled, wide generic font substituted, Geist delayed 1.5 s) measured CLS 0.1487 without the face and 0.0006 with it. The final CI value is in the PR checks. Android (Roboto, no Arial-compatible face) is not covered by this fallback.

- **Checkpoint CP6 Status**:
  - CP6 checkboxes in `docs/EXECUTION_ROADMAP.md` remain unticked as required until the 16-team walkthrough video recording is attached and internal route migration is executed.

---

## 2. Before / After Metrics

**Local measurement** on macOS, Node 24.18.0, clean `apps/web/.next` per build, with `APP_ENV=test CI=1 pnpm exec turbo run build --filter=@matchday/web` (the same build env as the CI browser-e2e job). Before = merge base `b4af90e4`; after = `cd2e8ea5`, 15 October 2026. These numbers are not taken from a CI log. The CI e2e pass counts are in the PR's browser-e2e check runs.

| Metric                                                        | Before (`b4af90e4`) | After (`cd2e8ea5`)  | Delta                                          |
| :------------------------------------------------------------ | :------------------ | :------------------ | :--------------------------------------------- |
| **Static bundle** (`du -sk apps/web/.next/static`)            | 4,080 KB            | 3,660 KB            | **-420 KB (-10.3%)**                           |
| **Web unit tests** (`pnpm --filter @matchday/web test`)       | 99 files, 926 tests | 99 files, 932 tests | +6 (prototype tests removed, validation added) |
| **UI unit tests** (`pnpm --filter @matchday/ui test:unit`)    | 1 file, 8 tests     | 2 files, 14 tests   | +1 file, +6 tests                              |
| **Playwright tests listed** (default config, visual excluded) | 421 tests, 34 files | 434 tests, 34 files | +13 (4 prototype files deleted, 4 files added) |
| **`@a11y`-tagged Playwright tests** (all projects)            | 141 tests           | 173 tests           | +32                                            |
| **User-visible "Phase"/"Gate" mentions**                      | 1                   | 0                   | URLs and internal API routes unchanged (R6.3)  |

---

## 3. Test Verification Evidence (local, `cd2e8ea5`)

```bash
pnpm format:check                       # All matched files use Prettier code style
pnpm lint                               # Tasks 16 successful, 16 total
pnpm typecheck                          # Tasks 16 successful, 16 total
pnpm --filter @matchday/web test        # Test Files 99 passed (99), Tests 932 passed (932)
pnpm --filter @matchday/ui test:unit    # Test Files 2 passed (2), Tests 14 passed (14)

# Built with APP_ENV=test; Playwright run with CI=1 against `pnpm start`
pnpm --filter @matchday/web exec playwright test tests/responsive-pages-accessibility.spec.ts \
  tests/phase-3-responsive.spec.ts tests/entries-blank-seed.spec.ts \
  tests/organiser-keyboard-journey.spec.ts tests/performance-cwv.spec.ts
# 64 passed (all four projects)
```
