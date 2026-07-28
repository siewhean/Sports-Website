# Gate C C2 domain foundation — five-sport scoring

This pack prepares the first C2 commit only:

```text
feat(scoring): define five-sport event contracts and reducers
```

It must not be applied until the C1 follow-up source has a new exact-SHA evidence commit and an independent review with `P0: 0` and `P1: 0`.

## Scope

Adds a deterministic domain reducer for:

- Canoe Polo
- Badminton
- Table Tennis
- Volleyball
- Basketball

The reducer derives event availability, score increments, participant-attribution requirements, scoring hierarchy, draw policy, targets, win-by rules, point caps, best-of length and effective settings from the existing versioned sport packs.

It implements:

- strict match identity and sequence validation;
- identical client-event idempotency and changed-payload rejection;
- explicit match start, finalisation and reopening;
- timed-period and best-of-segment scoring;
- strictly sequential regulation/overtime transitions and guarded deciding-set entry;
- Canoe Polo scorer attribution and explicit unknown-scorer setting;
- Badminton cap handling;
- Table Tennis win-by-two without a default cap;
- Volleyball deciding-set target handling;
- Basketball 1/2/3-point events and successive overtime;
- reversible score and operational events;
- conflict surfacing when a reversal invalidates a completed segment after later play exists;
- retirement and walkover with preserved play, a scoring lock, explicit reversal recovery and explicit finalisation;
- segment-completion actions retained in the immutable action history;
- rejection of unsupported sport events and invalid effective settings;
- no live running clock.

## Deliberate boundaries

This pack does **not**:

- wire the reducer into API persistence;
- change the `score_events` schema;
- build the shared mobile scorekeeping shell;
- build five scorecard UIs;
- implement organiser correction/downstream review UI;
- certify C2 or Gate C.

Those remain separate C2 commits after this domain contract is accepted.

## Files

```text
packages/domain/src/five-sport-scoring.ts
packages/domain/src/index.ts
packages/domain/tests/gate-c-five-sport-scoring.test.ts
```

## Apply

Create the C2 branch from the final C1 follow-up evidence commit, then set that exact SHA:

```bash
export C1_FOLLOWUP_EVIDENCE_SHA='<exact evidence commit>'
./apply-gate-c-c2-domain.sh '/Users/Siew Hean/Documents/Sports Website'
```

The script requires:

- a clean tree;
- `HEAD` equal to `C1_FOLLOWUP_EVIDENCE_SHA`;
- ancestry from the original C1 evidence commit;
- no existing C2 domain files;
- an unchanged patch checksum.

## Validate

```bash
./validate-gate-c-c2-domain.sh '/Users/Siew Hean/Documents/Sports Website'
```

Required local checks:

- Node `v24.18.0`;
- pnpm `10.33.0`;
- focused five-sport unit suite;
- complete domain unit suite;
- domain typecheck;
- domain build;
- targeted Prettier check;
- `git diff --check`.

After validation, inspect the complete diff and commit with:

```text
feat(scoring): define five-sport event contracts and reducers
```

Do not generate C2 evidence yet. The API adapter, persistence, scorecards, corrections, audit view and browser matrix must be completed before C2 exact-SHA certification.
