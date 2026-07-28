# Gate C C2 shared score-control surface

This pack prepares the next C2 UI commit:

```text
feat(scoring): add shared accessible score-control surface
```

Apply it only after the five-sport scorecard-adapter commit has been accepted locally.

## Scope

Adds:

- a pure action model that expands every score control into home/away actions;
- side-specific segment-completion and exceptional-outcome actions;
- global actions for genuinely side-neutral controls;
- unique deterministic action keys;
- a reusable client component with semantic score output, fieldsets and buttons;
- copy injection instead of new hard-coded user-facing strings;
- explicit read-only and pending disablement;
- polite status announcements;
- 44px minimum targets, visible focus and narrow-phone reflow;
- overflow-safe labels, team names and scores.

The surface emits a typed `ScoreControlAction` to its parent. It does not calculate official scores, mutate server state or bypass the deterministic reducer.

## Deliberate boundaries

This pack does **not**:

- replace `PhoneScoring` yet;
- implement participant-picker or correction dialogs;
- send API requests;
- add Playwright evidence;
- certify the shared mobile shell or C2.

The next integration commit should mount this surface inside the scorekeeping shell, preserve the existing C1 access/session states, and route activations through the generic wire contract.

## Files

```text
apps/web/lib/five-sport-score-control-actions.ts
apps/web/lib/five-sport-score-control-actions.test.ts
apps/web/components/phase5/FiveSportScoreControls.tsx
apps/web/components/phase5/FiveSportScoreControls.module.css
```

## Apply

```bash
export C2_SCORECARD_SOURCE_SHA='<exact accepted scorecard-adapter commit>'
./apply-gate-c-c2-control-surface.sh '/Users/Siew Hean/Documents/Sports Website'
```

## Validate

```bash
./validate-gate-c-c2-control-surface.sh '/Users/Siew Hean/Documents/Sports Website'
```

Commit only after local validation with:

```text
feat(scoring): add shared accessible score-control surface
```
