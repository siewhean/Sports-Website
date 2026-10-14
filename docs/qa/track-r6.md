# Track R6 QA Audit Report: Organiser UX, Design System, and Code Health

**Date:** 14 October 2026  
**Scope:** Track R6 (Deliverables R6.1–R6.6, Checkpoint CP6)  
**Branch:** `feat/r6-organiser-ux-design-system-code-health`

---

## 1. Summary of Changes

- **R6.1 Organiser Journey Error Messaging**: Replaced generic `"Check this field."` and `"Check the highlighted competition detail."` messages with field-specific guidance naming both the field and the required remedy across competition creation and division entry (`CompetitionCreateForm.tsx`, `EntriesEditor.tsx`, `packages/ui/src/i18n.ts`).
- **R6.2 Design System Consolidation**: Verified standard design system surface state coverage across loading, empty, error, offline, and permission states with accessible ARIA roles and contrast compliance.
- **R6.3 Internal Identifiers Modernisation**: Removed all user-facing phase/gate references (e.g. replaced `"Phase 3 capacity service"` with `"venue capacity service"` in `AssistedSetupWorkspace.tsx`), cleaned legacy CSS comments in `globals.css` and `phase3Classes.ts`, and verified zero user-visible `phase` or `gate` strings in URLs or page text.
- **R6.4 Dead Prototype Code Elimination**: Removed legacy Phase 0 prototype surfaces and components:
  - Pages: `apps/web/app/format/page.tsx`, `apps/web/app/score/prototype/page.tsx`, `apps/web/app/setup/page.tsx`.
  - Components: `FormatDesignerPrototype.tsx` (+CSS), `ScorekeeperPrototype.tsx` (+CSS), `AssistedSetupPrototype.tsx` (+CSS), `PrototypeShell.tsx` (+CSS), `prototype/`, `scorekeeper/`.
  - Removed obsolete prototype specs (`prototypes.spec.ts`, `scorekeeper-phase0.spec.ts`, `format-designer-interactions.spec.ts`, `scorekeeper-events.test.ts`).
  - Simplified `apps/web/app/score/page.tsx` to directly mount `PhoneScoring`.
- **R6.5 Accessibility (WCAG A/AA)**: Added automated keyboard-only walkthrough test (`apps/web/tests/organiser-keyboard-journey.spec.ts`) completing competition creation without pointer interaction.
- **R6.6 Performance (Core Web Vitals)**: Added automated mobile CWV assertions (`apps/web/tests/performance-cwv.spec.ts`) measuring LCP ≤ 2.5s and CLS ≤ 0.1 on mobile viewports for public competition and scoring routes.

---

## 2. Before / After Metrics

| Metric                                           | Before R6                        | After R6            | Delta                                               |
| :----------------------------------------------- | :------------------------------- | :------------------ | :-------------------------------------------------- |
| **Static Bundle Size** (`apps/web/.next/static`) | `3.9 MB`                         | `3.5 MB`            | **-400 KB (-10.3%)**                                |
| **Web Unit Tests**                               | 99 files, 916 tests              | 98 files, 912 tests | -1 file, -4 obsolete prototype tests (100% passing) |
| **API Unit Tests**                               | 78 files, 441 tests              | 78 files, 441 tests | 0 (100% passing)                                    |
| **User-Visible "Phase"/"Gate" Mentions**         | 1 (`AssistedSetupWorkspace.tsx`) | 0                   | **0 violations**                                    |
| **Dead Prototype Files**                         | 24 files                         | 0                   | **24 files deleted**                                |

---

## 3. Test Verification Evidence

```bash
# Web Unit Tests
pnpm --filter @matchday/web test
# Output: Test Files 98 passed (98), Tests 912 passed (912)

# API Unit Tests
pnpm --filter @matchday/api test:unit
# Output: Test Files 78 passed (78), Tests 441 passed (441)

# Monorepo Typecheck
pnpm typecheck
# Output: Tasks 16 successful, 16 total

# Monorepo Lint & i18n Guard
pnpm lint
# Output: Tasks 16 successful, 16 total, 0 warnings, 0 errors
```
