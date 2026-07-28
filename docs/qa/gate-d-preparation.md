# Gate D — closed local pilot preparation and QC contract

**Status:** PREPARED / BLOCKED

**Dependency chain:** final Gate B `PASS` → final Gate C `PASS` → Phase 6 commercial/operational completeness → Gate D pilot.

This commit is preparation only. It must be rebased onto the final Gate B and Gate C source before use.

## 1. Gate contract

Gate D is a complete local competition run in parallel with the organiser’s existing process. It requires:

- no unresolved data-loss defect;
- standings that match independent manual calculations;
- officials who complete scoring without developer intervention;
- tested database restore and scoring-device replacement procedures;
- a separate independent QA/QC `PASS`.

Phase 7 owns `QA-001–017` and `QA-019–030`; Gate D is centred on the local pilot (`QA-019`) and its supporting quality, security, device, recovery and operational evidence. Relevant suites must already exist from earlier phases—Phase 7 expands and audits them rather than creating evidence after the event.

## 2. Entry criteria

Do not schedule the pilot until all criteria below are true.

### Product and domain

- Gate C exact-SHA evidence is complete and independently approved.
- All five sport packs and Gate C scoring paths required by the selected pilot sport are certified.
- The pilot competition format, exceptional-case policy, placement rules, withdrawal/forfeit policy and public visibility policy are signed by the organiser.
- Event Pass, entitlement, support and export behavior required for the pilot are available without production-only manual database edits.

### Reliability

- The complete automated ledger is green on the pilot release candidate.
- Four-hour offline scoring, transfer with pending events, correction/downstream conflict and printed fallback have been rehearsed.
- Backup restore has been executed against a production-like data volume.
- Deployment rollback and feature-flag kill switches have been exercised in staging.
- Public-read and score-write load tests exceed the pilot concurrency with headroom.

### People and operations

- A named independent organiser owns event decisions.
- A named support lead is available for the full event window.
- Officials receive a short training script and printed fallback pack.
- Support, incident, data-correction and escalation runbooks are approved.
- The existing spreadsheet/paper process remains authoritative fallback for the pilot.

## 3. Current repository readiness audit

| Capability | Current foundation | Gate D gap |
| --- | --- | --- |
| Deterministic competition engines | Format, schedule, score-event, standings/bracket and publication foundations exist | Must be certified through Gate C and pilot fixtures |
| Audit/outbox | Shared audit and transactional outbox patterns exist | Pilot evidence must prove every intervention/discrepancy is captured |
| Local infrastructure | PostgreSQL, Redis, Mailpit and repeatable local setup exist | Need staging/pilot environment, monitoring and operator access |
| Backup restore | Automated local restore verification exists | Need production-like restore rehearsal, timed RTO/RPO evidence and operator runbook |
| Browser automation | Organiser and scoring browser harnesses exist | Need full event journey plus real devices and pilot-specific fixtures |
| Public projections | Versioned public projection foundation exists | Need load/freshness evidence during a live parallel event |
| Support operations | Initial operational documents exist | Event-day staffing, escalation, communications and support receipts are absent |
| Pilot evidence | None is authoritative yet | Named organiser, competition artefacts and completed parallel event are external blockers |

## 4. Pilot design

### 4.1 Competition selection

Choose one closed local competition that is representative but recoverable:

- known organiser and venue;
- manageable entry count;
- at least two playing areas where possible;
- enough matches to exercise standings and advancement;
- at least two scoring devices;
- no sole-source dependence on the platform;
- consent to capture operational telemetry and intervention notes without unnecessary personal data.

Freeze a canonical pilot manifest before the event:

- competition/division/entry counts;
- sport and sport-pack version;
- format definition hash;
- schedule revision and publication version;
- participating devices/browser versions;
- expected spectator concurrency;
- named organiser/support roles;
- existing-process artefacts and manual calculation owner.

### 4.2 Parallel operation

The platform and existing process run concurrently.

