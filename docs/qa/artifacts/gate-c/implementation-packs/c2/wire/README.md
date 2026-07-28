# Gate C C2 wire contract — generic five-sport score commands

This pack prepares the third C2 commit:

```text
feat(scoring): add five-sport wire validation contract
```

Apply it only after the C2 deterministic domain reducer commit has been accepted. It is independent of the scorecard adapter, although both are expected before the shared mobile shell is wired.

## Why this exists

The current C1 BFF boundary is intentionally Canoe-Polo-specific: it recognises goal/card/timeout/incident commands and assumes two manual periods. C2 needs an additive generic contract before API, BFF and web code can safely accept the remaining sports.

## Scope

Adds:

- a sanitising parser for raw snake-case score commands;
- UUID, side, timestamp, segment and manual-time bounds;
- sport-pack ownership checks;
- effective-setting checks for optional controls;
- side and participant-attribution requirements;
- explicit unknown-scorer policy for Canoe Polo only;
- mandatory reason/target checks for reopen and reversal;
- rejection of cross-sport or disabled events;
- materialisation of server-owned event ID, match, sequence, actor and scoring-session metadata.

Unknown input fields are not forwarded. The parser does not accept reusable access tokens, cookies, HMACs or session secrets.

## Deliberate boundaries

This pack does **not**:

- change the C1 API/BFF route yet;
- change database persistence;
- change session state responses;
- wire the deterministic reducer;
- certify C2.

Those changes should follow in a separate API/persistence commit after this contract is reviewed.

## Files

```text
packages/domain/src/five-sport-scoring-wire.ts
packages/domain/src/index.ts
packages/domain/tests/gate-c-five-sport-scoring-wire.test.ts
```

## Apply

Set the exact accepted C2 domain source SHA:

```bash
export C2_DOMAIN_SOURCE_SHA='<exact C2 domain commit>'
./apply-gate-c-c2-wire.sh '/Users/Siew Hean/Documents/Sports Website'
```

## Validate

```bash
./validate-gate-c-c2-wire.sh '/Users/Siew Hean/Documents/Sports Website'
```

Required checks include strict domain typecheck, focused and complete domain tests, build, Prettier and `git diff --check`.

Commit after local validation with:

```text
feat(scoring): add five-sport wire validation contract
```
