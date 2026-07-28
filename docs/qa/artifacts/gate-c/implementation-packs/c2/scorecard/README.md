# Gate C C2 scorecard adapter — five-sport UI definitions

This pack prepares the second C2 commit only:

```text
feat(scoring): derive five-sport scorecard definitions
```

Apply it only after:

1. the C1 follow-up has an exact-SHA evidence commit with independent `P0: 0` / `P1: 0`; and
2. the C2 deterministic domain reducer commit has been applied and validated.

## Scope

Adds a pure, config-driven adapter that converts the existing versioned sport packs into UI-ready scorecard definitions for:

- Canoe Polo;
- Badminton;
- Table Tennis;
- Volleyball;
- Basketball.

The adapter exposes:

- score mode (`total` or `segments`);
- segment and scoring-unit terminology;
- allowed score increments;
- draw policy;
- an explicit `noLiveClock: true` contract;
- score, segment-completion, operational and exceptional-outcome controls;
- participant-attribution requirements;
- mandatory side selection for scoring, segment completion, retirement and walkover;
- reversible-event metadata;
- scorecard field enablement from effective settings;
- regular and deciding segment targets.

It derives every control from `SPORT_PACKS` and rejects invalid effective settings. It does not invent sport-specific UI actions.

## Deliberate boundaries

This pack does **not**:

- replace the current Canoe-Polo-specific `PhoneScoring` JSX;
- wire the new deterministic reducer into the API or BFF;
- persist five-sport events;
- implement finalisation, correction or downstream review UI;
- create browser evidence or certify C2.

The next source commit should build the shared accessible mobile shell against this adapter, after the adapter is accepted locally.

## Files

```text
apps/web/lib/five-sport-scorecard.ts
apps/web/lib/five-sport-scorecard.test.ts
```

## Apply

On the branch containing the accepted C2 domain commit, export its exact SHA:

```bash
export C2_DOMAIN_SOURCE_SHA='<exact C2 domain commit>'
./apply-gate-c-c2-scorecard.sh '/Users/Siew Hean/Documents/Sports Website'
```

The script requires:

- a clean tree;
- `HEAD` equal to `C2_DOMAIN_SOURCE_SHA`;
- ancestry from the original C1 evidence history;
- the C2 domain reducer files to exist;
- no existing scorecard-adapter files;
- an unchanged patch checksum.

## Validate

```bash
./validate-gate-c-c2-scorecard.sh '/Users/Siew Hean/Documents/Sports Website'
```

Required checks:

- Node `v24.18.0`;
- pnpm `10.33.0`;
- targeted Prettier check;
- web typecheck;
- focused adapter unit suite;
- complete web unit suite;
- production web build;
- `git diff --check`.

After validation, inspect the full diff and commit with:

```text
feat(scoring): derive five-sport scorecard definitions
```

Do not claim C2 or full Gate C certification from this adapter alone.