- Officials enter scores in the platform.
- A separate operator records or receives scores through the existing process.
- Manual standings/bracket calculations are performed independently.
- The platform is never silently corrected to match the manual record; discrepancies are logged, investigated and corrected through authorised product workflows.
- The organiser decides whether a schedule repair is published.
- Printed fallback remains available at the venue.

### 4.3 Mandatory fault drills

Execute controlled drills without risking the real competition:

1. scoring device battery/network loss;
2. writer transfer to a second device;
3. four-hour-capable offline queue rehearsal using a shorter controlled window plus clock-controlled integration proof for the full duration;
4. browser refresh and device restart with pending events;
5. revoked/expired code;
6. incorrect score and authorised correction;
7. correction after a dependent match is prepared or started;
8. temporary playing-area outage and local repair revision;
9. public cache freshness check after result publication;
10. database restore and read-only verification using a captured pilot backup.

## 5. Evidence capture

Create an immutable pilot evidence directory tied to the exact candidate SHA and competition manifest.

Required records:

- start/end times and release SHA;
- environment and provider versions;
- organiser, official and support attestations;
- every score event receipt and publication version using opaque IDs;
- manual versus platform standings/bracket comparison;
- every organiser intervention, reason and outcome;
- every discrepancy, severity, root cause and disposition;
- device/network/service-worker logs;
- public and score-write latency/error measurements;
- transfer/offline/correction/repair drill results;
- backup and restore timing;
- screenshots at phone/tablet/desktop and real devices;
- accessibility spot check during real operation;
- support tickets and communication timeline;
- defect register and final independent review.

Do not store reusable access tokens, cookies, participant contact data, raw personal notes or unredacted environment dumps.

## 6. Severity and stop rules

### Immediate stop / fallback

- any lost or silently reordered score event;
- two accepted active writers for one match;
- incorrect final public score without visible conflict;
- standings/bracket divergence that cannot be explained immediately;
- private schedule revision exposed publicly;
- inability to identify the authoritative publication version;
- unrecoverable device transfer or offline queue;
- security or privacy exposure;
- restore failure.

### Release-blocking findings

- **P0:** data loss/corruption, security/privacy breach, incorrect official result/advancement, unrecoverable outage or cross-tenant access.
- **P1:** primary scoring/schedule/public journey unavailable without developer intervention, repeated offline/transfer failure, material accessibility barrier or failed recovery objective.

Gate D requires `P0: 0` and `P1: 0`. Findings fixed after the event require exact-SHA regression evidence and a new review; a historical pilot run does not certify changed source by itself.

## 7. Required automated and operational ledger

Before the event:

```text
frozen install
format/lint/typecheck
unit and integration suites
migration and backup checks
all solver/standings/scoring/offline/concurrent-device/correction suites
production build
browser E2E/accessibility/visual matrix
dependency and secret scans
score-write and public-read load tests
staging deployment/rollback smoke
```

During/after the event:

```text
manual standings comparison
official independent-scoring completion
device replacement drill
offline/reconnect receipt
public freshness receipt
organiser intervention ledger
support/incident timeline
backup restore drill
pilot defect closure
independent review
```

## 8. Gate D QC checklist

- [ ] Gate C exact-SHA `PASS` exists.
- [ ] Phase 6 prerequisites required for the pilot are complete.
- [ ] Pilot partner and signed competition manifest exist.
- [ ] Existing process is available as fallback.
- [ ] Officials can complete the workflow without developer intervention.
- [ ] Platform and manual standings/brackets match exactly.
- [ ] Every intervention and discrepancy is recorded.
- [ ] Device replacement, offline and restore drills pass.
- [ ] No P0 or P1 remains.
- [ ] Final reviewed SHA matches the deployed pilot SHA.
- [ ] Independent reviewer records `P0: 0`, `P1: 0` and `Verdict: PASS`.

## 9. Gate D QC verdict

**Verdict: BLOCKED**

The repository has strong deterministic and local-infrastructure foundations, but Gate D is inherently empirical. It cannot be made production-ready through source preparation alone. It remains blocked by Gate C, Phase 6 prerequisites, a named local pilot, real-device/operator evidence, production-like monitoring/recovery and an independently reviewed completed event.
