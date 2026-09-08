import { describe, expect, it } from "vitest";
import { reduceFiveSportScoreEvents, type FiveSportScoreEvent } from "../src/index.js";

const gateDVolleyballSettings = {
  bestOf: 1,
  regularTargetPoints: 1,
  decidingTargetPoints: 1,
  winBy: 1,
  pointCap: 1,
};

function event(
  sequence: number,
  input: Partial<FiveSportScoreEvent> & Pick<FiveSportScoreEvent, "type">,
): FiveSportScoreEvent {
  return {
    eventId: `qa011-event-${sequence}`,
    clientEventId: `qa011-client-${sequence}`,
    matchId: "qa011-match-1",
    sequence,
    actorId: "qa011-official-1",
    scoringSessionId: "qa011-session-1",
    occurredAt: new Date(Date.UTC(2026, 8, 2, 12, 0, sequence)).toISOString(),
    ...input,
  };
}

describe("QA-011 result propagation lifecycle", () => {
  it("finalises an already-started Volleyball match after bounded load cleanup without restarting it", () => {
    const measuredAndCleaned = [
      event(1, { type: "match_started" }),
      event(2, { type: "point", side: "home", segmentNumber: 1 }),
      event(3, {
        type: "reversal",
        reversalTargetEventId: "qa011-event-2",
        reason: "QA-011 bounded endurance reversal",
      }),
    ];

    const neutral = reduceFiveSportScoreEvents("volleyball", measuredAndCleaned, gateDVolleyballSettings);
    expect(neutral).toMatchObject({
      lifecycle: "in_progress",
      score: { home: 0, away: 0 },
      totalPoints: { home: 0, away: 0 },
      segmentWins: { home: 0, away: 0 },
      winner: null,
      conflicts: [],
    });

    const finalised = reduceFiveSportScoreEvents(
      "volleyball",
      [
        ...measuredAndCleaned,
        event(4, { type: "point", side: "home", segmentNumber: 1 }),
        event(5, { type: "set_completion", side: "home", segmentNumber: 1 }),
        event(6, { type: "finalisation" }),
      ],
      gateDVolleyballSettings,
    );

    expect(finalised).toMatchObject({
      lifecycle: "finalised",
      score: { home: 1, away: 0 },
      totalPoints: { home: 1, away: 0 },
      segmentWins: { home: 1, away: 0 },
      winner: "home",
      conflicts: [],
      lastSequence: 6,
    });
  });
});
