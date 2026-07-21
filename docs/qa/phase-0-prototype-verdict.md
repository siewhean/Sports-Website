# Phase 0 `VAL-007` Prototype Verdict

**Verdict:** PASS

**Scope:** `VAL-007` only — Assisted Setup, Format Designer, and phone scorekeeping prototypes. This is not a PASS for the complete Phase 0 gate.

**Independent review:** The first QA/QC pass found live-score contrast, invalid ARIA role, missing §7.1 Basics/Capacity inputs, and incomplete visual-state evidence. Those findings were fixed. The 17 July audit remediation then added bounded validation, persistence, interaction, offline/concurrency, and cross-browser evidence; its final combined recheck is recorded separately.

## Fresh gate evidence

| Check                            | Result                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                 | PASS                                                                                                                       |
| `pnpm lint`                      | PASS                                                                                                                       |
| `pnpm build`                     | PASS, no warnings                                                                                                          |
| Focused Phase 0 Playwright       | PASS, 24/24                                                                                                                |
| Format Designer browser matrix   | PASS, 9/9 across Chromium, WebKit, and Firefox                                                                             |
| Untracked-aware whitespace check | PASS                                                                                                                       |
| Browser console warnings/errors  | None                                                                                                                       |
| Automated accessibility          | No serious or critical violations on all initial routes or the live scorekeeper state                                      |
| Responsive checks                | No page overflow at 360, 390, 768, 1024, or 1440 CSS pixels; scoring reflow proxy passes at 200% and 400% effective widths |

The automated suite covers bounded setup validation, dynamic capacity recalculation and acknowledgement, safe local draft resume, browser history, rapid navigation, shared visual/manual format state, clamped collision-safe pointer movement, keyboard movement, dynamic connectors, access validation, physical offline scoring, rapid event ordering, append-only reversal, concurrent-tab isolation, active-writer takeover and stale fencing, offline finalisation, publication acknowledgement, correction reason, and downstream conflict creation.

## Visual evidence

- `docs/qa/screenshots/phase-0-setup-desktop.png`
- `docs/qa/screenshots/phase-0-setup-tablet.png`
- `docs/qa/screenshots/phase-0-format-desktop.png`
- `docs/qa/screenshots/phase-0-score-phone.png`
- `docs/qa/screenshots/phase-0-setup-loading.png`
- `docs/qa/screenshots/phase-0-setup-error.png`
- `docs/qa/screenshots/phase-0-format-empty.png`
- `docs/qa/screenshots/phase-0-format-conflict.png`
- `docs/qa/screenshots/phase-0-setup-reduced-motion.png`
- `docs/qa/screenshots/phase-0-setup-high-contrast.png`

## Phase 0 remains open

- `VAL-001`: real local and national competition artefacts are not yet supplied.
- `VAL-002`: independent and national-level design partners are not yet committed.
- `VAL-003`: the local Canoe-Polo-first 8/12/16/24/48 input and numerical-oracle pack exists; Phase 4/6 generated-graph and scheduling snapshots remain deferred to their owning engines.
- `VAL-004`–`VAL-005`: five-sport defaults and exceptional-case policy have provisional local baselines; design-partner and sport-domain confirmation remains open.
- `VAL-006`: the public-data baseline exists but privacy/legal approval, backup-retention limits, and published legal notices remain open.
- `VAL-008`: organiser usability sessions are not yet run.
- `VAL-009`: offline duration, permitted actions, expiry, transfer, and reconciliation remain unconfirmed by partners.
- `VAL-010`: commercial defaults remain unconfirmed.
- The national-association and later pilot dependencies remain open; no national competition may depend solely on the product.
