# Gate C — event-operation beta preparation and QC contract

**Status:** IN PROGRESS

**Implementation branch:** `agent/gate-c-event-operations`

**Certified Gate B base:** `d432cb4f7c8b8c419acb1c8f556ed02dcd48b834`

**Dependency status:** Satisfied for implementation. This branch was created directly from the certified Gate B evidence commit and imported only the Gate C preparation contract from `a264fbefe4cd462c383937391a18bc4325777bb2`. Gate C certification remains blocked until every Gate C work package receives executable exact-SHA evidence and independent review.

## 1. Gate contract

Gate C owns:

- `SCH-024–026`
- `ACC-001–010`
- `SCR-001–020`
- `OFF-001–008`
- `RES-011–020`, `RES-022–024`
- `EXP-001–002`
- `QA-018`

The release outcome is an event-operation beta with one active scoring writer, transfer and revocation, ordered offline replay, explicit conflict handling, authorised corrections, downstream review, immediate public result publication, private schedule repair revisions, all required public views and printed fallback.

Gate C cannot pass until concurrent-device, expired/revoked access, refresh/restart, four-hour offline, unsynchronised transfer, correction and downstream-conflict suites pass; public update and score-write latency meet the pilot targets; and real iOS plus low-end Android scoring produces no terminal, browser-console, service-worker or synchronisation errors.

## 2. Existing foundation audit

The repository already contains a useful vertical-slice foundation. This is not equivalent to Gate C completion.

| Area                           | Current evidence                                                                                                                           | Readiness judgment                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Match-scoped access            | `scoring_access_passes`, secret hashes, fallback-code hashes, expiry and revocation fields; organiser pass creation and revocation runtime | Strong foundation; QR rendering and dedicated code-attempt controls remain                        |
| Writer fencing                 | `scoring_access_sessions`, `match_writer_leases`, monotonically increasing generation, stale-writer rejection                              | Strong server foundation                                                                          |
| Transfer                       | Runtime creates a replacement session, revokes the prior session, advances generation and audits transfer                                  | Server path exists; device UX and unsynchronised-event transfer policy are not complete           |
| Append-only events             | `score_events` uniqueness on `(match_id, client_event_id)` and `(match_id, sequence)` plus mutation-prevention trigger                     | Strong persistence foundation                                                                     |
| Event idempotency and ordering | Runtime checks duplicate client IDs, uses an advisory lock and allocates the next sequence transactionally                                 | Strong online vertical slice; offline replay ordering is still missing                            |
| Result projection              | Match-result, standings, bracket and public projection snapshots exist; finalisation and organiser correction paths update projections     | Strong Canoe Polo vertical slice; full Gate C public and downstream behavior still needs coverage |
| Conflict fencing               | Writer generation and downstream-correction conflict checks exist                                                                          | Must be extended to offline/device-transfer conflicts and organiser review UX                     |
| Web scoring                    | Phone scoring shell, access exchange, session recovery, manual event time, recent-event state and finalisation are present                 | Generic/Canoe Polo slice only; five-sport parity and full correction/transfer UX are missing      |
| BFF security                   | Same-origin mutation checks, sealed scoring-session cookie, strict payload parsing and safe upstream error mapping exist                   | Good boundary; must be penetration- and rate-limit-tested                                         |
| Offline                        | No authoritative durable browser queue, cached authorised match package, ordered replay protocol or restart recovery was identified        | P0 blocker                                                                                        |
| Printed fallback               | No accepted schedule PDF and emergency score-sheet pack was identified                                                                     | P0 blocker                                                                                        |
| Real-device/load evidence      | No final Gate C device matrix, score-write load evidence or public-update latency evidence exists                                          | P0 blocker                                                                                        |

## 3. Task-level gap matrix

### Access (`ACC-001–010`)

