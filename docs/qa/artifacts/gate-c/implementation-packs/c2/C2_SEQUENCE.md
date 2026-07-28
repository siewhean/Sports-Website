# Gate C C2 prepared implementation sequence

## Safety boundary

Do not apply any C2 pack until the C1 follow-up has:

- a committed clean source SHA;
- all 31 C1 ledger commands passing on that SHA;
- a new evidence commit;
- a fresh independent review with `P0: 0` and `P1: 0`.

The packs are source preparation only. They do not certify C2 or full Gate C.

## Prepared commits

### 1. Deterministic domain reducer

```text
feat(scoring): define five-sport event contracts and reducers
```

Implements five-sport scoring state reduction, sequence/idempotency, segment rules, attribution, reversals, exceptional outcomes, finalisation and strict transitions.

### 2. Generic wire validation contract

```text
feat(scoring): add five-sport wire validation contract
```

Prepares sanitised command parsing, sport ownership, settings, attribution, reversal and server-metadata materialisation.

### 3. Five-sport scorecard adapter

```text
feat(scoring): derive five-sport scorecard definitions
```

Derives UI controls and segment targets only from the sport packs.

### 4. Shared accessible score-control surface

```text
feat(scoring): add shared accessible score-control surface
```

Adds semantic score output, copy-injected action groups, pending/read-only behaviour, 44px targets and narrow-phone reflow.

## Stop conditions

Stop immediately if:

- any pack fails `git apply --check`;
- the tree is dirty before a pack is applied;
- an expected base SHA differs;
- domain/web typecheck fails;
- a focused or full unit suite fails;
- build fails;
- any test is skipped or weakened to make the pack pass;
- UI text is hard-coded instead of injected through existing copy/i18n boundaries;
- the API/BFF is changed before the generic wire contract is reviewed.

## Still required after these packs

These packs do not complete C2. Remaining work includes database persistence, API reducer integration, BFF adoption, phone scorekeeper mounting, participant/time inputs, reversal/reopen/finalise/correction dialogs, immutable audit, downstream conflict review, PostgreSQL/browser evidence and independent C2 review.