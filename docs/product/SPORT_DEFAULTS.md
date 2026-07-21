# Phase 0 sport defaults

Status: **Provisional product baseline — design-partner confirmation required**

This document satisfies the local drafting portion of `VAL-004`. These are editable product starting points, not official federation rule profiles. A competition stores the sport-pack version and any division overrides so later default changes never rewrite an existing event.

## Shared contract

Every pack defines terminology, entry type, match structure, score hierarchy, event types, standings and tie-break options, forfeit behavior, scorecard configuration, validation rules, a suggested schedule slot, and recommended defaults. The organiser sees **Recommended** or **Customised** and can reset a customised division to the competition default.

| Sport        | Entry              |     Suggested slot | Initial match default                   | Default standings order                                         | Forfeit oracle |
| ------------ | ------------------ | -----------------: | --------------------------------------- | --------------------------------------------------------------- | -------------- |
| Canoe Polo   | Team               | 30 min — specified | 2 periods; manual period/event time     | Points, goal difference, goals scored, head-to-head, discipline | 3–0            |
| Badminton    | Singles or doubles |   20 min — confirm | Best of 3 games to 21, win by 2, cap 30 | Match wins, game difference, point difference, head-to-head     | 21–0, 21–0     |
| Table Tennis | Singles or doubles |   15 min — confirm | Best of 5 games to 11, win by 2, no cap | Match wins, game difference, point difference, head-to-head     | 11–0 × 3 games |
| Volleyball   | Team               |   45 min — confirm | Best of 3 sets; 25/25/15, win by 2      | Match wins, set ratio, point ratio, head-to-head                | 25–0, 25–0     |
| Basketball   | Team               |   40 min — confirm | 4 periods × 10 min; 5-min overtime      | Wins, head-to-head, point difference, points scored             | 20–0           |

All numerical values other than Canoe Polo’s 30-minute slot are provisional product recommendations. Design partners must test operational fit and governing bodies may require competition-specific overrides.

## Canoe Polo

- Terminology: team, player, pitch, goal, period.
- Events: goal, green/yellow/red card, timeout, incident, period change, reversal, finalisation.
- Scorer attribution is required. “Unknown scorer” is an organiser-enabled toggle, off by default, and creates a cleanup flag.
- No live clock and no shot-clock recording. Officials enter period and event time manually where enabled.
- Standings points: win 3, draw 1, loss 0; provisional until partner confirmation.
- Tie-break order: points, goal difference, goals scored, head-to-head, discipline. Any unresolved tie enters the audited resolution path in the exceptional-case policy.
- Forfeit score: 3–0 provisional and editable before the competition starts.
- Pilot placement proposal: third-place match plus classification matches for positions 5–8. This remains explicitly unapproved.

## Badminton

- Terminology switches between player/pair, court, game, point, match.
- Events: point, game completion, server change when enabled, retirement, walkover, reversal, finalisation.
- Default: best of 3 games, 21 points, win by 2, cap 30.
- Optional server indicator is off by default.
- Retirement preserves completed-game and current-game scores, records the retiring side, and applies the exceptional-case policy for advancement.

## Table Tennis

- Terminology switches between player/pair, table, game, point, match.
- Events: point, game completion, timeout, server change when enabled, retirement, walkover, reversal, finalisation.
- Default: best of 5 games, 11 points, win by 2, no point cap.
- Optional server indicator is off by default.

## Volleyball

- Terminology: team, court, set, point, match.
- Events: point, set completion, timeout, deciding set, reversal, finalisation.
- Default: best of 3 sets; first two to 25, deciding set to 15, all win by 2 with no cap.
- Standings default to match wins, set ratio, point ratio, then head-to-head. Ratio calculations must define zero-denominator handling in the domain implementation.

## Basketball

- Terminology: team, player, court, period, point, foul, match.
- Events: one/two/three-point score, team foul, player foul, timeout, period change, overtime, reversal, finalisation.
- Default: four 10-minute periods and successive 5-minute overtime periods until a winner is produced where a draw is not permitted.
- Manual period and event time only in MVP. The score sheet is basic; advanced analytics are out of scope.

## Confirmation checklist

- [ ] Independent organiser validates all five slot lengths and scorecard defaults.
- [ ] National-level organiser validates Canoe Polo scoring, standings, forfeit, and placement defaults.
- [ ] Sport-domain reviewers confirm the numerical match defaults and forfeit oracles.
- [ ] Product owner accepts the default tie-break order and unresolved-tie path.
- [ ] Confirmed values are versioned as sport pack `1.0.0`; rejected values are revised here before implementation.

Source: specification §§8.4, 16.1, 20; tasks `VAL-004`, `SPT-001`–`SPT-014`.
