# Track R6 QA Audit Report: Organiser UX, Design System, and Code Health

**Date:** 15 October 2026  
**Scope:** Track R6 (Deliverables R6.1–R6.6, Checkpoint CP6)  
**Branch:** `feat/r6-organiser-ux-design-system-code-health`

---

## 1. Summary of Changes

- **R6.1 Organiser Journey Error Messaging**:
  - Replaced generic `"Check this field."` and `"Check the highlighted competition detail."` messages with field-specific guidance naming both the field and the required remedy.
  - Enforced compile-time exhaustiveness: `CompetitionCreateFieldKey` (all 12 fields) strictly typed in `packages/ui/src/i18n.ts` and `CompetitionCreateForm.tsx`, eliminating any generic fallback (`fieldErrorMessage(field)` directly indexes `messages.organiserCreate.fieldErrors[field]`).
  - Added field-and-fix error messages in `apps/web/lib/phase3-entries.ts` (`divisionNameRequired`, `divisionLimitInvalid`, `entryNameRequired`, `entrySeedInvalid`) and client-side inline validation to `EntriesEditor.tsx`.
  - Comprehensive unit test coverage in `packages/ui/tests/foundation.test.ts` (all 12 field messages validated) and `apps/web/lib/phase3-entries.test.ts`.

- **R6.2 Design System Consolidation**:
  - Consolidated canonical design system surface state tokens in `packages/ui/src/tokens.ts`:
    - `surfaceStates` and `stateTokens` mapping all states (`ready`, `loading`, `empty`, `error`, `offline`, `conflict`, `read-only`, `permission`) to their designated ARIA roles (`status` vs `alert`) and visual tones (`neutral`, `warning`, `danger`).
    - Canonical responsive breakpoints (`phone: 375px`, `tablet: 768px`, `desktop: 1280px`).
    - Component standards for interactive minimum touch targets (44px) and focus ring outline width (2px).
  - Refactored `apps/web/components/phase2/SurfaceState.tsx` to directly consume `stateTokens[state]?.role`.
  - Added test suite in `packages/ui/tests/tokens.test.ts` validating ARIA roles and breakpoint definitions.

- **R6.3 Clean URLs & Phase/Gate Route Aliasing**:
  - Replaced user-facing phase/gate references across UI text (e.g. `"Phase 3 capacity service"` → `"venue capacity service"`).
  - Modernised internal API route mapping with backward-compatible Next.js route rewrites in `apps/web/next.config.ts`:
    - Clean product paths (`/api/competitions/:id/*`, `/api/schedule/*`, `/api/organisations/*`, `/api/format-revisions/*`, `/api/admin/*`) rewrite to existing backend handlers.
    - Exported `productRouteRewrites` and added handler re-exports in `apps/web/app/api/competitions/route.ts` and `apps/web/app/api/organisations/bootstrap/route.ts`.
    - Preserved legacy `/api/phase3/*` and `/api/phase4/*` routes for backward compatibility.
    - Added unit test suite `apps/web/tests/unit/product-routes.test.ts`.

- **R6.4 Dead Prototype Code Elimination**:
  - Removed obsolete prototype routes: `apps/web/app/format/page.tsx`, `apps/web/app/score/prototype/page.tsx`, `apps/web/app/setup/page.tsx`.
  - Removed prototype components: `FormatDesignerPrototype.tsx` (+CSS), `ScorekeeperPrototype.tsx` (+CSS), `AssistedSetupPrototype.tsx` (+CSS), `PrototypeShell.tsx` (+CSS), `prototype/`, `scorekeeper/`.
  - Cleaned broken references in `apps/web/app/organiser/page.tsx` (removed dead `/format` demo link), `robots.ts` (removed disallowed dead prototype paths), `ConsentManager.tsx`, and `playwright.config.ts` (removed polling of deleted `/setup`).
  - Deleted 25 obsolete browser tests across 4 deleted test files (`prototypes.spec.ts` [10], `scorekeeper-phase0.spec.ts` [3], `format-designer-interactions.spec.ts` [6], `assisted-setup.spec.ts` [6]) and deleted `playwright.format-designer.config.ts`.
  - Removed 4 obsolete prototype unit tests (`scorekeeper-events.test.ts`).

