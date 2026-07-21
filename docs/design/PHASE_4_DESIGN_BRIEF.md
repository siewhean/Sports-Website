# Phase 4 design brief

**Status:** Accepted implementation reference

## Visual thesis

MATCHDAY remains a sports rulebook crossed with an event control room: warm paper work surfaces, graphite operational chrome, Geist Sans and Geist Mono, one chartreuse signal accent, semantic warning colours, and dense information separated by rails and rhythm rather than dashboard-card mosaics.

Phase 4 extends the accepted Phase 0 concepts and the production Phase 3 organiser shell. It does not introduce a second design system.

## Accepted concept references

| Surface                | Reference                                       | Native size |
| ---------------------- | ----------------------------------------------- | ----------: |
| Assisted Setup         | `docs/design/concepts/assisted-setup.png`       | 1568 × 1003 |
| Format Designer        | `docs/design/concepts/format-designer.png`      | 1568 × 1003 |
| Schedule timeline      | `docs/design/concepts/schedule-timeline.png`    | 1568 × 1003 |
| Mobile move-match flow | `docs/design/concepts/schedule-move-mobile.png` |  852 × 1846 |

All visible application text and controls remain code-native. The concepts define composition, density, hierarchy, palette, typography character, icon weight, control anatomy, and responsive intent.

## Surface contracts

### Assisted Setup

- One authoritative eight-step progress system: Basics, Capacity, Settings, Entries, Preferences, Recommendations, Schedule, Review.
- Server-owned, revision-aware autosave and cross-device resume replace prototype `localStorage` persistence.
- Capacity uses the exact lossless Phase 3 playing-area contract and immediately renders server-calculated availability.
- AI text-to-brief is optional. Missing information links to deterministic form fields; provider failure preserves the organiser text and exposes the guided manual flow.
- Phone collapses to a compact step header and one-column controls with a safe-area action dock. It never requires the format canvas or desktop schedule grid.

### Format Designer

- Preserve the accepted command bar, stage-library rail, open grid canvas, stage inspector, and validation rail.
- Visual and Manual modes edit one canonical graph and round-trip without changing stable IDs, positions, advancement, or hash.
- Stage nodes are the only card-like draggable objects. Controlled connectors cannot create unsupported freeform edges.
- Pointer operations have keyboard and structured-form equivalents. Below 768 px, Manual mode is primary.
- Validation and preview derive from the same unsaved/saved graph; invalid graphs cannot be selected, materialised, scheduled, or published.

### Schedule timeline

- Desktop/tablet uses areas as rows and time as columns, with an unscheduled tray, measurable alternative quality, selected-match inspector, dependency lines, conflicts, locks, revision controls, and explicit publication.
- Match blocks may be elevated because they are draggable. Ordinary metrics, filters, and inspector fields use open rows and dividers.
- Fastest, Balanced, and Rest-focused show named components such as duration, minimum rest, early/late balance, and unassigned matches. There is no unexplained AI score.
- Background optimisation always exposes its current best valid result. Continue, stop, cancel, and accept never replace an organiser-selected revision silently.
- Draft expiry and publication state remain visible without relying on colour alone.

### Mobile move match

- The phone flow is linear: select day, select an available area, select a valid time, review consequences, confirm.
- It shows the current and proposed slots, disabled choices with reasons, dependencies, protected locked matches, and the exact affected set before confirmation.
- It does not render or horizontally scroll a compressed timeline.

## Tokens and component rules

- Canvas `#f7f6f0`; surface `#ffffff`; ink `#171918`; muted ink `#646863`; hairline `#d3d4ce`; chartreuse `#b7dc22` / `#97bc0d`.
- Controls are at least 44 px; primary phone actions are at least 56 px and respect safe-area insets.
- Labels sit above fields with helper and inline error text. Status changes are announced.
- Phosphor icons use one optical scale and consistent weight per region. No emoji, ornamental gradients, glow, serif typography, or generic card grids.
- Motion is limited to 120–220 ms transform/opacity feedback and respects reduced motion. No perpetual operational animation.
- Loading skeletons, empty, invalid, permission, offline, conflict, no-solution, quota, cancellation, expiry, and success states preserve the final layout geometry.

## Fidelity gate

Before Gate B may pass, the implementation must be compared with the four accepted concepts using `view_image` at their native dimensions where practical. The comparison ledger must cover copy, layout, typography, palette, icon treatment, spacing/container model, interaction state, and phone collapse. Material deviations require correction or an explicit product-authorised exception.
