# Live Rehearsal Operations Runbook (Awaiting Live Execution)

**Status:** Awaiting Live Execution / Pending Human Organiser  
**Date:** 15 October 2026  
**Track:** R8.4 (Release candidate, rehearsal and launch)  
**Applies to:** Production tournament rehearsal, court scorekeeping, spectator access, paper fallback

---

## 1. Overview & Objectives

Deliverable **R8.4** requires running one real small event (e.g. a friendly tournament or local club competition) on production, with the printed scoresheet fallback prepared and verified in advance.

> [!WARNING]
> **Execution Status: Awaiting Live Execution.**  
> This live rehearsal requires a real human organiser and real physical matches at a venue. Simulated and automated load tests cannot replace real-world device and court operation. This document details the exact protocol to be executed by the operator.

---

## 2. Event Scope & Pre-Requisites

### 2.1 Event Parameters

- **Sport:** Any supported sport (e.g. Badminton, Volleyball, or Football).
- **Scale:** 4 to 8 teams, single division, 1 or 2 courts/pitches.
- **Duration:** Half-day (approx. 3–4 hours).
- **Participants:** Local club, scrimmage, or friendly exhibition.

### 2.2 Pre-Event Checklist

- [ ] Candidate SHA deployed to production ([`matchday.poladex.shop`](https://matchday.poladex.shop)).
- [ ] Production organiser account created and verified.
- [ ] Competition created via organiser portal with venue, courts, and team entries.
- [ ] Format configured and materialised (e.g. 4-team elimination or round robin).
- [ ] Schedule published and public match URLs verified.
- [ ] **Printed Fallback Ready:** Paper score-sheets printed for every scheduled fixture before competition starts.
- [ ] Two scoring devices charged (primary mobile phone + backup tablet/phone) with browser caching enabled.

---

## 3. Execution Protocol

### Step 1: Pre-Match Setup & Scorer Handoff

1. Open the organiser match management interface on production.
2. Generate scorer pass / QR code for the court scorekeeper.
3. On the scorekeeper device, scan the QR code to open the match scoring interface.
4. Verify that the scorekeeper interface acquires a valid writer lease and connects via WebSocket / SSE live stream.

### Step 2: Live Court Scoring

1. Score the matches live on the device as points/goals are scored.
2. Verify:
   - Score update latency is instantaneous on the scorer UI ($< 500\text{ ms}$).
   - Spectator view ([`matchday.poladex.shop/competitions/...`](https://matchday.poladex.shop)) updates live within $2\text{ seconds}$.
   - If a score entry is mistyped, verify the **Undo / Reversal** function restores the previous state cleanly.
3. Complete and finalize the match. Confirm the final result propagates to the tournament bracket and standings.

### Step 3: Fallback Verification Drill

1. Simulate network disconnection by toggling **Airplane Mode** on the scorekeeper device during one game.
2. Confirm that offline points are buffered locally.
3. If device battery fails or network cannot recover:
   - Immediately switch to the pre-printed paper scoresheet.
   - Continue manual paper tracking on court.
   - Once connectivity resumes or post-match, enter the verified final scores via the organiser manual result entry tool.

---

## 4. Post-Rehearsal Debrief & Verification Evidence

Following the live event, record the operational receipt in `docs/qa/track-r8.md`:

1. **Event Name & Date:**
2. **Total Matches Played:**
3. **Scoring Device Model & OS:**
4. **Observed Network Conditions (Cellular 4G/5G / Venue Wi-Fi):**
5. **Incidents or Discrepancies:** (e.g. lease timeouts, reconnection delays)
6. **Fallback Usage:** (Whether paper scoresheet was used and reconciliation status)
7. **Operator Sign-off:** Signature and timestamp.
