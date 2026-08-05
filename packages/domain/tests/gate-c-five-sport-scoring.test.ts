import { describe, expect, it } from "vitest";
import { reduceFiveSportScoreEvents, type FiveSportScoreEvent, type MatchSide, type SportId } from "../src/index.js";

const MANUAL_TIME_EVENT_TYPES = new Set([
  "goal",
  "green_card",
  "yellow_card",
  "red_card",
  "timeout",
  "incident",
  "one_point_score",
  "two_point_score",
  "three_point_score",
  "team_foul",
  "player_foul",
]);

function event(
  sequence: number,
  input: Partial<FiveSportScoreEvent> & Pick<FiveSportScoreEvent, "type">,
): FiveSportScoreEvent {
  return {
    eventId: `event-${sequence}`,
    clientEventId: `client-${sequence}`,
    matchId: "match-1",
    sequence,
    actorId: "official-1",
    scoringSessionId: "session-1",
    occurredAt: new Date(Date.UTC(2026, 7, 1, 1, 0, sequence)).toISOString(),
    ...(MANUAL_TIME_EVENT_TYPES.has(input.type) ? { manualTimeSeconds: 30 } : {}),
    ...input,
  };
}

function start(): FiveSportScoreEvent {
  return event(1, { type: "match_started" });
}

function rally(
  firstSequence: number,
  homeScore: number,
  awayScore: number,
  segmentNumber: number,
  type = "point",
): FiveSportScoreEvent[] {
  const events: FiveSportScoreEvent[] = [];
  let sequence = firstSequence;
  let home = 0;
  let away = 0;
  while (home < Math.min(homeScore, awayScore)) {
    events.push(event(sequence++, { type, side: "home", segmentNumber }));
    home += 1;
    events.push(event(sequence++, { type, side: "away", segmentNumber }));
    away += 1;
  }
  while (home < homeScore) {
    events.push(event(sequence++, { type, side: "home", segmentNumber }));
    home += 1;
  }
  while (away < awayScore) {
    events.push(event(sequence++, { type, side: "away", segmentNumber }));
    away += 1;
  }
  return events;
}

function points(
  sportId: SportId,
  firstSequence: number,
  count: number,
  side: MatchSide,
  segmentNumber: number,
  type = "point",
): FiveSportScoreEvent[] {
  return Array.from({ length: count }, (_, offset) =>
    event(firstSequence + offset, {
      type: sportId === "basketball" ? type : type,
      side,
      segmentNumber,
      ...(sportId === "canoe_polo" ? { participantId: `player-${offset + 1}` } : {}),
    }),
  );
}

