# ADR 0008 — Competition-Day Robustness: Product & Presentation Decisions

**Status:** Accepted  
**Date:** 13 October 2026  
**Applies to:** Track R2 Competition-Day Operations, Public Match Presentations, and Format Recommendations

## Context

During tournament execution, organizers encounter operational exceptions—unplayed matches due to forfeit/walkover, multi-pool round-robin group stages, and format selection constraints against finite venue capacity.

Previously, these behaviors had conflicting product interpretations:

1. Walkover presentation lacked standardisation: whether to display artificial forfeit scorelines (e.g. 21-0, 21-0 in badminton) or an explicit "W/O" label.
2. Multi-group round-robin stages risked confusing participants if grouped standings were merged into an ambiguous single table.
3. Format recommendations could silently omit formats or present formats that failed during schedule generation when capacity was tight.

## Architectural & Product Decisions

### 1. Walkover Display Strategy

- **Presentation Rule:** On public fixture lists, match summary cards, and live boards, matches settled via walkover/forfeit must display a distinct **"W/O"** (Walkover) badge alongside the winning entrant.
- **Score Integrity:** The underlying database and domain engine continue to record and project the authoritative forfeit scoreline defined by the sport pack (e.g. 3–0 for Canoe Polo, 2–0 sets for Badminton/Volleyball). In detailed score views, this is styled as `W/O (Forfeit score: X–Y)` so standings math is mathematically transparent to competitors.

### 2. Group Standings Separation

- **Presentation Rule:** When a division's format contains multiple distinct pools/groups (e.g. Group A, Group B), the standings view renders separate, semantic per-group tables.
- **Rationale:** Qualification to knockout stages depends on group rank (`r:groups:G1:1`, etc.). Merging disparate pools into one aggregate division view misleads teams regarding their qualification cutoff. An optional aggregate cross-group view may only be shown for multi-stage wildcard seeding.

### 3. Format Recommendation Capacity Disclosures

- **Presentation Rule:** When an organiser browses format templates, templates whose required match slots exceed available venue capacity must **not** be silently hidden or trigger unexpected 5xx/422 schedule errors.
- **UI Disclosure:** Recommended formats that exceed venue limits are presented with a clear diagnostic badge: _"Requires more courts or extended hours (N slots required vs M slots available)"_, guiding the organiser to either increase court availability or choose a more compact format.

## Consequences

- Spectators and players immediately see why a match finished without live play.
- Pool qualifications are unambiguous across all 5 sports.
- Organisers are provided transparent feedback during format configuration rather than schedule solver failures.