- `ACC-001`: implemented as a vertical slice; verify every pass is match-scoped through API, BFF and database constraints.
- `ACC-002`: add deterministic QR generation, print-safe contrast, encoded opaque token only, and referrer/log leakage tests.
- `ACC-003`: fallback numeric code exists at the data/runtime boundary; complete UI, expiry, rotation and accessibility behavior.
- `ACC-004`: add dedicated per-pass/per-IP attempt counters, cooldown, standard rate-limit headers, metrics and abuse tests. Global rate limiting alone is insufficient evidence.
- `ACC-005`: expiry/revocation foundation exists; add browser/session invalidation, cached-data behavior and audit oracles.
- `ACC-006`: one-writer lease and generation fencing exist; add concurrent-device and lease-race suites.
- `ACC-007`: transfer runtime exists; add transfer UI, explicit takeover confirmation, old-device read-only state and unsynchronised-event conflict handling.
- `ACC-008`: complete read-only pass/session issuance and UI; prove read access cannot mutate.
- `ACC-009`: lease expiry exists; add heartbeat renewal, visibility/background behavior, weak-network policy and expiry recovery.
- `ACC-010`: audit foundation exists; prove every create, exchange, denial, transfer, heartbeat expiry and revocation event is recorded without secrets.

### Score-event engine (`SCR-001–020`)

- Preserve the append-only event model, idempotency, advisory-lock sequencing, deterministic reducer and atomic publication behavior.
- Add explicit expected-sequence/through-sequence contracts for offline replay and return machine-readable conflict details.
- Complete reversal/reopen/correction UI with mandatory reasons and immutable event history.
- Surface critical downstream conflicts for organiser review; never silently mutate already-started or finalised dependent matches.
- Generalise the scorekeeping shell to sport-pack-owned controls and validation for Canoe Polo, Badminton, Table Tennis, Volleyball and Basketball.
- Preserve the requirement that the app has no live running game clock and no Canoe Polo shot clock.
- Add match-level audit view and finalisation summary that can be used during dispute resolution.

### Offline (`OFF-001–008`)

Implement a versioned IndexedDB package containing:

- the authorised match identity and public-safe participant labels;
- the current writer generation and session expiry boundary;
- the last acknowledged server sequence;
- an append-only local command queue keyed by client event UUID;
- pending/finalised-local state;
- retry metadata that does not include reusable raw access tokens.

Replay requirements:

1. Send events strictly in local order.
2. Stop on stale generation, sequence divergence, revoked/expired access or semantic conflict.
3. Never discard an unsynchronised event automatically.
4. Expose a human-readable conflict package and export/support path.
5. Mark locally finalised results as pending publication until the server acknowledges finalisation.
6. Recover after refresh, browser restart and a four-hour offline interval.
7. Reject unsafe transfer when the old device has pending events unless the organiser explicitly resolves the conflict.

### Schedule repair (`SCH-024–026`)

- Compute affected and dependent match closure deterministically.
- Create a private repair revision first.
- Prefer local repair and preserve unrelated published assignments when feasible.
- Expand the repair set only when local repair cannot satisfy hard constraints.
- Show consequences and require explicit organiser publication.
- Never expose forecast or private repair times publicly.

### Results/public (`RES-011–020`, `RES-022–024`)

- Recalculate downstream participants after authorised correction.
- Keep future schedule changes private until organiser publication while publishing the corrected result immediately.
- Complete overview, schedule, tables, brackets, search and “My next match” across all five sports/formats.
- Add monotonic near-realtime updates, visible last-updated time and confirmed-current fallback when a replica/cache is behind.
- Enforce public privacy controls, especially player/minor/referee visibility.

### Printed fallback (`EXP-001–002`, `QA-018`)

Generate a version-stamped fallback pack containing:

- published schedule with schedule version and generated timestamp;
- emergency score sheets with match ID/code, participants, area, scheduled time and fallback access instructions;
- correction/incident notes area;
- explicit warning that the public site is authoritative after connectivity returns.

PDF output must be deterministic, printable in monochrome, accessible where practical and tested for page clipping.

## 4. Required engineering work packages

### C1 — Access, leases and transfer

