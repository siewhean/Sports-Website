import { describe, expect, it } from "vitest";
import {
  buildAtomicSegmentWinnerCommands,
  buildCanonicalReplacementCommand,
  buildSegmentCompletionCommand,
  parseMatchScoringAudit,
  parseResultConflict,
  parseResultConflicts,
  parseResultMutationReceipt,
} from "./gate-c-results";

const conflict = {
  id: "10000000-0000-4000-8000-000000000001",
  corrected_match_id: "20000000-0000-4000-8000-000000000002",
  downstream_match_id: "30000000-0000-4000-8000-000000000003",
  result_version: 2,
  reason: "downstream_match_started",
  status: "open",
  detail: { affected_slot: "home", previous_entry_id: null, proposed_entry_id: null },
  created_at: "2026-07-28T01:00:00.000Z",
  acknowledged_at: null,
  acknowledged_by_account_id: null,
  acknowledgement_reason: null,
};

const audit = {
  match: {
    id: "20000000-0000-4000-8000-000000000002",
    code: "Match 12",
    state: "finalised",
    home: { id: "b0000000-0000-4000-8000-00000000000b", name: "Harbour" },
    away: { id: "c0000000-0000-4000-8000-00000000000c", name: "Marina" },
  },
  competition: { id: "60000000-0000-4000-8000-000000000006", sport_code: "canoe_polo" },
  sport: { pack_version: "canoe-polo-v1", settings: {} },
  score: {
    home: 4,
    away: 3,
    lifecycle: "finalised",
    current_segment: 2,
    total_points: { home: 4, away: 3 },
    segment_wins: { home: 0, away: 0 },
    segments: [{ number: 1, home: 2, away: 1, completed: true, winner: "home" }],
    actions: [
      {
        event_id: "40000000-0000-4000-8000-000000000004",
        client_event_id: "70000000-0000-4000-8000-000000000007",
        event_type: "goal",
        label: "Goal",
        side: "home",
        participant_id: "player-8",
        segment_number: 1,
        score_delta: 1,
        occurred_at: "2026-07-28T00:42:00.000Z",
        reversed: false,
        reversible: true,
      },
    ],
    conflicts: [],
  },
  result: { result_version: 3, updated_at: "2026-07-28T00:50:00.000Z" },
  events: [
    {
      event_id: "40000000-0000-4000-8000-000000000004",
      client_event_id: "70000000-0000-4000-8000-000000000007",
      aggregate_version: 12,
      event_type: "goal",
      side: "home",
      participant_id: "player-8",
      unknown_participant: false,
      segment_number: 1,
      manual_time_seconds: 120,
      reversal_target_event_id: null,
      reason: null,
      device_timestamp: "2026-07-28T00:42:00.000Z",
      server_timestamp: "2026-07-28T00:42:01.000Z",
      actor_type: "access_pass",
    },
  ],
  audit: [
    {
      id: "50000000-0000-4000-8000-000000000005",
      action: "result.finalised",
      actor_type: "access_pass",
      reason: null,
      occurred_at: "2026-07-28T00:50:00.000Z",
      metadata: {},
    },
  ],
  conflicts: [],
  aggregate_version: 12,
  through_sequence: 12,
  permission: "write",
};

