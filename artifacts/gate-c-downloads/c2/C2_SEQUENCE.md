# Gate C C2 preparation sequence

## Dependency boundary

Do not apply these packages until the C1 follow-up has:

1. a clean committed source SHA;
2. the complete C1 ledger passing on that exact SHA;
3. fresh immutable evidence; and
4. an independent review with `P0: 0` and `P1: 0`.

## Application order

1. `gate-c-c2-domain-pack.zip`
   - deterministic five-sport score-event reducer;
   - sequencing, idempotency, segment progression, reversals, reopening, retirement, walkover and finalisation.
2. `gate-c-c2-wire-pack.zip`
   - untrusted command parsing and sanitisation;
   - sport/action/side/value/reason/attribution validation;
   - server-owned identity and sequence fields.
3. `gate-c-c2-scorecard-pack.zip`
   - scorecard definitions derived from sport packs;
   - increments, targets, attribution and optional controls.
4. `gate-c-c2-control-surface-pack.zip`
   - shared accessible React scoring controls;
   - pending/read-only states, touch targets, focus and phone reflow.

## Stop conditions

Stop before the next package if:

- the working tree is not clean at the required starting SHA;
- `git apply --check` fails;
- focused validation fails;
- formatting/typechecking fails;
- the package introduces skips, broad allowlists or client-authoritative result calculation.

## Remaining C2 work

The four packages do not complete C2. Remaining work includes persistence, API reducer integration, complete BFF migration, mounting in `PhoneScoring`, participant/time input, reversal/reopen/finalisation/correction dialogs, audit view, downstream-conflict review, PostgreSQL/browser evidence and exact-SHA certification.
