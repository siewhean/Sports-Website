# Phase 0 Prototype Design System

**Status:** Accepted implementation reference

**Working product label:** MATCHDAY — prototype copy only, not a final brand decision

## Concept references

| Flow                   | Accepted concept                                 | Native size |
| ---------------------- | ------------------------------------------------ | ----------: |
| Assisted Setup         | `docs/design/concepts/assisted-setup.png`        | 1568 × 1003 |
| Format Designer        | `docs/design/concepts/format-designer.png`       | 1568 × 1003 |
| Phone scoring, online  | `docs/design/concepts/phone-scoring.png`         |  864 × 1821 |
| Phone scoring, offline | `docs/design/concepts/phone-scoring-offline.png` |  864 × 1821 |

The images define composition, density, hierarchy, palette, typography character, component anatomy, and icon weight. All app text and controls remain code-native.

## Visual thesis

Event-day control room meets sports editorial: calm neutral work surfaces, graphite operational chrome, one chartreuse signal accent, high-contrast mono scores, precise rails instead of dashboard-card mosaics, and motion only where it clarifies state.

## Tokens

```css
:root {
  --canvas: #f7f6f0;
  --surface: #ffffff;
  --surface-subtle: #efeee8;
  --ink: #171918;
  --ink-muted: #646863;
  --hairline: #d3d4ce;
  --signal: #b7dc22;
  --signal-strong: #97bc0d;
  --signal-ink: #12150b;
  --warning: #e9a410;
  --danger: #c74a43;
  --success: #6d9414;
  --focus: #5876d8;
  --event-canvas: #0d1010;
  --event-surface: #171a19;
  --event-line: #4a4f4d;
  --team-blue: #2364d9;
  --team-gold: #dea700;
  --shadow-soft: 0 24px 70px rgba(26, 28, 24, 0.08);
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-state: cubic-bezier(0.32, 0.72, 0, 1);
}
```

Semantic warning, danger, team identity, and offline colours may supplement the single product accent. They never carry meaning without text or an icon.

## Typography

- UI and headings: Geist Sans, then system sans fallback.
- Scores, times, slot counts, and technical status: Geist Mono.
- Display: `clamp(2.25rem, 4.5vw, 4.75rem)`, weight 650, tight tracking.
- Page title: `clamp(1.8rem, 3vw, 3.15rem)`, weight 620.
- Section title: 1.25–1.5rem, weight 600.
- Body: 1rem, line height 1.55.
- UI control: 0.925rem, weight 550; never browser-default styling.
- Caption/status: 0.8rem, line height 1.4; mono where the state is machine-derived.

## Spacing and geometry

- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96 px.
- Desktop app gutter: 24–40 px; phone gutter: 16 px.
- Controls: 44 px minimum; phone scoring primary controls: 56 px minimum.
- Control radius: 8 px; stage node: 10 px; summary/critical panels: 16 px; phone primary action: 20 px.
- Use shadows only for elevated, draggable, or modal surfaces. Use dividers and whitespace elsewhere.

## Component families

### Shared application shell

- MATCHDAY working wordmark, competition context, three prototype routes, help, and current user.
- Desktop/tablet uses rails and panels; phone scoring uses a safe-area header and bottom action dock.
- Navigation is keyboard reachable and exposes `aria-current`.

### Assisted Setup

- One authoritative eight-step progress component. The concept's duplicated horizontal/vertical progress is intentionally simplified to a desktop rail and mobile compact step header.
- Open form rows with label, helper, control, inline error, and immediate capacity recalculation.
- Live capacity summary is the one elevated panel.
- Loading skeleton, incomplete/empty, inline error, offline draft-only, and capacity-warning states.

### Format Designer

- Top command bar, stage library rail, open grid canvas, selected-stage inspector, validation status rail.
- Stage nodes are the only card-like draggable objects.
- Visual and Manual modes edit the same local format definition.
- Adding and selecting stages works by mouse, touch, and keyboard; manual mode is the accessible alternative to dragging.
- Invalid connections remain uncommitted and explain valid destinations.

### Phone scoring

- Scoreboard, team-specific goal actions, neutral event actions, manual event time, append-only recent-action list, sync state, writer state, transfer, and finalisation review.
- Default implementation screenshot follows the accepted offline concept; an online toggle must remove the pending panel and show acknowledgement before publication language.
- Undo adds a reversal event. It never deletes a historical row.
- Transfer exposes read-only, takeover warning, and stale-pending-event conflict states.

## Icon inventory

Use `@phosphor-icons/react` with regular or light weight and one optical scale per region.

| Meaning           | Icon family treatment                                |
| ----------------- | ---------------------------------------------------- |
| Back/continue     | ArrowLeft / ArrowRight, 20 px                        |
| Step complete     | Check, 16–18 px in a circular marker                 |
| Playing area      | CourtBasketball or SquaresFour, 20 px                |
| Time/date         | Clock / CalendarBlank, 20 px                         |
| Warning/offline   | Warning / CloudArrowUp, 20–24 px with text           |
| Stage types       | UsersThree, ArrowsClockwise, Trophy, Medal, 18–20 px |
| Canvas zoom       | Plus, Minus, CornersOut, 18 px                       |
| Goal/card/timeout | Target, Cards, Timer, 26–32 px                       |
| Transfer/finalise | DeviceMobileCamera, ClipboardText, 22–26 px          |
| Reversal          | ArrowUUpLeft, 20 px                                  |

## Motion contract

- Operational controls: transform feedback at 120–160 ms; state opacity/transform at 160–220 ms.
- No animation on keyboard-triggered navigation.
- Format nodes may use short interruptible transform transitions; no perpetual canvas animation.
- Scoring actions give immediate press feedback and update scores without a blocking flourish.
- Animate only transform and opacity. Avoid `transition: all`.
- Reduced motion removes positional movement and retains brief opacity/state changes.
- Hover effects run only on fine pointers.

## Responsive contract

- Assisted Setup: desktop rail and summary; tablet keeps summary alongside; phone uses compact step header, single-column rows, sticky actions, and summary disclosure.
- Format Designer: desktop/tablet canvas; below 768 px defaults to Manual mode and action sheets. Dense canvas dragging is not the primary mobile path.
- Scoring: designed for 360–430 px portrait, remains usable at 200% and 400% zoom, and keeps primary controls above safe-area insets.

## Allowed visible copy

The source specification controls labels. Prototype-specific sample copy is limited to MATCHDAY, Singapore Open, Southern Open, Marina Blue, Harbour Gold, Pool A, Match 12, A. Lim, D. Tan, and J. Wong. No marketing claims, fake conversion metrics, testimonial quotes, or invented compliance language are allowed.

## Fidelity deviations already approved

1. Assisted Setup uses one responsive progress system rather than duplicating the concept's left and top progress navigation.
2. The scorekeeper implements online and offline as mutually exclusive interactive states. The corrected offline concept is the default visual reference.
3. Team blue and gold remain semantic team colours and do not count as competing product accents.
