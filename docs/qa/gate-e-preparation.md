# Gate E — national parallel pilot preparation and QC contract

**Status:** PREPARED / BLOCKED

**Dependency chain:** Gate D independent `PASS` → resolved pilot findings → national release candidate → Gate E.

This commit is preparation only and must be rebased onto the final Gate D-certified source.

## 1. Gate contract

Gate E is a national-level competition operated in parallel with the organiser’s established process. It requires:

- a completed national parallel competition;
- every critical schedule and score path exercised;
- public pages qualified for the expected load;
- the support runbook active during the event;
- every major discrepancy investigated and resolved;
- a separate independent QA/QC `PASS`.

Gate E is not a larger Gate D rehearsal. It tests organisational scale, public trust, support load, operational handover, browser/device diversity and national-level rule/format complexity while preserving an independent fallback process.

## 2. Entry criteria

### Prior gates and source

- Gate D evidence is immutable, exact-SHA and independently approved.
- All Gate D P0/P1 findings are closed with regression evidence.
- The Gate E candidate SHA is frozen after complete automated, security, load and recovery validation.
- The national competition’s sport-pack version, rules, placement behavior and exceptional-case policy are signed by the organiser.

### Commercial, legal and privacy

- Required Phase 6 entitlement/billing/support/export features are complete for the pilot terms.
- Public/minor/referee visibility, consent, retention, deletion and correction policies are approved.
- Terms, privacy and cookie notices used during the pilot are legally reviewed for the target jurisdiction.
- Data processing and support responsibilities are explicit between the platform and organiser.

### Operations

- Staging and pilot environments are isolated.
- Monitoring, alerting, log aggregation, error tracking and on-call routing are active.
- Status and incident communication channels exist, even if the public status page is still pre-Gate F.
- Backup/restore, deployment rollback, cache purge and feature-flag kill switches have current rehearsal evidence.
- A support rota covers setup, event hours and post-event correction/export windows.

## 3. Current readiness audit

| Area | Foundation | Gate E gap |
| --- | --- | --- |
| Core deterministic engines | Substantial format, schedule, score, standings, bracket and publication foundations | Must inherit certified Gate C/D source and national fixtures |
| Public projection/versioning | Versioned schedule/result projections exist | Need expected-load, cache-purge and confirmed-current evidence under national traffic |
| Auditability | Audit/outbox foundations exist | Need complete national intervention/discrepancy ledger and support ownership |
| Browser automation | Phone/tablet/desktop automation exists | Need Firefox/Edge plus real Mobile Safari and budget Android receipts |
| Recovery | Local backup restore and process cleanup exist | Need production-like RTO/RPO, rollback and provider recovery drills |
| Security | Headers, same-origin BFF boundaries, scoped tokens and secret scanning exist | Need independent penetration test and closure of all high/critical findings |
| Support | Documentation foundations exist | Need trained staffed runbook used during the event |
| National evidence | None authoritative yet | National organiser, competition and independent fallback process are external blockers |

## 4. National pilot design

### 4.1 Selection criteria

Use a competition with:

- national organiser ownership and signed parallel-pilot agreement;
- representative number of entries, divisions, playing areas and public spectators;
- rule/placement patterns not fully covered by the local pilot;
- multiple scorekeeping devices and operators;
- predictable existing tools/process for independent comparison;
- an explicit decision that the platform is not the sole source of truth during Gate E.

Freeze a national pilot manifest containing:

- candidate SHA and immutable artifact identifiers;
- competition, division and entry counts;
- format and sport-pack hashes;
- published schedule version at event start;
- expected concurrent scorekeepers and spectators;
- supported browser/device floor;
- named organiser, manual-calculation, support, incident and communications leads;
- fallback artefacts and escalation contacts;
- SLO/load expectations.

### 4.2 Critical-path coverage matrix

Every path below must be exercised either naturally or through a controlled rehearsal adjacent to the event:

- organiser setup, format, schedule generation and explicit publication;
- multi-division/shared-area scheduling;
- match lock and move;
- playing-area outage and affected-match repair;
- QR access and fallback code;
- one-writer fencing and takeover;
- read-only scoring view;
- offline queue, restart, ordered replay and pending finalisation;
- transfer with pending events/conflict resolution;
- every score event used by the pilot sport;
- reversal, reopening and authorised correction;
- downstream conflict after a dependent match starts;
- immediate result/public version update;
- standings, advancement and bracket recalculation;
- public overview, schedule, tables, brackets, search and next-match views;
- printed fallback;
- export and post-event correction/support flow.

