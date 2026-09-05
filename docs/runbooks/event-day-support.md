# Event-Day Support Runbook

**QA-017 — Phase 7 deliverable**

**Status:** DRAFT — requires tabletop exercise before Gate D sign-off

**Owner:** Engineering / Operations

**Last tabletop exercise:** _not yet conducted_

---

## Pre-event checklist (T-24 h)

- [ ] Verify production deployment SHA matches certified Gate D/E candidate
- [ ] Confirm database backup completed successfully in the last 24 h
- [ ] Verify scoring Redis connectivity and queue depth = 0
- [ ] Send test email and confirm delivery (check SMTP provider dashboard)
- [ ] Verify Vercel edge is serving the competition public page correctly
- [ ] Check worker health endpoint
- [ ] Confirm printed fallback pack (QA-018) is available at venue

---

## Organiser onboarding (T-2 h)

- [ ] Walk organiser through competition dashboard
- [ ] Confirm schedule is published and visible on public page
- [ ] Confirm all match entries exist for round 1
- [ ] Verify organiser has admin access to make corrections
- [ ] Share emergency contact number

---

## Scoring device checks (T-30 min)

- [ ] Each scoring device loads the QR scan page
- [ ] QR codes scan correctly on each device
- [ ] At least one device tested in airplane mode → score queued offline
- [ ] Reconnect device → verify offline score replays to server
- [ ] Fallback code verified for each court/match

---

## During event: normal operations

### Score entry flow

1. Official scans QR code → scorekeeper opens
2. Official enters score → submit
3. Organiser sees result on dashboard within 2 s
4. Public page shows result within 2 s
5. Standings update automatically after each match

### Monitoring during event

- Watch worker queue depth (should stay near 0)
- Watch API error rate (should be < 0.1%)
- Watch for scoring device reconnection events in logs

---

## Poor connectivity procedure

If a scoring device loses connectivity:

1. Score continues to be entered normally — scores are queued locally
2. When connectivity restores, scores replay automatically
3. If reconnect does not happen within 5 min: use fallback code to submit via organiser dashboard
4. If organiser dashboard is also unreachable: record score on paper; submit via organiser dashboard once connectivity restores
5. Standings and public page will update automatically once scores are submitted

---

## Scoring device replacement

If a device fails mid-event:

1. Retrieve replacement device
2. Navigate to the QR code URL (organiser can resend it, or display it from dashboard)
3. Scan QR → verify match is shown correctly
4. Continue scoring from current state (server state is authoritative; no score loss if prior scores were submitted)

---

## Schedule intervention

If a match needs to be rescheduled or moved:

1. Organiser opens schedule editor
2. Drag match to new slot, or use swap function
3. Confirm republish
4. Public page updates immediately
5. If match was already in progress: do not move; handle via correction after completion

---

## Erroneous result correction

If a score was entered incorrectly:

1. Organiser opens match result in dashboard
2. Click "Correct result"
3. Enter correct score
4. Confirm — standings and public page update automatically
5. If correction is disputed: record on paper; resolve after event; apply correction within 24 h

---

## Service degradation responses

| Symptom                    | Likely cause           | First response                                     |
| -------------------------- | ---------------------- | -------------------------------------------------- |
| QR scan fails              | Auth service issue     | Use fallback code                                  |
| Offline replay not sending | Redis / worker issue   | Escalate to engineering; use paper record          |
| Public page blank          | Vercel / edge issue    | Direct spectators to organiser to read out results |
| Standings not updating     | Worker queue backed up | Check worker health; escalate if queue > 100       |
| Score entry returns error  | API issue              | Use fallback code; record on paper                 |

---

## Offline mode

The scoring app continues to function without network. Scores are queued locally and replay when connectivity returns. There is **no action required** from the official during an outage — just continue scoring normally.

The organiser will see a "pending sync" indicator on the dashboard. Once connectivity restores, all pending scores appear within 10 s.

---

## Escalation path

| Condition                                        | Action                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| Any scoring outage > 5 min with no self-recovery | Call engineering on-call                                             |
| Standings visibly wrong after match result       | Call engineering; suspend public display if possible                 |
| Full platform outage                             | Activate printed fallback; continue event on paper; call engineering |

---

## Event closeout

- [ ] Verify all match results are submitted (no pending scores in queue)
- [ ] Confirm final standings are visible on public page
- [ ] Export results CSV from organiser dashboard
- [ ] Confirm organiser has received results export
- [ ] Take post-event database backup
- [ ] Record any discrepancies or interventions in the pilot event log

---

## Tabletop exercise record

| Date          | Scenario | Participants | Outcome | Follow-up actions |
| ------------- | -------- | ------------ | ------- | ----------------- |
| _not yet run_ | —        | —            | —       | —                 |

**Gate D requirement:** at least one tabletop exercise completed before certification.