describe("Gate C organiser results boundary", () => {
  it("accepts the exact immutable scoring-audit contract", () => {
    expect(parseMatchScoringAudit(audit)).toMatchObject({
      match: { id: audit.match.id, aggregateVersion: 12, state: "finalised" },
      segments: [{ number: 1, winner: "home" }],
      events: [
        {
          eventId: audit.events[0]?.event_id,
          reversed: false,
          manualTimeSeconds: 120,
          unknownParticipant: false,
          reversible: true,
        },
      ],
      canManage: true,
    });
  });

  it("retains reopen, reversal and finalisation receipts outside the current action projection", () => {
    const lifecycleEvents = [
      {
        ...audit.events[0],
        event_id: "80000000-0000-4000-8000-000000000008",
        client_event_id: "81000000-0000-4000-8000-000000000008",
        aggregate_version: 13,
        event_type: "match_reopened",
        side: null,
        participant_id: null,
        segment_number: null,
        manual_time_seconds: null,
        reason: "Signed score sheet review",
        server_timestamp: "2026-07-28T00:51:00.000Z",
        actor_type: "account",
      },
      {
        ...audit.events[0],
        event_id: "90000000-0000-4000-8000-000000000009",
        client_event_id: "91000000-0000-4000-8000-000000000009",
        aggregate_version: 14,
        event_type: "reversal",
        side: null,
        participant_id: null,
        segment_number: null,
        reversal_target_event_id: audit.events[0].event_id,
        reason: "Goal did not occur",
        server_timestamp: "2026-07-28T00:52:00.000Z",
        actor_type: "account",
      },
      {
        ...audit.events[0],
        event_id: "a0000000-0000-4000-8000-00000000000a",
        client_event_id: "a1000000-0000-4000-8000-00000000000a",
        aggregate_version: 15,
        event_type: "match_finalised",
        side: null,
        participant_id: null,
        segment_number: null,
        manual_time_seconds: null,
        reason: "Correction published",
        server_timestamp: "2026-07-28T00:53:00.000Z",
        actor_type: "account",
      },
    ];
    const parsed = parseMatchScoringAudit({
      ...audit,
      aggregate_version: 15,
      through_sequence: 15,
      score: {
        ...audit.score,
        actions: [{ ...audit.score.actions[0], reversed: true, reversible: true }],
      },
      events: [...audit.events, ...lifecycleEvents],
    });
    expect(parsed?.events.map((event) => event.type)).toEqual([
      "goal",
      "match_reopened",
      "reversal",
      "match_finalised",
    ]);
    expect(parsed?.events[0]).toMatchObject({ reversed: true, reversible: true });
    expect(parsed?.events.slice(1).every((event) => !event.reversible)).toBe(true);
    expect(parsed?.events[2]).toMatchObject({
      reversalTargetEventId: audit.events[0].event_id,
      reason: "Goal did not occur",
      actorLabel: "Competition organiser",
    });
  });

  it("preserves required timing and unknown-participant semantics without irrelevant side fields", () => {
    const parsed = parseMatchScoringAudit({
      ...audit,
      score: {
        ...audit.score,
        actions: [
          {
            ...audit.score.actions[0],
            side: null,
            participant_id: null,
          },
        ],
      },
      events: [
        {
          ...audit.events[0],
          side: null,
          participant_id: null,
          unknown_participant: true,
        },
      ],
    });
    const event = parsed?.events[0];
    expect(event).toMatchObject({ side: null, manualTimeSeconds: 120, unknownParticipant: true });
    expect(
      event &&
        buildCanonicalReplacementCommand(event, {
          clientEventId: "80000000-0000-4000-8000-000000000008",
          occurredAt: "2026-07-28T01:00:00.000Z",
          side: "away",
          participantId: "must-not-leak",
        }),
    ).toEqual({
      client_event_id: "80000000-0000-4000-8000-000000000008",
      type: "goal",
      occurred_at: "2026-07-28T01:00:00.000Z",
      segment_number: 1,
      manual_time_seconds: 120,
      unknown_participant: true,
    });
  });

  it("builds only canonical game and set completion commands for atomic winner changes", () => {
    const input = {
      clientEventId: "80000000-0000-4000-8000-000000000008",
      occurredAt: "2026-07-28T01:00:00.000Z",
      side: "away" as const,
      segmentNumber: 3,
    };
    expect(buildSegmentCompletionCommand({ ...input, sportCode: "badminton" })).toEqual({
      client_event_id: input.clientEventId,
      type: "game_completion",
      occurred_at: input.occurredAt,
      team_slot: "away",
      segment_number: 3,
    });
    expect(buildSegmentCompletionCommand({ ...input, sportCode: "volleyball" })).toEqual({
      client_event_id: input.clientEventId,
      type: "set_completion",
      occurred_at: input.occurredAt,
      team_slot: "away",
      segment_number: 3,
    });
    expect(buildSegmentCompletionCommand({ ...input, sportCode: "basketball" })).toBeNull();
  });

  it("builds one bounded atomic segment-winner command list in authoritative order", () => {
    const point = {
      eventId: "40000000-0000-4000-8000-000000000004",
      sequence: 12,
      type: "point",
      side: "home" as const,
      participantLabel: "Player 8",
      reason: null,
      reversalTargetEventId: null,
      occurredAt: "2026-07-28T00:42:00.000Z",
      actorLabel: "Scoring official",
      reversed: false,
      segmentNumber: 2,
      manualTimeSeconds: null,
      unknownParticipant: false,
      reversible: true,
    };
    const ids = [
      "81000000-0000-4000-8000-000000000001",
      "81000000-0000-4000-8000-000000000002",
      "81000000-0000-4000-8000-000000000003",
      "81000000-0000-4000-8000-000000000004",
    ];
    const commands = buildAtomicSegmentWinnerCommands({
      targets: [point, { ...point, eventId: "40000000-0000-4000-8000-000000000005", sequence: 11 }],
      replacementSide: "away",
      replacementParticipant: "Player 11",
      replacementPointCount: 1,
      sportCode: "table_tennis",
      reason: "Signed score sheet changes the winner",
      occurredAt: "2026-07-28T01:00:00.000Z",
      clientEventIds: ids,
    });
    expect(commands?.map((command) => command.type)).toEqual(["reversal", "reversal", "point", "game_completion"]);
    expect(commands?.[2]).toMatchObject({
      client_event_id: ids[2],
      team_slot: "away",
      participant_id: "Player 11",
      segment_number: 2,
    });
    expect(commands?.[3]).toMatchObject({ client_event_id: ids[3], team_slot: "away", segment_number: 2 });
    expect(
      buildAtomicSegmentWinnerCommands({
        targets: [point],
        replacementSide: "home",
        replacementParticipant: "",
        replacementPointCount: 1,
        sportCode: "table_tennis",
        reason: "Invalid same-side replacement",
        occurredAt: "2026-07-28T01:00:00.000Z",
        clientEventIds: ids.slice(0, 3),
      }),
    ).toBeNull();
  });

  it("fails closed for forged sport, unknown fields and malformed history", () => {
    expect(parseMatchScoringAudit({ ...audit, competition: { ...audit.competition, sport_code: "canoe" } })).toBeNull();
    expect(parseMatchScoringAudit({ ...audit, secret: "not-allowed" })).toBeNull();
    expect(parseMatchScoringAudit({ ...audit, events: [{ ...audit.events[0], aggregate_version: -1 }] })).toBeNull();
  });

  it("accepts exact critical conflicts and rejects partial acknowledgement state", () => {
    expect(parseResultConflicts([conflict])).toHaveLength(1);
    expect(
      parseResultConflict({
        ...conflict,
        status: "acknowledged",
        acknowledgement_reason: "Reviewed by organiser",
        acknowledged_at: "2026-07-28T02:00:00.000Z",
      }),
    ).toMatchObject({ status: "acknowledged" });
    expect(
      parseResultConflict({
        ...conflict,
        status: "acknowledged",
        acknowledgement_reason: "Reviewed by organiser",
        acknowledged_at: "2026-07-28T02:00:00.000Z",
        acknowledgement_client_event_id: "70000000-0000-4000-8000-000000000007",
      }),
    ).toMatchObject({ status: "acknowledged" });
    expect(parseResultConflict({ ...conflict, acknowledgement_client_event_id: null })).toBeNull();
    expect(parseResultConflict({ ...conflict, result_version: -1 })).toBeNull();
  });

  it("requires a complete atomic publication receipt", () => {
    const receipt = {
      match_id: audit.match.id,
      aggregate_version: 14,
      through_sequence: 10,
      duplicate: false,
      result_version: 4,
      publication_version: 4,
      conflicts: [conflict],
    };
    expect(parseResultMutationReceipt(receipt)).toMatchObject({
      matchId: audit.match.id,
      aggregateVersion: 14,
      publicationVersion: 4,
    });
    expect(parseResultMutationReceipt({ ...receipt, publication_version: undefined })).toBeNull();
  });
});
