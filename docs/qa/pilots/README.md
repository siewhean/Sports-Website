# Pilot Event Log Schema and Instructions

**QA-022 — Phase 7 deliverable**

**Status:** SCHEMA DEFINED — ready for use at local pilot (Gate D)

All pilot events — local and national — must be recorded using this log. The log is the primary evidence that QA-022 is satisfied and that QA-023 defect closures can be traced to specific pilot observations.

---

## Log location

Event logs for each pilot are stored as:

```
docs/qa/pilots/<pilot-id>/event-log.csv
docs/qa/pilots/<pilot-id>/summary.md
docs/qa/pilots/<pilot-id>/defects/
```

Where `<pilot-id>` is one of:

- `local-pilot-01` — closed local pilot (Gate D)
- `national-pilot-01` — national parallel pilot (Gate E)

---

## Schema

Each log entry is one row in `event-log.csv`:

| Field          | Type     | Description                                                                                                                   |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`           | integer  | Sequential row ID                                                                                                             |
| `timestamp`    | ISO 8601 | When the event occurred (local time + timezone)                                                                               |
| `competition`  | string   | Competition name or identifier                                                                                                |
| `role`         | enum     | `organiser` / `official` / `spectator` / `engineer`                                                                           |
| `workflow`     | enum     | `setup` / `schedule` / `scoring` / `correction` / `standings` / `offline` / `reconnect` / `notification` / `export` / `other` |
| `issue`        | boolean  | `true` if this row records a problem; `false` if it is a normal observation                                                   |
| `severity`     | enum     | `critical` / `high` / `medium` / `low` / `observation`                                                                        |
| `description`  | string   | What happened (plain English, be specific)                                                                                    |
| `expected`     | string   | What the system should have done                                                                                              |
| `actual`       | string   | What the system actually did (if different from expected)                                                                     |
| `intervention` | string   | What the observer or engineer did to recover (empty if no intervention needed)                                                |
| `resolution`   | enum     | `resolved` / `workaround` / `unresolved` / `n/a`                                                                              |
| `linked_issue` | string   | GitHub issue URL if a defect was filed (empty if n/a)                                                                         |
| `evidence`     | string   | Path to screenshot, log excerpt, or other file evidence                                                                       |

---

## Recording rules

1. **Record every organiser intervention**, even if it was trivial. If the organiser had to ask for help, that is an intervention.
2. **Record every unexpected system behaviour**, even if the user recovered without help.
3. **Do not retroactively clean up** entries. Record what happened, not what you wish happened.
4. **Time entries as they happen**, not at the end of the event.
5. **For every Critical or High severity row**, a GitHub issue must be filed before the pilot summary is written.

---

## Severity guide

| Severity    | Definition                                                                          |
| ----------- | ----------------------------------------------------------------------------------- |
| critical    | Data loss, wrong result committed, scoring impossible, standings wrong              |
| high        | Event flow blocked, offline recovery failed, schedule corrupted, severe performance |
| medium      | Usability friction, recoverable error, non-standard workflow required               |
| low         | Cosmetic, minor annoyance, one-off confusion                                        |
| observation | Normal operation; logged for telemetry purposes                                     |

---

## Post-pilot summary template

After each pilot, create `docs/qa/pilots/<pilot-id>/summary.md` with:

```markdown
# Pilot Summary — <pilot-id>

**Date:** <date>
**Duration:** <h>
**Competition:** <name>
**Divisions:** <n>
**Officials:** <n>
**Scoring devices used:** <n>
**Platform:** Matchday vX.Y (SHA: <sha>)
**Parallel process:** <manual / existing system / n/a>

## Participation

- Organisers: <n> (trained / untrained)
- Officials: <n>
- Spectators: <n> (estimated)

## Outcomes

- Matches scored: <n>
- Corrections applied: <n>
- Organiser interventions: <n> (<n> Critical, <n> High, <n> Medium, <n> Low)
- Standings discrepancies vs oracle: <n>
- Offline reconnect events: <n>

## Critical/High defects

| Defect | Severity | Issue | Status |
| ------ | -------- | ----- | ------ |
|        |          |       |        |

## Organiser assessment

<Free-text summary from organiser if available>

## QA-021 standing comparison result

| Match point | Matchday standings | Manual oracle | Match |
| ----------- | ------------------ | ------------- | ----- |
|             |                    |               |       |

## Gate condition

PASS / FAIL (all Critical and High resolved before sole-source use per QA-023)
```

---

## Telemetry to capture during pilot

Instrument or observe at minimum:

| Signal                      | Source                       | Collection method                      |
| --------------------------- | ---------------------------- | -------------------------------------- |
| API error rate              | Server logs                  | Log aggregator or manual grep          |
| Score write latency (p95)   | API response times           | Manual sampling or structured log      |
| Public page load time (p95) | Browser DevTools             | Manual measurement at spectator device |
| Worker queue depth          | Worker health endpoint       | Periodic poll                          |
| Offline reconnect events    | Service worker logs          | Browser console recording              |
| Correction events           | Organiser dashboard activity | Observer notes                         |
| Schedule interventions      | Organiser dashboard activity | Observer notes                         |

---

## Instructions for observers

- Assign one dedicated observer (non-engineer) per 10 officials
- The observer's job is to watch and record, not to assist
- Engineers may assist only after the observer records the problem
- If an engineer assists, record: what was the problem, what the engineer did, and whether the organiser could have recovered independently
