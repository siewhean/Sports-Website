# Exceptional-case policy

Status: **Provisional operational baseline — organiser and sport-domain sign-off required**

This is the local decision draft for `VAL-005`. Every exceptional action is append-only, attributed, timestamped, reasoned where required, and visible in the organiser audit trail. Published history is never silently overwritten.

## Decision matrix

| Case                                     | Default handling                                                                                                                                                    | Authority                                                                      | Public state                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Withdrawal before first match            | Mark entry withdrawn; organiser may insert a replacement before format lock, preserving the seed change in audit                                                    | Organiser                                                                      | Withdrawn/replaced label; regenerated schedule only after publication                  |
| Withdrawal after group play begins       | Completed results stand; remaining matches become forfeits at the versioned sport-pack score; recalculate standings                                                 | Organiser                                                                      | Forfeit results publish immediately; schedule revisions remain private until published |
| Late arrival                             | Five-minute provisional grace period. Official records “late”; organiser may start, reschedule privately, or declare forfeit                                        | Organiser; official recommends                                                 | Scheduled until a decision, then normal or forfeit result                              |
| No-show                                  | After the grace period, organiser confirms a forfeit; never inferred solely from elapsed time                                                                       | Organiser                                                                      | Forfeit result with reason                                                             |
| Abandoned match                          | Freeze scoring and mark **Abandoned — decision pending**. Organiser chooses resume from event log, replay, accept score where rules permit, forfeit, or cancel/void | Organiser                                                                      | Abandoned badge and last confirmed score; decision publishes when made                 |
| Correction before dependent match starts | Require reason; append reversal/replacement events; publish corrected result; recalculate dependants                                                                | Organiser; official may reverse only before finalisation in its active session | Corrected score and audit marker                                                       |
| Correction after dependent match starts  | Apply and publish correction; create critical conflict; never silently cascade participants or schedule                                                             | Organiser only                                                                 | Corrected score plus “downstream review required”                                      |
| Tied group standings                     | Apply the stored sport-pack criteria in order. If still tied, block automatic advancement and require an audited organiser resolution                               | Engine, then organiser                                                         | “Tie-break decision pending” until resolved                                            |
| Tied knockout match                      | Apply sport-specific decider/overtime. If unavailable or abandoned, block advancement for an organiser decision                                                     | Official records; organiser resolves exceptions                                | In progress/abandoned until a winner is recorded                                       |

## Invariants

- A withdrawn entry cannot be scheduled into a new match unless restored or replaced.
- A replacement never inherits unpublished identity data or score events from the withdrawn entry.
- Forfeit scores are configuration, not hardcoded engine constants, and are locked/versioned when play starts.
- Officials may reverse their own unfinalised events. Reopening or correcting a finalised match is organiser-only for MVP.
- Corrections require a non-empty reason and preserve the original result.
- Standings and advancement are deterministic for the same versioned inputs.
- Critical conflicts block affected advancement/schedule publication, not unrelated scoring or public results.
- AI may explain a conflict but may not decide a tie, score, forfeit, or correction.

## Abandoned-match resolution record

The organiser must record: decision, reason, effective score if any, restart point if resumed, affected entries, rule reference supplied by the organiser, and whether a private schedule repair is required. “Accept current score” is not offered unless the competition’s configured rules allow it.

## Confirmation checklist

- [ ] Replace or accept the five-minute late-arrival grace period.
- [ ] Confirm every sport’s forfeit oracle in the sport-default pack.
- [ ] Confirm abandoned-match choices and who may authorise each one.
- [ ] Confirm the final unresolved-tie mechanism; the product does not silently use seed or randomness.
- [ ] Test against real local and national withdrawal/revised-schedule artefacts from `VAL-001`.

Source: specification §§7.5–7.6, 8.3–8.4, 8.13, 8.15–8.16, 12.2, 20; task `VAL-005`.
