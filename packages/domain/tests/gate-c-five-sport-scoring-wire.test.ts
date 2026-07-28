import { describe, expect, it } from "vitest";
import {
  assertFiveSportScoreCommandAllowed,
  materialiseFiveSportScoreEvent,
  parseFiveSportScoreCommand,
} from "../src/index.js";

const ids = {
  client: "10000000-0000-4000-8000-000000000001",
  target: "10000000-0000-4000-8000-000000000002",
  event: "10000000-0000-4000-8000-000000000003",
  match: "10000000-0000-4000-8000-000000000004",
  actor: "10000000-0000-4000-8000-000000000005",
  session: "10000000-0000-4000-8000-000000000006",
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    client_event_id: ids.client,
    type: "point",
    team_slot: "home",
    participant_id: null,
    segment_number: 1,
    manual_time_seconds: null,
    occurred_at: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("Gate C five-sport scoring wire contract", () => {
  it("parses and sanitises a structurally valid command", () => {
    expect(parseFiveSportScoreCommand(request({ ignored: "not-forwarded" }))).toEqual({
      clientEventId: ids.client,
      type: "point",
      occurredAt: "2026-07-28T00:00:00.000Z",
      side: "home",
      participantId: null,
      segmentNumber: 1,
      manualTimeSeconds: null,
    });
  });

  it("rejects malformed identity, side, segment, time, and timestamp values", () => {
    expect(parseFiveSportScoreCommand(request({ client_event_id: "not-a-uuid" }))).toBeNull();
    expect(parseFiveSportScoreCommand(request({ team_slot: "middle" }))).toBeNull();
    expect(parseFiveSportScoreCommand(request({ segment_number: 0 }))).toBeNull();
    expect(parseFiveSportScoreCommand(request({ manual_time_seconds: 3600 }))).toBeNull();
    expect(parseFiveSportScoreCommand(request({ occurred_at: "not-a-date" }))).toBeNull();
  });

  it("enforces sport ownership and effective settings", () => {
    const timeout = parseFiveSportScoreCommand(request({ type: "timeout", manual_time_seconds: 30 }));
    expect(timeout).not.toBeNull();
    expect(() => assertFiveSportScoreCommandAllowed("canoe_polo", timeout!)).not.toThrow();
    expect(() => assertFiveSportScoreCommandAllowed("canoe_polo", timeout!, { timeoutsEnabled: false })).toThrow(
      /disabled/,
    );
    expect(() => assertFiveSportScoreCommandAllowed("volleyball", requestCommand("goal"))).toThrow(/not supported/);
  });

  it("enforces side and participant attribution without inventing cross-sport unknown participants", () => {
    expect(() => assertFiveSportScoreCommandAllowed("badminton", requestCommand("game_completion"))).toThrow(
      /requires a side/,
    );
    expect(() =>
      assertFiveSportScoreCommandAllowed("basketball", requestCommand("player_foul", { side: "home" })),
    ).toThrow(/participant attribution/);
    expect(() =>
      assertFiveSportScoreCommandAllowed(
        "canoe_polo",
        requestCommand("goal", { side: "home", unknownParticipant: true, manualTimeSeconds: 30 }),
        { allowUnknownScorer: true },
      ),
    ).not.toThrow();
    expect(() =>
      assertFiveSportScoreCommandAllowed(
        "basketball",
        requestCommand("one_point_score", {
          side: "home",
          unknownParticipant: true,
          manualTimeSeconds: 30,
        }),
      ),
    ).toThrow(/only supported for Canoe Polo goals/);
    expect(() =>
      assertFiveSportScoreCommandAllowed(
        "canoe_polo",
        requestCommand("goal", {
          side: "home",
          participantId: "player-7",
          unknownParticipant: true,
          manualTimeSeconds: 30,
        }),
        { allowUnknownScorer: true },
      ),
    ).toThrow(/mutually exclusive/);
  });

  it("requires explicit reasons and targets for correction lifecycle commands", () => {
    expect(() => assertFiveSportScoreCommandAllowed("table_tennis", requestCommand("match_reopened"))).toThrow(
      /requires a reason/,
    );
    expect(() =>
      assertFiveSportScoreCommandAllowed("table_tennis", requestCommand("reversal", { reason: "Wrong server" })),
    ).toThrow(/target event/);
    expect(() =>
      assertFiveSportScoreCommandAllowed(
        "table_tennis",
        requestCommand("reversal", { reason: "Wrong server", reversalTargetEventId: ids.target }),
      ),
    ).not.toThrow();
    expect(() =>
      assertFiveSportScoreCommandAllowed(
        "table_tennis",
        requestCommand("point", { side: "home", reversalTargetEventId: ids.target }),
      ),
    ).toThrow(/Only reversal events/);
  });

  it("materialises server-owned event metadata without changing client content", () => {
    const command = requestCommand("three_point_score", {
      side: "away",
      participantId: "player-12",
      segmentNumber: 4,
      manualTimeSeconds: 42,
    });
    expect(
      materialiseFiveSportScoreEvent(command, {
        eventId: ids.event,
        matchId: ids.match,
        sequence: 7,
        actorId: ids.actor,
        scoringSessionId: ids.session,
      }),
    ).toMatchObject({
      eventId: ids.event,
      clientEventId: ids.client,
      matchId: ids.match,
      sequence: 7,
      actorId: ids.actor,
      scoringSessionId: ids.session,
      type: "three_point_score",
      side: "away",
      participantId: "player-12",
      segmentNumber: 4,
      manualTimeSeconds: 42,
    });
  });

  it("requires non-null manual event time for actions when effective settings enable it", () => {
    expect(() =>
      assertFiveSportScoreCommandAllowed(
        "canoe_polo",
        requestCommand("goal", { side: "home", participantId: "player-1" }),
      ),
    ).toThrow(/requires manual event time/);
    expect(() =>
      assertFiveSportScoreCommandAllowed(
        "basketball",
        requestCommand("one_point_score", { side: "home", manualTimeSeconds: null }),
      ),
    ).toThrow(/requires manual event time/);
    expect(() =>
      assertFiveSportScoreCommandAllowed(
        "canoe_polo",
        requestCommand("goal", {
          side: "home",
          participantId: "player-1",
          manualTimeSeconds: 30,
        }),
      ),
    ).not.toThrow();
  });
});

function requestCommand(
  type: string,
  overrides: Partial<NonNullable<ReturnType<typeof parseFiveSportScoreCommand>>> = {},
) {
  return {
    clientEventId: ids.client,
    type,
    occurredAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}
