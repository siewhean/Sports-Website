# Phase 0 CSS modularization map

Phase 0 prototype CSS is component-owned. `globals.css` fell from 7,186 to 4,660 lines: 2,526 lines removed (35.1%). No shared Phase 0 `.eyebrow`, `.button`, `.text-button`, `.icon-button`, `.setup-*`, `.step-*`, `.capacity-*`, `.recommendation-*`, `.entry-*`, `.form-*`, `.designer-*`, `.stage-*`, `.format-*`, `.connection*`, `.validation-*`, `.manual-*`, `.inspector-*`, `.scorekeeper-*`, `is-dark`, or `is-scoring` selector remains global.

| Owner                     | Module                                                | Current size | Scope                                                                                                      |
| ------------------------- | ----------------------------------------------------- | -----------: | ---------------------------------------------------------------------------------------------------------- |
| Shell                     | `components/PrototypeShell.module.css`                |    241 lines | Shell/header/navigation plus module-local dark and scoring states                                          |
| Shared Phase 0 primitives | `components/prototype/PrototypePrimitives.module.css` |    105 lines | Eyebrow, action, icon, and text buttons reused by the shell, setup, and format prototypes                  |
| Assisted setup            | `components/AssistedSetupPrototype.module.css`        |  1,280 lines | Setup workflow, fields, capacity, entries, recommendations, states, loading, and responsive rules          |
| Format designer           | `components/FormatDesignerPrototype.module.css`       |    871 lines | Designer command bar, canvas, stages, connectors, inspector, validation, manual mode, and responsive rules |
| Scorekeeper               | `components/ScorekeeperPrototype.module.css`          |    701 lines | Access, confirmation, live scoring, timeline, conflict/finalisation states, and mobile rules               |

`components/prototype/cssModuleClasses.ts` performs the mechanical token-to-module mapping while preserving intentional global utilities. Dynamic state classes are emitted only when the owning module exports a styled selector; runtime audits found no raw Phase 0 target tokens.

The following remain global by design:

- `:root` design tokens, reset/document rules, focus/skip-link and accessibility utilities.
- Shared animation keyframes, including `skeleton`, used across module boundaries.
- Phase 1–3 selectors beginning at the production-shell section.

Verification uses Node 24.18.0: Prettier, web typecheck, lint/i18n, production build, focused unit tests, the prototype interaction/accessibility/overflow/visual suite, and dedicated Scorekeeper and Format Designer browser tests. The browser matrix covers Chromium, WebKit, desktop/mobile breakpoints, reduced motion, forced colors, overflow, and console/page-error checks. The in-app Browser was attempted first and returned `No browser is available`; the repository Playwright harness is the recorded fallback.