## 5. Load and resilience qualification

Before the event, reproduce at least the expected peak plus agreed safety headroom.

Measure:

- score-write p50/p95/p99 and error rate;
- finalisation-to-public p50/p95/p99;
- public read throughput and cache hit/miss behavior;
- queue depth and drain time;
- database primary/read-replica lag where applicable;
- SSE/WebSocket/poll fallback behavior;
- CPU, memory, connection-pool and Redis usage;
- autoscaling or manual scaling response;
- cache purge propagation;
- alert delivery time.

Required resilience drills:

1. API instance restart while scoring leases are active;
2. worker restart with queued jobs;
3. Redis interruption/recovery without accepted-event loss;
4. database failover/restore simulation in staging;
5. CDN stale-object purge;
6. failed deployment and automatic rollback;
7. status/incident communication exercise;
8. on-call escalation and handover.

The pilot must stop or revert to the established process if authoritative state cannot be established quickly.

## 6. Security and privacy qualification

Complete an independent penetration test covering at least:

- QR/fallback-code entropy, enumeration and rate limits;
- session sealing, fixation, replay, transfer and revocation;
- stale writer generation and offline replay manipulation;
- object/tenant authorization;
- BFF origin/forwarded-host handling;
- injection, SSRF, XSS and CSP;
- public privacy controls and minor data;
- support/admin access;
- logs, analytics, referrers and error payloads for secret/PII leakage;
- file/PDF exports;
- dependency and supply-chain integrity.

No unresolved critical or high finding may enter the event. Any accepted lower-severity finding needs owner, deadline and compensating control.

## 7. Parallel-run evidence

Capture:

- independent manual schedule/standings/bracket/result record;
- every platform/manual discrepancy with timestamp and severity;
- every organiser intervention and why it was necessary;
- scorekeeper completion and support-contact rate;
- public latency/availability and cache freshness;
- device/browser/network matrix;
- offline, transfer, correction and repair receipts;
- incident and support timeline;
- security/monitoring/alert receipts;
- post-event exports and corrections;
- organiser, official and support attestations;
- independent review tied to the exact deployed SHA.

Every major discrepancy must reach one of these dispositions:

- platform defect fixed and regression-tested;
- manual process error demonstrated with evidence;
- approved policy/rule ambiguity resolved and documented;
- non-blocking usability issue with owner/deadline;
- unresolved—therefore Gate E fails.

## 8. Stop and rollback rules

Immediately use the established process as authority when any of these occur:

- data loss, duplicate accepted score or event reordering;
- conflicting active writers;
- incorrect official result/advancement;
- unresolvable platform/manual divergence;
- stale public result that cannot be purged/confirmed-current;
- cross-tenant or private-data exposure;
- support/on-call unavailability for a critical issue;
- inability to restore or roll back;
- alerting/monitoring blind spot during active failure.

Gate E requires `P0: 0` and `P1: 0` after all national-pilot defects are resolved and the exact corrected SHA is revalidated.

## 9. Gate E evidence checklist

- [ ] Gate D exact-SHA `PASS` exists.
- [ ] National organiser agreement and pilot manifest exist.
- [ ] Existing process remains operational in parallel.
- [ ] Full automated/security/accessibility/visual ledger passes.
- [ ] Penetration-test critical/high findings are zero.
- [ ] Expected-load plus headroom qualification passes.
- [ ] All critical schedule and score paths are exercised.
- [ ] Real iOS, low-end Android, Chrome, Firefox, Safari and Edge evidence exists.
- [ ] Support runbook is staffed and used.
- [ ] Alert, rollback, restore and cache-purge drills pass.
- [ ] Manual and platform standings/brackets/results reconcile.
- [ ] Every major discrepancy is investigated and resolved.
- [ ] No P0 or P1 remains.
- [ ] Independent reviewer records exact SHA, `P0: 0`, `P1: 0`, `Verdict: PASS`.

## 10. Gate E QC verdict

**Verdict: BLOCKED**

Gate E remains blocked by Gate C/D completion, national pilot partnership, Phase 6/legal/security readiness, hosted operational evidence, real traffic/device coverage and a completed parallel national event. Source preparation reduces ambiguity but cannot substitute for the required empirical evidence.
