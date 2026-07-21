# Phase 0 local validation-pack acceptance

Scope: canonical competition fixtures plus provisional sport, exceptional-case, and public-data contracts. This gate does not substitute for partner, legal, or commercial sign-off.

## Acceptance checks

- [x] Exactly 8, 12, 16, 24, and 48-entry canonical competitions exist.
- [x] Each competition has compact, balanced, and participation-focused oracles.
- [x] Stable entry IDs, one initial placement, capacity, match count, guaranteed matches, and remaining-slot expectations are machine-checked.
- [x] At least one round-robin-only format is asserted, and a two-division fixture independently checks per-division and aggregate match counts.
- [x] The multi-division fixture carries bounded entry-availability constraints with valid entry references, dates, and operating-window times.
- [x] Canoe Polo’s specified 30-minute slot is used.
- [x] All five sport packs have an explicit initial product baseline.
- [x] Inferred numerical rules are visibly provisional rather than represented as federation rules.
- [x] Withdrawals, forfeits, late arrivals, abandoned matches, corrections, and ties have a default path and authority boundary.
- [x] Public fields, minors, contact data, referee names, retention, deletion, and exports are addressed.
- [x] Independent QA/QC completed.
- [ ] Design-partner, sport-domain, privacy/legal, and product-owner approvals completed.

## Known deferred fixture consumers

Execution Phase 3 owns the source Phase 4 golden stage graphs and deterministic generated matches (`FMT-008`–`FMT-016`). Execution Phase 4 owns source Phase 6 golden schedules and hard-constraint checks (`SCH-027`). Execution Phases 3-5 own the applicable results, standings, corrections, and withdrawal scenario outputs. The Phase 0 pack fixes the inputs and numerical oracles those consumers must preserve.
