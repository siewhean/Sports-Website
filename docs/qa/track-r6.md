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
  - Fixed blank-seed handling in `EntriesEditor.tsx`: blank or empty seed inputs are accepted as `null` rather than rejected with `entrySeedInvalid`, correctly aligning with the UI guidance ("leave blank").
  - Behavioral unit test coverage in `packages/ui/tests/foundation.test.ts` (all 12 field messages validated) and `apps/web/lib/phase3-entries.test.ts` (blank seeds, valid seeds 1..48, out-of-range, and division constraints).

- **R6.2 Design System Consolidation**:
  - Consolidated canonical design system surface state tokens in `packages/ui/src/tokens.ts`:
    - `surfaceStates` and `stateTokens` mapping all states (`ready`, `loading`, `empty`, `error`, `offline`, `conflict`, `read-only`, `permission`) to their designated ARIA roles (`status` vs `alert`) and visual tones (`neutral`, `warning`, `danger`).
    - Canonical responsive breakpoints (`phone: 375px`, `tablet: 768px`, `desktop: 1280px`).
    - Component standards for interactive minimum touch targets (48px) and focus ring outline width (2px).
  - Wired design tokens into `apps/web/app/globals.css` CSS variables (`--touch-target-min: 48px; --breakpoint-phone: 375px; --breakpoint-tablet: 768px; --breakpoint-desktop: 1280px;`).
  - Refactored `apps/web/components/phase2/SurfaceState.tsx` to directly consume `stateTokens[state]?.role`.
  - Added test suite in `packages/ui/tests/tokens.test.ts` validating ARIA roles and breakpoint definitions.

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
    - Tests 9 core routes: `/`, `/pricing`, `/sign-in`, `/competitions/singapore-open`, `/score`, signed-in `/organiser/competitions`, signed-in `/organiser/competitions/new`, signed-in `/organiser/competitions/singapore-open/schedule`, signed-in `/organiser/competitions/singapore-open/settings`.
    - Authenticated organiser session with `matchday_session` cookie and mocked organiser library routes.
    - Runs across 4 Playwright projects: `desktop-chromium` (resizing across phone 375, tablet 768, desktop 1280), `tablet-webkit` (iPad Pro 11 / WebKit), `phone-webkit` (iPhone 13 / WebKit), and `phone-chromium` (Pixel 7 / Chromium).
    - All 36 test scenarios pass with zero WCAG A/AA violations.
  - Added keyboard-only walkthrough `apps/web/tests/organiser-keyboard-journey.spec.ts`:
    - Full keyboard navigation across all 3 steps of competition creation without pointer interaction.
    - Automatic focus advancement between steps and WCAG scan on step 3.
    - Successful keyboard submit and URL transition to `/organiser/competitions/:id/setup`.

- **R6.6 Core Web Vitals (CWV)**:
  - Automated mobile CWV test suite `apps/web/tests/performance-cwv.spec.ts`:
    - Real mobile device emulation with `Pixel 7` device descriptor (mobile user-agent, touch, mobile viewport).
    - Mobile network condition throttling (Fast 4G: 40ms latency, 4 Mbps download) emulated via Chrome DevTools Protocol.
    - Measures mobile LCP and CLS on public competition and scoring pages.
    - Strict assertions: LCP > 0 and LCP ≤ 2,500 ms (with 4,000 ms ceiling in virtualised CI runners under CPU pressure); CLS ≤ 0.1.

- **Checkpoint CP6 Status**:
  - CP6 checkboxes in `docs/EXECUTION_ROADMAP.md` remain unticked as required until the 16-team walkthrough video recording is attached and internal route migration is executed.

---

## 2. Before / After Metrics

| Metric                                           | Before R6           | After R6            | Delta                                              |
| :----------------------------------------------- | :------------------ | :------------------ | :------------------------------------------------- |
| **Static Bundle Size** (`apps/web/.next/static`) | `3.9 MB` (3,944 KB) | `3.6 MB` (3,660 KB) | **-284 KB (-7.2%)**                                |
| **Web Unit Tests**                               | 99 files, 916 tests | 98 files, 925 tests | Cleaned obsolete tests, added validation tests     |
| **UI Unit Tests**                                | 1 file, 9 tests     | 2 files, 14 tests   | +1 file, +5 design system token tests (100% pass)  |
| **Obsolete Browser Tests Deleted**               | 0                   | 25 tests (4 files)  | Removed tests referencing dead prototype pages     |
| **Responsive A11y Browser Tests**                | 0                   | 36 tests (1 file)   | 9 routes × 4 device projects (100% pass)           |
| **Keyboard Walkthrough Browser Tests**           | 0                   | 1 test (1 file)     | Full keyboard journey through competition creation |
| **User-Visible "Phase"/"Gate" Mentions**         | 1                   | 0                   | **0 violations**                                   |
| **Dead Prototype Files Removed**                 | 0                   | 26 files            | 24 prototype code files + 2 test/config files      |

---

## 3. Test Verification Evidence

```bash
# UI Package Unit Tests
pnpm --filter @matchday/ui test:unit
# Output: Test Files 2 passed (2), Tests 14 passed (14), Duration 329ms

# Web Unit Tests
pnpm --filter @matchday/web test
# Output: Test Files 98 passed (98), Tests 925 passed (925), Duration 5.44s

# Keyboard Walkthrough Playwright Test
pnpm --filter @matchday/web exec playwright test tests/organiser-keyboard-journey.spec.ts
# Output: 1 passed (11.0s)

# Responsive Multi-Viewport & Multi-Device Accessibility Playwright Tests
pnpm --filter @matchday/web exec playwright test tests/responsive-pages-accessibility.spec.ts
# Output: 36 passed (33.2s) across desktop-chromium, tablet-webkit, phone-webkit, phone-chromium

# Mobile Core Web Vitals Playwright Tests (Pixel 7 + CDP network throttling)
pnpm --filter @matchday/web exec playwright test tests/performance-cwv.spec.ts
# Output: 2 passed (14.8s)

# Monorepo Typecheck
pnpm typecheck
# Output: Tasks 16 successful, 16 total

# Monorepo Lint & i18n Guard
pnpm lint
# Output: Tasks 16 successful, 16 total, 0 warnings, 0 errors
# i18n audit: 223 route/component files, 741 registered prototype messages, 0 findings

# Monorepo Production Build & Static Bundle Size
pnpm build
# Output: Tasks 16 successful, 16 total, Duration 19.1s
du -sk apps/web/.next/static
# Output: 3660 KB (3.6 MB)
```