- QR and fallback-code organiser UI.
- Rate-limit/attempt storage and metrics.
- Heartbeat endpoint and client lifecycle.
- Read-only passes.
- Transfer/takeover UX and stale-device state.
- Access/transfer audit viewer and tests.

### C2 — Five-sport scoring and corrections

- Sport-pack score-event schemas and reducers.
- Five scorecards sharing an accessible mobile shell.
- Reversal/reopen/finalisation/correction flows.
- Match audit view.
- Downstream conflict review.

### C3 — Offline durability

- Service worker and IndexedDB versioning.
- Cached match package.
- Ordered replay, backoff and conflict state machine.
- Refresh/restart/four-hour recovery.
- Unsynchronised-transfer tests.

### C4 — Repair, public and fallback

- Affected-match repair revisions.
- Immediate result/public version pipeline.
- Realtime/last-updated behavior.
- Public privacy controls.
- Schedule and score-sheet PDF pack.

### C5 — Performance, devices and evidence

- Score-write and public-read load harnesses.
- Real iOS and budget Android runbook.
- Browser/service-worker/console/network capture.
- Sanitised exact-SHA evidence and independent review.

## 5. Fail-closed validation ledger

The final Gate C candidate must be clean and committed before this ledger is executed:

```text
pnpm install --frozen-lockfile
pnpm ci:assert-clean-outputs
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm db:migrate:check
pnpm backup:verify
RUN_INFRA_TESTS=1 pnpm test:integration
pnpm validate:fixtures
pnpm validate:phase2
pnpm validate:phase3
pnpm validate:phase4
pnpm openapi:check
pnpm dependencies:audit
pnpm secrets:scan
pnpm build
pnpm deploy:manifest
pnpm asset-delivery:verify:origin
pnpm test:e2e
pnpm test:a11y
pnpm test:visual
```

Add Gate C-specific commands that prove:

- two-device lease race, takeover and old-device fencing;
- expiry, revocation, heartbeat and read-only behavior;
- four-hour offline queue, refresh and restart recovery;
- ordered replay and duplicate-event idempotency;
- unsynchronised transfer conflict without data loss;
- reversal, reopening, authorised correction and downstream conflict review;
- immediate result publication plus private repair schedule;
- five-sport scorecard invariants;
- printed fallback rendering;
- score-write and public-update p95 targets;
- real iOS and low-end Android completion.

Required browser projects include desktop Chromium, desktop Firefox, desktop WebKit/Safari-equivalent, phone Chromium and phone WebKit. Gate C must also contain a real-device receipt for iOS and a budget Android model.

## 6. Evidence package

The immutable exact-SHA package must include:

- commit SHA and clean-tree proof;
- toolchain/browser/device versions;
- command ledger and pass/fail/skip counts;
- database migrations and backup restore result;
- access, lease and transfer audit excerpts with secrets redacted;
- offline queue/replay traces with opaque IDs only;
- load-test configuration, latency percentiles and error rate;
- service-worker lifecycle evidence;
- screenshots for online, offline, pending, conflict, read-only, transfer and finalised states;
- PDF checksums and visual inspection record;
- public version monotonicity and cache-freshness oracles;
- independent review with exact reviewed SHA, `P0: 0` and `P1: 0`.

## 7. External decisions and blockers

These must be resolved before Gate C certification:

- signed four-hour offline policy and permitted offline actions;
- explicit takeover policy when the old device has pending events;
- real iOS and low-end Android device availability;
- representative local organiser scoring session;
- pilot score-write/public-read load targets and expected concurrency;
- approved public/minor/referee visibility policy;
- printed fallback content owner and operational distribution process.

## 8. Gate C QC verdict

**Verdict: BLOCKED**

The online Canoe Polo vertical slice is a strong foundation, but the gate still lacks P0 offline durability, five-sport scoring parity, complete transfer/read-only/heartbeat behavior, affected-match repair, printed fallback, real-device evidence and load qualification. Do not mark Gate C complete or merge a Gate C verdict until every item above is exact-SHA tested and independently reviewed.
