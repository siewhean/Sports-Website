import { describe, expect, it } from "vitest";
import {
  buildResultPublicationProjection,
  buildSchedulePublicationProjection,
  calculateCanoePoloStandings,
  detectCorrectionConflicts,
  generateBalancedCanoePoloFormat,
  reduceCanoePoloScoreEvents,
  resolveBracket,
  validateScoreFinalisation,
  type CanoePoloResult,
  type CanoePoloScoreEvent,
  type CompetitionEntry,
} from "../src/index.js";

const entries: CompetitionEntry[] = Array.from({ length: 8 }, (_, index) => ({
  id: `t${index + 1}`,
  name: `Team ${index + 1}`,
  seed: index + 1,
}));

function event(sequence: number, value: Record<string, unknown>): CanoePoloScoreEvent {
  return {
    eventId: `event-${sequence}`,
    clientEventId: `client-${sequence}`,
    matchId: "match-1",
    sequence,
    actorId: "official-1",
    scoringSessionId: "session-1",
    deviceTimestamp: `2026-08-01T01:${String(sequence).padStart(2, "0")}:00.000Z`,
    period: 1,
    manualTimeSeconds: sequence * 10,
    ...value,
  } as CanoePoloScoreEvent;
}

describe("Phase 2 scoring, standings, bracket, and publication", () => {
  it("reduces append-only scoring events idempotently and validates scorer attribution", () => {
    const stream: CanoePoloScoreEvent[] = [
      event(1, { type: "match_started" } as never),
      event(2, { type: "goal_added", payload: { teamId: "t1", scorerId: "player-9" } } as never),
      event(3, { type: "goal_added", payload: { teamId: "t2", scorerId: null } } as never),
      event(4, { type: "card_added", payload: { teamId: "t2", personId: "player-2", colour: "yellow" } } as never),
      event(5, { type: "timeout_added", payload: { teamId: "t1" } } as never),
      event(6, {
        type: "incident_added",
        payload: { teamId: null, personId: null, note: "Pitch equipment check" },
      } as never),
      event(7, { type: "match_finalised" } as never),
    ];
    const reduced = reduceCanoePoloScoreEvents([...stream, stream[6]!]);
    expect(reduced.scoreByTeam).toEqual({ t1: 1, t2: 1 });
    expect(reduced.cards).toHaveLength(1);
    expect(reduced.timeouts).toHaveLength(1);
    expect(reduced.incidents).toHaveLength(1);
    expect(reduced.appliedEventIds).toHaveLength(7);
    expect(validateScoreFinalisation(reduced)).toEqual({
      valid: false,
      errors: ["1 active goal(s) require scorer attribution"],
    });
    expect(validateScoreFinalisation(reduced, { scorerRequired: true, allowUnknownScorer: true })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("rejects sequence gaps, client UUID reuse, and unattributed reversals", () => {
    expect(() => reduceCanoePoloScoreEvents([event(2, { type: "match_started" } as never)])).toThrow(/Expected.*1/);
    const first = event(1, { type: "match_started" } as never);
    expect(() =>
      reduceCanoePoloScoreEvents([
        first,
        { ...event(2, { type: "match_started" } as never), clientEventId: first.clientEventId },
      ]),
    ).toThrow(/reused/);
    expect(() =>
      reduceCanoePoloScoreEvents([
        first,
        event(2, { type: "goal_reversed", reversalTargetEventId: "missing", reason: "Correction" } as never),
      ]),
    ).toThrow(/unavailable/);
  });

  it("calculates deterministic, explainable Canoe Polo standings", () => {
    const groupEntries = entries.slice(0, 4);
    const results: CanoePoloResult[] = [
      { matchId: "m1", homeEntryId: "t1", awayEntryId: "t2", homeGoals: 1, awayGoals: 0, status: "final", version: 1 },
      { matchId: "m2", homeEntryId: "t1", awayEntryId: "t3", homeGoals: 0, awayGoals: 1, status: "final", version: 1 },
      { matchId: "m3", homeEntryId: "t2", awayEntryId: "t3", homeGoals: 1, awayGoals: 0, status: "final", version: 1 },
      { matchId: "m4", homeEntryId: "t1", awayEntryId: "t4", homeGoals: 2, awayGoals: 0, status: "final", version: 1 },
      { matchId: "m5", homeEntryId: "t2", awayEntryId: "t4", homeGoals: 2, awayGoals: 0, status: "final", version: 1 },
      {
        matchId: "m6",
        homeEntryId: "t3",
        awayEntryId: "t4",
        homeGoals: 2,
        awayGoals: 0,
        homeDisciplinePoints: 2,
        status: "final",
        version: 1,
      },
    ];
    const standings = calculateCanoePoloStandings(groupEntries, results);
    expect(standings.map((row) => row.entryId)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(standings.slice(0, 3).map((row) => [row.points, row.goalDifference, row.goalsFor])).toEqual([
      [6, 2, 3],
      [6, 2, 3],
      [6, 2, 3],
    ]);
    expect(standings[0]!.explanations.map((detail) => detail.criterion)).toEqual([
      "points",
      "goal_difference",
      "goals_for",
      "head_to_head",
      "discipline",
      "seed",
    ]);
  });

  it("resolves advancement and reports finalised downstream correction conflicts", () => {
    const format = generateBalancedCanoePoloFormat(entries);
    const knockoutResults: CanoePoloResult[] = [
      {
        matchId: "semifinal-1",
        homeEntryId: "t1",
        awayEntryId: "t2",
        homeGoals: 2,
        awayGoals: 0,
        status: "final",
        version: 1,
      },
      {
        matchId: "semifinal-2",
        homeEntryId: "t3",
        awayEntryId: "t4",
        homeGoals: 1,
        awayGoals: 2,
        status: "final",
        version: 1,
      },
      {
        matchId: "championship-final",
        homeEntryId: "t1",
        awayEntryId: "t4",
        homeGoals: 1,
        awayGoals: 0,
        status: "final",
        version: 1,
      },
    ];
    const bracket = resolveBracket(format, knockoutResults, { A: ["t1", "t4"], B: ["t3", "t2"] });
    expect(bracket.championEntryId).toBe("t1");
    expect(detectCorrectionConflicts(format, knockoutResults, "semifinal-1")).toEqual([
      {
        correctedMatchId: "semifinal-1",
        downstreamMatchId: "championship-final",
        reason: "downstream_result_finalised",
      },
    ]);
    expect(
      detectCorrectionConflicts(format, knockoutResults.slice(0, 2), "semifinal-1", {
        "championship-final": "started",
      }),
    ).toEqual([
      { correctedMatchId: "semifinal-1", downstreamMatchId: "championship-final", reason: "downstream_match_started" },
    ]);
  });

  it("keeps public result and schedule revisions structurally isolated", () => {
    const base = {
      competitionId: "c1",
      divisionId: "d1",
      publicationVersion: 2,
      publishedAt: "2026-08-01T10:00:00.000Z",
    };
    const resultProjection = buildResultPublicationProjection({
      ...base,
      results: [],
      standings: [],
      bracket: { matches: [], qualifiedEntryIds: [], championEntryId: null },
      lastUpdatedAt: "2026-08-01T10:00:00.000Z",
    });
    const scheduleProjection = buildSchedulePublicationProjection({
      ...base,
      scheduleRevisionId: "schedule-r2",
      matches: [],
    });
    expect(resultProjection.kind).toBe("results");
    expect("scheduleRevisionId" in resultProjection).toBe(false);
    expect(scheduleProjection.kind).toBe("schedule");
    expect("results" in scheduleProjection).toBe(false);
  });
});
