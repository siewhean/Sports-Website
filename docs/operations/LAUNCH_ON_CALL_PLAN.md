# Launch On-Call Plan & Deployment Freeze Protocol

**Status:** Active  
**Date:** 15 October 2026  
**Track:** R8.6 (Release candidate, rehearsal and launch)  
**Applies to:** Production deployment freezes, launch weekend on-call coverage, incident response, post-launch review

---

## 1. Overview & Objectives

Deliverable **R8.6** establishes operational guardrails for launch:

1. **Deployment Freeze Rules:** Restricting production changes around live competition weekends.
2. **On-Call Plan:** Clear shift responsibilities and escalation channels for the first two event weekends.
3. **Post-Launch Review:** Structured debrief protocol following the first three live events.

---

## 2. Production Deployment Freeze Protocol

To guarantee platform stability during live tournaments, production deployments follow strict freeze windows:

```
[ Wednesday 23:59 SGT ] ---- Code Freeze Begins ----
   • No new feature releases
   • Only critical security/hotfix patches permitted (requires owner approval)
[ Thursday - Friday ]     ---- Pre-Weekend Health Audits ----
   • Automated health checks & database backup verification
[ Saturday - Sunday ]     ---- Live Tournament Weekend ----
   • ZERO non-emergency deployments permitted
[ Monday 06:00 SGT ]    ---- Code Freeze Lifted ----
```

### Freeze Exceptions

A deployment during an active freeze requires an **Emergency Hotfix** justification:

1. P1 outage affecting active scoring or data corruption.
2. Changes must be tested against the staging replica first.
3. Rollback drill script [`scripts/run-gate-f-rollback-drill.mjs](../../scripts/run-gate-f-rollback-drill.mjs) must be ready if health fails.

---

## 3. On-Call Coverage for First Two Event Weekends

### 3.1 On-Call Schedule

- **Weekend 1:** Saturday 08:00 – Sunday 20:00 SGT (Lead Operator)
- **Weekend 2:** Saturday 08:00 – Sunday 20:00 SGT (Lead Operator)

### 3.2 Response Time SLOs

- **Severity 1 (Critical):** Score recording unavailable or database outage.
  - Acknowledgment: $< 5\text{ minutes}$.
  - Mitigation / Workaround: $< 15\text{ minutes}$.
- **Severity 2 (Major):** Public projection delay or spectator match centre degradation.
  - Acknowledgment: $< 15\text{ minutes}$.
  - Resolution: $< 60\text{ minutes}$.
- **Severity 3 (Minor):** Cosmetic display defect or non-critical background export.
  - Addressed during regular weekday sprint.

### 3.3 Escalation Channels

- Primary Alerting: Sentry Alert Rules (Spike & New Error webhooks) -> Notification Channel.
- Host Access: Direct SSH to production OCI instance using authenticated SSH key.
- Emergency Database Access: [Break-Glass Procedure](BREAK_GLASS.md).

---

## 4. Post-Launch Review Protocol

Following the completion of the first three live events on Matchday, the operator conducts a formal post-launch review evaluating:

1. **System Performance:** Observed p95 score-write latency and spectator response times against load test baselines.
2. **Error Budget & Sentry Trends:** Unhandled exception count, 5xx error frequency, and client-side crash rate.
3. **Operational Incidents:** Analysis of any failover, connection drop, or fallback score-sheet usage.
4. **Organiser Feedback:** Usability bottlenecks observed during registration, scheduling, or live scoring.
5. **Action Items:** Recorded in GitHub issues for subsequent maintenance releases.