- **R6.5 Multi-Viewport Accessibility (WCAG A/AA) & Walkthrough**:
  - Added multi-viewport automated accessibility test suite `apps/web/tests/responsive-pages-accessibility.spec.ts`:
    - Tests 3 viewports: phone (375x667), tablet (768x1024), desktop (1280x800).
    - Tests 9 core routes: `/`, `/pricing`, `/sign-in`, `/competitions/singapore-open`, `/score`, `/organiser/competitions`, `/organiser/competitions/new`, `/organiser/competitions/singapore-open/schedule`, `/organiser/competitions/singapore-open/settings`.
    - All 27 test scenarios pass with zero WCAG A/AA violations.
  - Added keyboard-only walkthrough `apps/web/tests/organiser-keyboard-journey.spec.ts`:
    - Full keyboard navigation across all 3 steps of competition creation without pointer interaction.
    - Automatic focus advancement between steps and WCAG scan on step 3.
    - Successful keyboard submit and URL transition to `/organiser/competitions/:id/setup`.

- **R6.6 Core Web Vitals (CWV)**:
  - Automated mobile CWV test suite `apps/web/tests/performance-cwv.spec.ts`:
    - Measures mobile LCP and CLS on public competition and scoring pages.
    - Strict assertions: LCP > 0 and LCP ≤ 2,500 ms; CLS < 0.1 (no conditional bypass).

- **Checkpoint CP6 Status**:
  - CP6 checkboxes in `docs/EXECUTION_ROADMAP.md` have been unticked as required until the organiser walkthrough video recording is attached.

---

## 2. Before / After Metrics

| Metric                                           | Before R6           | After R6            | Delta                                              |
| :----------------------------------------------- | :------------------ | :------------------ | :------------------------------------------------- |
| **Static Bundle Size** (`apps/web/.next/static`) | `3.9 MB` (3,944 KB) | `3.6 MB` (3,640 KB) | **-304 KB (-7.7%)**                                |
| **Web Unit Tests**                               | 99 files, 916 tests | 99 files, 915 tests | Cleaned obsolete tests, added product routes tests |
| **UI Unit Tests**                                | 1 file, 9 tests     | 2 files, 14 tests   | +1 file, +5 design system token tests (100% pass)  |
| **Obsolete Browser Tests Deleted**               | 0                   | 25 tests (4 files)  | Removed tests referencing dead prototype pages     |
| **Responsive A11y Browser Tests**                | 0                   | 27 tests (1 file)   | 9 routes × 3 viewports (100% pass, 0 violations)   |
| **Keyboard Walkthrough Browser Tests**           | 0                   | 1 test (1 file)     | Full keyboard journey through competition creation |
| **User-Visible "Phase"/"Gate" Mentions**         | 1                   | 0                   | **0 violations**                                   |
| **Dead Prototype Files Removed**                 | 0                   | 26 files            | 24 prototype code files + 2 test/config files      |

---

## 3. Test Verification Evidence

```bash
# UI Package Unit Tests
pnpm --filter @matchday/ui test:unit
# Output: Test Files 2 passed (2), Tests 14 passed (14)

# Web Unit Tests
pnpm --filter @matchday/web test
# Output: Test Files 99 passed (99), Tests 915 passed (915)

# Keyboard Walkthrough Playwright Test
pnpm --filter @matchday/web exec playwright test tests/organiser-keyboard-journey.spec.ts
# Output: 1 passed (14.9s)

# Responsive Multi-Viewport Accessibility Playwright Tests
pnpm --filter @matchday/web exec playwright test tests/responsive-pages-accessibility.spec.ts
# Output: 27 passed (22.1s)

# Mobile Core Web Vitals Playwright Tests
pnpm --filter @matchday/web exec playwright test tests/performance-cwv.spec.ts
# Output: 2 passed (14.0s)

# Monorepo Typecheck
pnpm typecheck
# Output: Tasks 16 successful, 16 total

# Monorepo Lint & i18n Guard
pnpm lint
# Output: Tasks 16 successful, 16 total, 0 warnings, 0 errors
# i18n audit: 222 route/component files, 741 registered prototype messages, 0 findings

# Monorepo Production Build & Static Bundle Size
pnpm build
# Output: Tasks 16 successful, 16 total
# Static bundle: 3640 KB (3.6 MB)
```
