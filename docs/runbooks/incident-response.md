# Incident Response Runbook

**QA-016 — Phase 7 deliverable**

**Status:** DRAFT — requires tabletop exercise before Gate D sign-off

**Owner:** Engineering / Operations

**Last tabletop exercise:** _not yet conducted_

---

## Severity classification

| Level         | Definition                                                                                  | Response target                      | Examples                                                               |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| S1 — Critical | Production data loss, wrong published results, complete scoring outage affecting live event | Immediate; page on-call within 5 min | Committed score overwritten, standings corrupted, scoring auth broken  |
| S2 — High     | Core feature unavailable for >10 min, degraded live event with manual workaround possible   | Respond within 15 min                | Offline replay not replaying, public pages down, notifications failing |
| S3 — Medium   | Non-critical feature degraded, no active event affected                                     | Respond within 2 h                   | AI features down, export broken, email delayed                         |
| S4 — Low      | Cosmetic, logging, monitoring gap                                                           | Respond within 24 h                  | Dashboard metric missing, UI alignment regression                      |

---

## Detection

### Automated alerts (to configure in Phase 8)

- [ ] API error rate > 1% over 5 min → S2
- [ ] Score write p95 > 1 s over 2 min → S2
- [ ] Public page p95 > 5 s over 5 min → S3
- [ ] Worker queue depth > 500 → S3
- [ ] Failed migration on deploy → S1
- [ ] Database connection pool exhausted → S2
- [ ] Redis connection failure → S1

### Manual detection

- Support report from organiser or official
- Vercel / hosting status page
- GitHub Actions deployment failure

---

## Triage checklist

1. **Identify affected surface:** API / Web / Worker / Database / Redis / Email
2. **Reproduce or confirm:** check logs, recent deployments, status pages
3. **Assess scope:** how many competitions/events affected, is live scoring involved
4. **Classify severity:** use table above
5. **Check recent changes:** `git log --oneline -10` on production SHA
6. **Check if a rollback candidate exists:** previous deployed SHA

---

## Containment

### Immediate actions by surface

| Surface  | Action                                                                        |
| -------- | ----------------------------------------------------------------------------- |
| API      | Revert to previous deploy (Vercel instant rollback or re-deploy previous SHA) |
| Worker   | Stop worker, drain queue without processing, restore, restart                 |
| Database | Do not run DDL under incident; identify bad data writes from audit log        |
| Redis    | Flush only if confirmed no pending offline replays; check queue depth first   |
| Email    | Disable outbound if spamming; investigate SMTP provider status                |

### Do not during an S1/S2

- Do not run manual SQL `UPDATE`/`DELETE` without pair review and audit record
- Do not disable auth or rate limiting as a "quick fix"
- Do not close the incident until root cause is confirmed

---

## Escalation path

| Condition                                | Escalate to                                            |
| ---------------------------------------- | ------------------------------------------------------ |
| S1 active and not resolved within 30 min | Second engineer + product owner                        |
| Data loss confirmed                      | All stakeholders; pause all live events using Matchday |
| Security breach suspected                | Treat as S1; isolate; do not patch under pressure      |

---

## Communications

### Internal (S1/S2)

- Post in `#incidents` channel immediately on classification
- Update every 15 min until resolved

### External (S1 only affecting live event)

- Direct contact to affected organiser within 10 min of S1 confirmation
- Message: state the problem, estimated recovery time, manual fallback available
- Do not speculate on cause

---

## Rollback procedure

1. Identify the last known-good SHA from CI evidence
2. Verify that SHA's migrations are a subset of current production migrations (no rollback of applied migrations)
3. Re-deploy that SHA via Vercel (or equivalent)
4. Verify health endpoint responds
5. Confirm scoring, standings, public pages function
6. If migration rollback is needed: escalate; never apply down-migrations in production without data verification

---

## Evidence preservation

For every S1/S2 incident:

- Export API error logs for the window
- Capture database audit trail for the window (from `audit_entries` table)
- Record the exact deployed SHA at time of incident
- Take a database backup before any remediation
- Screenshot any public-facing error or incorrect data

---

## Post-mortem

Required for every S1; optional but recommended for S2.

Template fields:

- Incident ID and timeline
- Severity and impact (competitions affected, duration, users affected)
- Root cause
- Contributing factors
- Detection lag (when did it start vs when did we know)
- Resolution timeline
- Corrective actions (with owners and due dates)
- Monitoring improvements

Post-mortem must be completed within 5 business days of resolution.

---

## Tabletop exercise record

| Date          | Scenario | Participants | Outcome | Follow-up actions |
| ------------- | -------- | ------------ | ------- | ----------------- |
| _not yet run_ | —        | —            | —       | —                 |

**Gate D requirement:** at least one tabletop exercise completed before certification.
