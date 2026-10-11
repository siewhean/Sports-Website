# Singapore competition pilot

Status: `NOT_EXECUTED`; live organiser observation remains `WAIVED_NOT_EXECUTED` under ADR0005. This checklist describes a future owner-approved pilot, not completed user evidence. Scope: existing competition platform; payments excluded unless separately certified.

Scenario: one organiser, one eight-team competition (at least eight participants), two officials with distinct scorer identities/devices, multiple scheduled matches, one spectator device and one support observer. Choose supported sport/format and an approved synthetic/private dataset; do not modify Pesta Sukan or production without authorization.

| Step | Practical check                                                          | Expected observation / evidence                                                                                                                              |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Organiser signs in and creates competition                               | Correct tenant/permissions; entered setup retained; no another-tenant access                                                                                 |
| 2    | Register eight teams; publish roster and generated schedule              | Capacity respected; public publication matches approved data                                                                                                 |
| 3    | Assign two officials to separate matches                                 | Scoped access, visible match identity, unauthorized match denied                                                                                             |
| 4    | Score multiple matches on mobile; verify desktop organiser and spectator | Accepted score appears with monotonic version; standings/schedule update; measure actual latency against approved SLO                                        |
| 5    | Make an authorised score correction                                      | Audit trail and public result/standings agree; no duplicate or stale overlay                                                                                 |
| 6    | Interrupt one scorer connection during a submission, then reconnect      | Clear offline/retry status and truthful acceptance; no duplicate/reordered score or silent loss; observe recovery instead of assuming durable offline replay |
| 7    | Transfer scorer device and attempt old-device mutation                   | Authorized new device works; replaced device denied                                                                                                          |
| 8    | Finalise matches and publish results                                     | Final results consistent across reload/mobile/desktop/spectator without login                                                                                |
| 9    | Exercise casual guest workflow in approved test environment              | Create/update/view permissions correct; account history only where supported                                                                                 |
| 10   | Observer checks support, incident and recovery procedure                 | Named contact, privacy handling, fallback scoring and approved outage response                                                                               |

Repeat critical paths on actual selected mobile and desktop devices; automated browsers are separate evidence. Payment-dependent routes remain excluded until provider/webhook/refund controls and commercial approval pass. An owner-approved pilot cannot replace mandatory production operational certification.

Defect template: ID; UTC time; candidate/deployed SHA; environment; anonymized role; device/browser; reproduction; expected/actual; impact/severity; sanitized screenshot/log/reference; recovery; owner; fix SHA; retest outcome. Never record access codes, tokens or participant personal data. Report executed/skipped cases and observations; never fill PASS before execution.
