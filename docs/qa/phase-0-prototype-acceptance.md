# Phase 0 Prototype Acceptance

**Scope:** `VAL-007` only — the clickable prototype gate for Assisted Setup, Format Designer, and phone scorekeeping.

**Gate rule:** all local checks below must pass before the prototypes are placed in front of organisers. `VAL-008` usability sessions and `VAL-009` offline-policy confirmation remain separate external gates.

## Shared acceptance

- [x] The three routes are directly reachable and linked from one keyboard-accessible prototype navigation.
- [x] The concepts and tokens in `docs/design/PROTOTYPE_DESIGN_SYSTEM.md` are followed without copying image text into inaccessible artwork.
- [x] Every control has an accessible name, visible focus state, and correct disabled or selected state.
- [x] Pointer, keyboard, and touch-sized interactions work without a mouse-only critical path.
- [x] Loading, empty or incomplete, inline error, and offline states can be exercised in the UI.
- [x] State is not communicated by colour alone.
- [x] Layouts have no clipping or horizontal page overflow at 360, 390, 768, 1024, and 1440 CSS pixels.
- [x] Reduced-motion mode removes positional entrance motion.
- [x] The browser console has no uncaught errors or hydration warnings.

## Assisted Setup

- [x] All eight steps are reachable: Basics, Capacity, Settings, Entries, Preferences, Recommendations, Schedule, Review & publish.
- [x] Basics captures competition name, sport, location, timezone, dates, team or participant count, division count, and confirmed or estimated entry status.
- [x] Capacity captures playing areas, per-day opening and closing, per-area availability, optional unavailable periods, and match-slot length; it defaults Canoe Polo to 30 minutes and recalculates immediately.
- [x] Capacity does not ask the excluded timing questions.
- [x] Settings shows Recommended and Customised state plus Reset to recommended.
- [x] Entries supports manual, paste, and import paths and exposes seeding, division, separation, and availability concepts.
- [x] Recommendations compare no more than three options and show stages, match count, minimum matches, estimated duration, advancement, fairness, and operational trade-offs.
- [x] Schedule offers Fastest, Balanced, and Rest-focused choices.
- [x] Review distinguishes draft validation from publish and explains unresolved conflicts with icon plus text.
- [x] Offline mode is draft-only and does not claim publication.

## Format Designer

- [x] Visual and Manual modes edit the same format definition.
- [x] The stage library exposes round robin, groups, knockout, placement, and final/classification stages.
- [x] A selected stage exposes name, participant count, advancement, seeding, best-of or match settings, and schedule constraints where relevant.
- [x] Stages can be added and selected by pointer and keyboard; Manual mode is the non-drag alternative.
- [x] Valid connections can be committed and invalid connections stay uncommitted with an explanation of valid destinations.
- [x] Loading, empty canvas, validation error, offline draft, and concurrent-edit conflict states are exercisable.
- [x] Desktop and tablet expose the canvas; below 768 CSS pixels the primary path is Manual mode with compact panels.

## Phone scorekeeping

- [x] The prototype demonstrates access validation and match confirmation before scoring authority is assumed.
- [x] Team-specific scoring, neutral events, manual event time, and recent actions are usable with phone-sized touch targets.
- [x] Undo appends a visible reversal event instead of deleting history.
- [x] Offline actions receive client event IDs and pending-sync status; reconnect acknowledges replay before publication language appears.
- [x] An active-device conflict offers read-only mode and an explicit transfer/takeover warning.
- [x] Old-generation pending events produce a reconciliation state and are never presented as automatically merged.
- [x] Finalisation uses a confirmation review and clearly separates pending sync from published result.
- [x] Result correction requires a reason, appends correction events, and identifies downstream schedule conflicts.
- [x] The flow remains usable at 200% browser zoom and in 360–430 CSS pixel portrait layouts.

## Required evidence

- [x] Production build and static/type/lint checks pass.
- [x] Automated interaction tests cover each critical happy path and the score reversal/offline/transfer paths.
- [x] Automated accessibility checks report no serious or critical violations on the three routes, including post-interaction live scoring.
- [x] Desktop, tablet, phone, loading, error, empty, conflict, reduced-motion, and high-contrast screenshots are captured and visually compared with the accepted concepts.
- [x] An independent QA/QC agent records its verdict and residual risks in `docs/qa/`.

## External follow-on gates

- `VAL-008`: sessions with organisers who currently use spreadsheets; record task success, hesitation, terminology issues, and changes.
- `VAL-009`: confirm offline duration, permitted offline actions, expiry, transfer, and reconciliation with design partners.
- The national-association dependency remains open until the corresponding partner and governance evidence exists.
