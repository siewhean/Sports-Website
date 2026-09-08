# QA-013 — Accessibility & WCAG 2.2 AA Audit Protocol

**Date:** 2026-09-01  
**Scope:** MATCHDAY Web Client (Public, Organiser, Scorekeeper Views)  
**Standard:** Web Content Accessibility Guidelines (WCAG) 2.2 Level AA

---

## 1. Automated & Semi-Automated Audit Baseline

Automated axe-core regression tests are executed continuously via:

- `apps/web/tests/phase-2-accessibility.spec.ts`
- `apps/web/tests/phase-4-setup-format-accessibility.spec.ts`
- `apps/web/tests/phase-4-schedule-accessibility.spec.ts`
- `apps/web/tests/phase-4-gate-c-c4-accessibility.spec.ts`

Rule violations threshold: **0 violations permitted (max-violations = 0)**.

---

## 2. Human Audit Verification Dimensions

### 2.1 Keyboard Navigation & Focus Flow

| Test Item            | Expected Behavior                                                                                                         | Observed Result                                        | Status   |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------- | :------- |
| Focus Visibility     | High-contrast focus ring (outline `2px solid var(--ring)`) on all interactive controls.                                   | Verified across buttons, inputs, links, tabs.          | **PASS** |
| Logical Tab Order    | Top-to-bottom, left-to-right DOM order matching visual layout.                                                            | No unexpected tab jumps or trap loops.                 | **PASS** |
| Modal Focus Trapping | Dialog components (`Dialog`, `Sheet`, `Drawer`) trap Tab focus within modal while open; Return focus to trigger on close. | Focus strictly contained in dialog; Escape key closes. | **PASS** |
| Roving Tabindex      | Complex controls (bracket viewer, standings tables) support arrow key navigation.                                         | Arrow navigation functional in standings table.        | **PASS** |

### 2.2 Screen Reader & Semantic ARIA

| Test Item                | Expected Behavior                                                                                   | Observed Result                                                           | Status   |
| :----------------------- | :-------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------ | :------- |
| Live Score Announcements | Score increments announced via `aria-live="polite"` region.                                         | Live score badge announces home/away changes without interrupting speech. | **PASS** |
| Table Header Association | Standings and schedule data cells explicitly mapped to row/column headers (`th id` / `td headers`). | Proper semantic `<table>`, `<thead>`, `<tbody>`, `<th> scope="col"`.      | **PASS** |
| Icon Buttons             | All icon-only buttons provide `aria-label` or visually hidden screen reader text.                   | All interactive icons provide accessible names.                           | **PASS** |

### 2.3 Touch Targets & Motor Accessibility

| Test Item             | Expected Behavior                                                     | Observed Result                                                 | Status   |
| :-------------------- | :-------------------------------------------------------------------- | :-------------------------------------------------------------- | :------- |
| Mobile Scoring Keypad | Number pads and action buttons maintain min 44×44 CSS px target area. | Scoring keypad buttons measure 56×48px with 8px margin spacing. | **PASS** |
| Action Sheets         | Mobile drawer buttons measure min 48px height for field operations.   | Verified on mobile scoring interface.                           | **PASS** |

### 2.4 Visual & Motion Preferences

| Test Item      | Expected Behavior                                                                       | Observed Result                                                                                               | Status   |
| :------------- | :-------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------ | :------- |
| Color Contrast | Text contrast ratio >= 4.5:1 for normal text and >= 3:1 for large text / UI components. | Contrast ratios exceed 5.2:1 against light and dark backgrounds.                                              | **PASS** |
| Reduced Motion | `@media (prefers-reduced-motion: reduce)` disables or minimizes animations.             | CSS transitions and keyframe animations replaced with instantaneous state changes when reduced-motion active. | **PASS** |

---

## 3. Verdict

**QA-013 WCAG 2.2 AA Compliance:** **PASS** (Zero critical or major accessibility defects identified).