describe("Gate C five-sport deterministic scoring", () => {
  it("reduces Canoe Polo goals, permits a draw, and enforces scorer attribution", () => {
    const stream = [
      start(),
      event(2, { type: "goal", side: "home", participantId: "player-7", segmentNumber: 1 }),
      event(3, { type: "period_change", segmentNumber: 2 }),
      event(4, { type: "goal", side: "away", participantId: "player-8", segmentNumber: 2 }),
      event(5, { type: "finalisation" }),
    ];
    const state = reduceFiveSportScoreEvents("canoe_polo", stream);
    expect(state.score).toEqual({ home: 1, away: 1 });
    expect(state.lifecycle).toBe("finalised");
    expect(state.winner).toBeNull();
    expect(state.actions[0]).toMatchObject({ eventType: "goal", manualTimeSeconds: 30 });

    expect(() =>
      reduceFiveSportScoreEvents("canoe_polo", [start(), event(2, { type: "goal", side: "home", segmentNumber: 1 })]),
    ).toThrow(/participant attribution/);
  });

  it("supports the explicit unknown-scorer setting for Canoe Polo only", () => {
    const stream = [
      start(),
      event(2, { type: "goal", side: "home", unknownParticipant: true, segmentNumber: 1 }),
      event(3, { type: "period_change", segmentNumber: 2 }),
      event(4, { type: "finalisation" }),
    ];
    expect(() => reduceFiveSportScoreEvents("canoe_polo", stream)).toThrow(/participant attribution/);
    expect(
      reduceFiveSportScoreEvents("canoe_polo", stream, {
        allowUnknownScorer: true,
        scorerRequired: true,
      }).lifecycle,
    ).toBe("finalised");
  });

  it("rejects ambiguous known-and-unknown participant attribution in the authoritative stream", () => {
    expect(() =>
      reduceFiveSportScoreEvents(
        "canoe_polo",
        [
          start(),
          event(2, {
            type: "goal",
            side: "home",
            participantId: "player-7",
            unknownParticipant: true,
            segmentNumber: 1,
          }),
        ],
        { allowUnknownScorer: true },
      ),
    ).toThrow(/mutually exclusive/);
  });

  it("applies Badminton win-by and cap rules across a best-of-three match", () => {
    const first = rally(2, 21, 19, 1);
    const second = rally(43, 30, 29, 2);
    const stream = [
      start(),
      ...first,
      event(42, { type: "game_completion", side: "home", segmentNumber: 1 }),
      ...second,
      event(102, { type: "game_completion", side: "home", segmentNumber: 2 }),
      event(103, { type: "finalisation" }),
    ];
    const state = reduceFiveSportScoreEvents("badminton", stream);
    expect(state.segmentWins).toEqual({ home: 2, away: 0 });
    expect(state.score).toEqual({ home: 2, away: 0 });
    expect(state.winner).toBe("home");
  });

  it("rejects scoring after a segment has a winning score or reached its cap", () => {
    const decided = [start(), ...points("badminton", 2, 21, "home", 1), ...points("badminton", 23, 19, "away", 1)];
    expect(() =>
      reduceFiveSportScoreEvents("badminton", [
        ...decided,
        event(42, { type: "point", side: "away", segmentNumber: 1 }),
      ]),
    ).toThrow(/must be completed before more scoring/);

    const atCap = [start(), ...points("badminton", 2, 30, "home", 1), ...points("badminton", 32, 29, "away", 1)];
    expect(() =>
      reduceFiveSportScoreEvents("badminton", [...atCap, event(61, { type: "point", side: "home", segmentNumber: 1 })]),
    ).toThrow(/must be completed before more scoring/);
  });

  it("requires Table Tennis to win by two when no cap is configured", () => {
    const stream = [start(), ...points("table_tennis", 2, 10, "home", 1), ...points("table_tennis", 12, 10, "away", 1)];
    expect(() =>
      reduceFiveSportScoreEvents("table_tennis", [
        ...stream,
        event(22, { type: "point", side: "home", segmentNumber: 1 }),
        event(23, { type: "game_completion", side: "home", segmentNumber: 1 }),
      ]),
    ).toThrow(/does not meet the configured winning score/);

    const valid = [
      ...stream,
      event(22, { type: "point", side: "home", segmentNumber: 1 }),
      event(23, { type: "point", side: "home", segmentNumber: 1 }),
      event(24, { type: "game_completion", side: "home", segmentNumber: 1 }),
    ];
    expect(reduceFiveSportScoreEvents("table_tennis", valid).segments[0]).toMatchObject({
      home: 12,
      away: 10,
      completed: true,
      winner: "home",
    });
  });

  it("uses the lower deciding-set target for Volleyball", () => {
    let sequence = 2;
    const stream: FiveSportScoreEvent[] = [start()];
    for (const [segmentNumber, side, target] of [
      [1, "home", 25],
      [2, "away", 25],
      [3, "home", 15],
    ] as const) {
      stream.push(...points("volleyball", sequence, target, side, segmentNumber));
      sequence += target;
      stream.push(event(sequence, { type: "set_completion", side, segmentNumber }));
      sequence += 1;
    }
    stream.push(event(sequence, { type: "finalisation" }));
    const state = reduceFiveSportScoreEvents("volleyball", stream);
    expect(state.segmentWins).toEqual({ home: 2, away: 1 });
    expect(state.segments[2]).toMatchObject({ number: 3, home: 15, away: 0, completed: true });
    expect(state.winner).toBe("home");
  });

  it("uses 1, 2, and 3 point Basketball events and rejects a regulation draw", () => {
    const tiedRegulation = [
      start(),
      event(2, { type: "one_point_score", side: "home", segmentNumber: 1 }),
      event(3, { type: "two_point_score", side: "home", segmentNumber: 1 }),
      event(4, { type: "three_point_score", side: "away", segmentNumber: 1 }),
      event(5, { type: "period_change", segmentNumber: 2 }),
      event(6, { type: "period_change", segmentNumber: 3 }),
      event(7, { type: "period_change", segmentNumber: 4 }),
    ];
    expect(() =>
      reduceFiveSportScoreEvents("basketball", [...tiedRegulation, event(8, { type: "finalisation" })]),
    ).toThrow(/cannot be finalised as a draw/);
    const state = reduceFiveSportScoreEvents("basketball", [
      ...tiedRegulation,
      event(8, { type: "overtime", segmentNumber: 5 }),
      event(9, { type: "one_point_score", side: "home", segmentNumber: 5 }),
      event(10, { type: "finalisation" }),
    ]);
    expect(state.totalPoints).toEqual({ home: 4, away: 3 });
    expect(state.winner).toBe("home");
  });

  it("treats an identical repeated finalisation as idempotent", () => {
    const finalisation = event(4, { type: "finalisation" });
    const state = reduceFiveSportScoreEvents("canoe_polo", [
      start(),
      event(2, { type: "goal", side: "home", participantId: "player-1", segmentNumber: 1 }),
      event(3, { type: "period_change", segmentNumber: 2 }),
      finalisation,
      finalisation,
    ]);
    expect(state.lifecycle).toBe("finalised");
    expect(state.appliedEventIds).toHaveLength(4);
  });

  it("enforces participant attribution for sport-pack events and reverses zero-delta actions", () => {
    expect(() =>
      reduceFiveSportScoreEvents("basketball", [
        start(),
        event(2, { type: "player_foul", side: "home", segmentNumber: 1 }),
      ]),
    ).toThrow(/participant attribution/);

    const state = reduceFiveSportScoreEvents("basketball", [
      start(),
      event(2, {
        type: "player_foul",
        side: "home",
        participantId: "player-4",
        segmentNumber: 1,
      }),
      event(3, {
        type: "reversal",
        reversalTargetEventId: "event-2",
        reason: "Foul attributed to the wrong player",
      }),
    ]);
    expect(state.actions[0]).toMatchObject({ eventType: "player_foul", reversed: true });
  });

  it("is idempotent for identical client events and rejects changed reuse", () => {
    const score = event(2, { type: "two_point_score", side: "home", segmentNumber: 1 });
    const state = reduceFiveSportScoreEvents("basketball", [start(), score, score]);
    expect(state.totalPoints.home).toBe(2);
    expect(state.appliedClientEventIds).toHaveLength(2);
    expect(() => reduceFiveSportScoreEvents("basketball", [start(), score, { ...score, side: "away" }])).toThrow(
      /reused with different content/,
    );
  });

  it("rejects sequence gaps and mixed-match streams", () => {
    expect(() => reduceFiveSportScoreEvents("basketball", [event(2, { type: "match_started" })])).toThrow(
      /Expected score event sequence 1/,
    );
    expect(() =>
      reduceFiveSportScoreEvents("basketball", [
        start(),
        { ...event(2, { type: "one_point_score", side: "home" }), matchId: "match-2" },
      ]),
    ).toThrow(/mixes multiple matches/);
  });

  it("reopens a completed segment after a reversed score and surfaces later-segment conflict", () => {
    const stream = [
      start(),
      ...points("badminton", 2, 21, "home", 1),
      event(23, { type: "game_completion", side: "home", segmentNumber: 1 }),
      event(24, { type: "point", side: "away", segmentNumber: 2 }),
      event(25, { type: "reversal", reversalTargetEventId: "event-22", reason: "Point awarded in error" }),
    ];
    const state = reduceFiveSportScoreEvents("badminton", stream);
    expect(state.segments[0]).toMatchObject({ completed: false, winner: null, home: 20 });
    expect(state.currentSegment).toBe(1);
    expect(state.conflicts).toEqual([
      {
        code: "segment_reopened_after_reversal",
        segmentNumber: 1,
        targetEventId: "event-22",
        laterSegmentNumbers: [2],
      },
    ]);
    expect(() => reduceFiveSportScoreEvents("badminton", [...stream, event(26, { type: "finalisation" })])).toThrow(
      /conflicts must be resolved/,
    );
    expect(() =>
      reduceFiveSportScoreEvents("badminton", [
        ...stream,
        event(26, { type: "point", side: "home", segmentNumber: 1 }),
        event(27, { type: "game_completion", side: "home", segmentNumber: 1 }),
        event(28, { type: "finalisation" }),
      ]),
    ).toThrow(/conflicts must be resolved/);
  });

  it.each(["badminton", "table_tennis", "volleyball"] as const)(
    "atomically replaces the latest completed %s segment winner without retaining a false conflict",
    (sportId) => {
      const completionType = sportId === "volleyball" ? "set_completion" : "game_completion";
      const regularTarget = sportId === "badminton" ? 21 : sportId === "table_tennis" ? 11 : 25;
      const decidingTarget = sportId === "volleyball" ? 15 : regularTarget;
      const segmentCount = sportId === "table_tennis" ? 5 : 3;
      const stream: FiveSportScoreEvent[] = [start()];
      let sequence = 2;
      const latestSegmentPointIds: string[] = [];
      for (let point = 0; point < regularTarget; point += 1) {
        const scored = event(sequence++, { type: "point", side: "home", segmentNumber: 1 });
        stream.push(scored);
      }
      stream.push(event(sequence++, { type: completionType, side: "home", segmentNumber: 1 }));
      for (let segmentNumber = 2; segmentNumber <= segmentCount; segmentNumber += 1) {
        const side = segmentNumber % 2 === 0 ? "away" : "home";
        const target = segmentNumber === 3 ? decidingTarget : regularTarget;
        for (let point = 0; point < target; point += 1) {
          const scored = event(sequence++, { type: "point", side, segmentNumber });
          if (segmentNumber === segmentCount) latestSegmentPointIds.push(scored.eventId);
          stream.push(scored);
        }
        stream.push(event(sequence++, { type: completionType, side, segmentNumber }));
      }
      stream.push(
        event(sequence++, { type: "finalisation" }),
        event(sequence++, { type: "match_reopened", reason: "Correct the first segment winner" }),
      );
      for (const targetEventId of latestSegmentPointIds) {
        stream.push(
          event(sequence++, {
            type: "reversal",
            reversalTargetEventId: targetEventId,
            reason: "Point awarded to the wrong side",
          }),
        );
      }
      const replacementTarget = segmentCount === 3 ? decidingTarget : regularTarget;
      for (let point = 0; point < replacementTarget; point += 1) {
        stream.push(event(sequence++, { type: "point", side: "away", segmentNumber: segmentCount }));
      }
      stream.push(
        event(sequence++, { type: completionType, side: "away", segmentNumber: segmentCount }),
        event(sequence++, { type: "finalisation" }),
      );
      const corrected = reduceFiveSportScoreEvents(sportId, stream);
      expect(corrected.lifecycle).toBe("finalised");
      expect(corrected.winner).toBe("away");
      expect(corrected.conflicts).toEqual([]);
    },
  );

  it("allows an earlier Badminton winner correction after affected later play is explicitly unwound", () => {
    const stream: FiveSportScoreEvent[] = [start()];
    const pointIds = new Map<number, string[]>();
    let sequence = 2;
    for (const [segmentNumber, side] of [
      [1, "home"],
      [2, "away"],
      [3, "home"],
    ] as const) {
      const ids: string[] = [];
      for (let point = 0; point < 21; point += 1) {
        const scored = event(sequence++, { type: "point", side, segmentNumber });
        ids.push(scored.eventId);
        stream.push(scored);
      }
      pointIds.set(segmentNumber, ids);
      stream.push(event(sequence++, { type: "game_completion", side, segmentNumber }));
    }
    stream.push(
      event(sequence++, { type: "finalisation" }),
      event(sequence++, { type: "match_reopened", reason: "Correct the first game winner" }),
    );
    for (const segmentNumber of [3, 2, 1]) {
      for (const targetEventId of pointIds.get(segmentNumber) ?? []) {
        stream.push(
          event(sequence++, {
            type: "reversal",
            reversalTargetEventId: targetEventId,
            reason: "Unwind affected play before rebuilding",
          }),
        );
      }
    }
    for (const segmentNumber of [1, 2]) {
      for (let point = 0; point < 21; point += 1) {
        stream.push(event(sequence++, { type: "point", side: "away", segmentNumber }));
      }
      stream.push(event(sequence++, { type: "game_completion", side: "away", segmentNumber }));
    }
    stream.push(event(sequence++, { type: "finalisation" }));

    const corrected = reduceFiveSportScoreEvents("badminton", stream);
    expect(corrected).toMatchObject({ lifecycle: "finalised", winner: "away", conflicts: [] });
    expect(corrected.segmentWins).toEqual({ home: 0, away: 2 });
  });

  it("preserves completed play and requires explicit finalisation after retirement", () => {
    const retirement = [
      start(),
      ...points("badminton", 2, 10, "home", 1),
      ...points("badminton", 12, 7, "away", 1),
      event(19, { type: "retirement", side: "home", segmentNumber: 1 }),
    ];
    const pending = reduceFiveSportScoreEvents("badminton", retirement);
    expect(pending.lifecycle).toBe("in_progress");
    expect(pending.exceptionalOutcome).toBe("retirement");
    expect(pending.winner).toBe("home");
    expect(pending.totalPoints).toEqual({ home: 10, away: 7 });

    const finalised = reduceFiveSportScoreEvents("badminton", [...retirement, event(20, { type: "finalisation" })]);
    expect(finalised.lifecycle).toBe("finalised");
    expect(finalised.winner).toBe("home");
  });

  it("requires explicit reopening before post-final score changes", () => {
    const finalised = [
      start(),
      event(2, { type: "goal", side: "home", participantId: "player-1", segmentNumber: 1 }),
      event(3, { type: "period_change", segmentNumber: 2 }),
      event(4, { type: "finalisation" }),
    ];
    expect(() =>
      reduceFiveSportScoreEvents("canoe_polo", [
        ...finalised,
        event(5, { type: "goal", side: "away", participantId: "player-2", segmentNumber: 2 }),
      ]),
    ).toThrow(/must be reopened/);
    const reopened = reduceFiveSportScoreEvents("canoe_polo", [
      ...finalised,
      event(5, { type: "match_reopened", reason: "Confirmed scoring correction" }),
      event(6, { type: "reversal", reversalTargetEventId: "event-2", reason: "Goal entered for wrong side" }),
    ]);
    expect(reopened.lifecycle).toBe("in_progress");
    expect(reopened.totalPoints).toEqual({ home: 0, away: 0 });
  });

  it("rejects invalid effective sport settings before reducing events", () => {
    expect(() =>
      reduceFiveSportScoreEvents("badminton", [start()], {
        bestOf: 2,
      }),
    ).toThrow(/Invalid sport settings/);
  });

  it("rejects event types outside the selected sport pack", () => {
    expect(() =>
      reduceFiveSportScoreEvents("volleyball", [start(), event(2, { type: "three_point_score", side: "home" })]),
    ).toThrow(/not supported by Volleyball/);
  });
  it("prevents skipped regulation periods and premature deciding-set selection", () => {
    expect(() =>
      reduceFiveSportScoreEvents("canoe_polo", [start(), event(2, { type: "period_change", segmentNumber: 3 })]),
    ).toThrow(/Expected the next segment to be 2/);

    expect(() =>
      reduceFiveSportScoreEvents("volleyball", [start(), event(2, { type: "deciding_set", segmentNumber: 3 })]),
    ).toThrow(/not currently available/);

    const first = points("volleyball", 2, 25, "home", 1);
    const secondStart = 28;
    const second = points("volleyball", secondStart, 25, "away", 2);
    const deciding = reduceFiveSportScoreEvents("volleyball", [
      start(),
      ...first,
      event(27, { type: "set_completion", side: "home", segmentNumber: 1 }),
      ...second,
      event(53, { type: "set_completion", side: "away", segmentNumber: 2 }),
      event(54, { type: "deciding_set", segmentNumber: 3 }),
    ]);
    expect(deciding.currentSegment).toBe(3);
    expect(deciding.actions.at(-1)).toMatchObject({ eventType: "deciding_set", segmentNumber: 3 });
  });

  it("records segment completion in the immutable action history", () => {
    const stream = [
      start(),
      ...points("badminton", 2, 21, "home", 1),
      event(23, { type: "game_completion", side: "home", segmentNumber: 1 }),
    ];
    const state = reduceFiveSportScoreEvents("badminton", stream);
    expect(state.actions.at(-1)).toMatchObject({
      eventId: "event-23",
      eventType: "game_completion",
      side: "home",
      segmentNumber: 1,
      scoreDelta: 0,
    });
  });

  it("blocks post-retirement scoring until the exceptional outcome is reversed or finalised", () => {
    const retirement = event(2, { type: "retirement", side: "home", segmentNumber: 1 });
    expect(() =>
      reduceFiveSportScoreEvents("badminton", [
        start(),
        retirement,
        event(3, { type: "point", side: "away", segmentNumber: 1 }),
      ]),
    ).toThrow(/must be finalised or reversed/);

    const corrected = reduceFiveSportScoreEvents("badminton", [
      start(),
      retirement,
      event(3, {
        type: "reversal",
        reversalTargetEventId: retirement.eventId,
        reason: "Retirement was selected for the wrong match",
      }),
      event(4, { type: "point", side: "away", segmentNumber: 1 }),
    ]);
    expect(corrected.exceptionalOutcome).toBeNull();
    expect(corrected.winner).toBeNull();
    expect(corrected.totalPoints).toEqual({ home: 0, away: 1 });
    expect(corrected.actions.find((action) => action.eventId === retirement.eventId)).toMatchObject({ reversed: true });
  });

  it("rejects operational events attributed to a non-current segment", () => {
    expect(() =>
      reduceFiveSportScoreEvents("basketball", [
        start(),
        event(2, { type: "team_foul", side: "home", segmentNumber: 4 }),
      ]),
    ).toThrow(/current segment/);
  });

  it("requires timed sports to reach the configured regulation segment before finalisation", () => {
    expect(() =>
      reduceFiveSportScoreEvents("canoe_polo", [
        start(),
        event(2, { type: "goal", side: "home", participantId: "player-1", segmentNumber: 1 }),
        event(3, { type: "finalisation" }),
      ]),
    ).toThrow(/regulation segment 2/);

    expect(() =>
      reduceFiveSportScoreEvents("basketball", [
        start(),
        event(2, { type: "one_point_score", side: "home", segmentNumber: 1 }),
        event(3, { type: "finalisation" }),
      ]),
    ).toThrow(/regulation segment 4/);
  });

  it("allows Basketball overtime only from a tied regulation or overtime score", () => {
    expect(() =>
      reduceFiveSportScoreEvents("basketball", [
        start(),
        event(2, { type: "one_point_score", side: "home", segmentNumber: 1 }),
        event(3, { type: "period_change", segmentNumber: 2 }),
        event(4, { type: "period_change", segmentNumber: 3 }),
        event(5, { type: "period_change", segmentNumber: 4 }),
        event(6, { type: "overtime", segmentNumber: 5 }),
      ]),
    ).toThrow(/requires a tied score/);
  });

  it("requires manual event time when enabled for Canoe Polo and Basketball actions", () => {
    const { manualTimeSeconds, ...goalWithoutManualTime } = event(2, {
      type: "goal",
      side: "home",
      participantId: "player-1",
      segmentNumber: 1,
    });
    expect(manualTimeSeconds).toBe(30);
    expect(() => reduceFiveSportScoreEvents("canoe_polo", [start(), goalWithoutManualTime])).toThrow(
      /requires manual event time/,
    );

    expect(() =>
      reduceFiveSportScoreEvents("basketball", [
        start(),
        event(2, {
          type: "one_point_score",
          side: "home",
          segmentNumber: 1,
          manualTimeSeconds: null,
        }),
      ]),
    ).toThrow(/requires manual event time/);
  });

  it("rejects settings-disabled events when rebuilding the authoritative stream", () => {
    expect(() =>
      reduceFiveSportScoreEvents(
        "canoe_polo",
        [start(), event(2, { type: "timeout", side: "home", segmentNumber: 1 })],
        { timeoutsEnabled: false },
      ),
    ).toThrow(/disabled by the effective Canoe Polo settings/);
  });

  it("repairs and refinalises a reversed winning point when no later segment exists", () => {
    const stream: FiveSportScoreEvent[] = [start()];
    stream.push(...points("badminton", 2, 21, "home", 1));
    stream.push(event(23, { type: "game_completion", side: "home", segmentNumber: 1 }));
    stream.push(...points("badminton", 24, 21, "home", 2));
    stream.push(
      event(45, { type: "game_completion", side: "home", segmentNumber: 2 }),
      event(46, { type: "finalisation" }),
      event(47, { type: "match_reopened", reason: "Correct duplicated point" }),
      event(48, { type: "reversal", reversalTargetEventId: "event-44", reason: "Point entered twice" }),
      event(49, { type: "point", side: "home", segmentNumber: 2 }),
      event(50, { type: "game_completion", side: "home", segmentNumber: 2 }),
      event(51, { type: "finalisation" }),
    );

    const state = reduceFiveSportScoreEvents("badminton", stream);
    expect(state.lifecycle).toBe("finalised");
    expect(state.score).toEqual({ home: 2, away: 0 });
    expect(state.conflicts).toEqual([]);
    expect(state.actions.find((action) => action.eventId === "event-44")).toMatchObject({ reversed: true });
  });

  it("rejects operational and exceptional actions after a best-of match is clinched", () => {
    const clinched: FiveSportScoreEvent[] = [start()];
    clinched.push(...points("badminton", 2, 21, "home", 1));
    clinched.push(event(23, { type: "game_completion", side: "home", segmentNumber: 1 }));
    clinched.push(...points("badminton", 24, 21, "home", 2));
    clinched.push(event(45, { type: "game_completion", side: "home", segmentNumber: 2 }));

    expect(() =>
      reduceFiveSportScoreEvents("badminton", [
        ...clinched,
        event(46, { type: "retirement", side: "away", segmentNumber: 2 }),
      ]),
    ).toThrow(/already been clinched/);
    expect(() =>
      reduceFiveSportScoreEvents(
        "badminton",
        [...clinched, event(46, { type: "server_change", side: "home", segmentNumber: 2 })],
        { serverIndicatorEnabled: true },
      ),
    ).toThrow(/already been clinched/);
  });

  it("keeps an exceptional outcome active across reopen until an explicit reversal", () => {
    const finalised = [
      start(),
      event(2, { type: "retirement", side: "home", segmentNumber: 1 }),
      event(3, { type: "finalisation" }),
      event(4, { type: "match_reopened", reason: "Review retirement report" }),
    ];
    const reopened = reduceFiveSportScoreEvents("badminton", finalised);
    expect(reopened).toMatchObject({
      lifecycle: "in_progress",
      exceptionalOutcome: "retirement",
      winner: "home",
    });
    expect(() =>
      reduceFiveSportScoreEvents("badminton", [
        ...finalised,
        event(5, { type: "point", side: "away", segmentNumber: 1 }),
      ]),
    ).toThrow(/must be finalised or reversed/);

    const corrected = reduceFiveSportScoreEvents("badminton", [
      ...finalised,
      event(5, {
        type: "reversal",
        reversalTargetEventId: "event-2",
        reason: "Retirement report was attached to the wrong match",
      }),
      event(6, { type: "point", side: "away", segmentNumber: 1 }),
    ]);
    expect(corrected.exceptionalOutcome).toBeNull();
    expect(corrected.winner).toBeNull();
    expect(corrected.totalPoints).toEqual({ home: 0, away: 1 });
  });
});
