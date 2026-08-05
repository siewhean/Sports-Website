import {
  assertOfflineQueueIntegrity,
  assertOfflineMatchAuthorization,
  canTransitionOfflineAuthorizationStatus,
  canReplayOfflineCommand,
  expectedSequenceForOfflineCommand,
  offlineRecordingAvailability,
  resolveOfflineCommandForReplay,
} from "../src/offline-scoring.js";
import type {
  OfflineAcknowledgement,
  OfflineCanonicalEventCommand,
  OfflineMatchAuthorization,
  OfflineQueuedCommand,
} from "../src/offline-scoring.js";
import { describe, expect, it } from "vitest";

const matchPackage: OfflineMatchAuthorization = {
  principal_id: "a".repeat(64),
  authorization_id: "10000000-0000-4000-8000-000000000001",
  competition_id: "20000000-0000-4000-8000-000000000002",
  competition_slug: "offline-cup",
  match_id: "30000000-0000-4000-8000-000000000003",
  match_code: "M1",
  writer_generation: 5,
  sport_code: "canoe_polo",
  sport_pack_version: "1.0.0",
  settings: {},
  participants: [],
  last_acknowledged_sequence: 10,
  last_acknowledged_aggregate_version: 10,
  authorized_at: "2026-07-28T00:00:00.000Z",
  recording_expires_at: "2026-07-28T04:00:00.000Z",
  replay_expires_at: "2026-07-28T04:15:00.000Z",
  pass_expires_at: "2026-07-28T05:00:00.000Z",
  status: "active",
};

function queued(localSequence: number, command: OfflineQueuedCommand["command"]): OfflineQueuedCommand {
  return {
    authorization_id: matchPackage.authorization_id,
    match_id: matchPackage.match_id,
    local_sequence: localSequence,
    writer_generation: 5,
    enqueued_at: "2026-07-28T00:01:00.000Z",
    command,
  };
}

describe("Gate C offline scoring invariants", () => {
  it("validates bounded authorization windows and terminal state transitions", () => {
    expect(() => assertOfflineMatchAuthorization(matchPackage)).not.toThrow();
    expect(() =>
      assertOfflineMatchAuthorization({
        ...matchPackage,
        replay_expires_at: "2026-07-28T04:15:00.001Z",
      }),
    ).toThrow("windows are invalid");
    expect(canTransitionOfflineAuthorizationStatus("active", "transferred")).toBe(true);
    expect(canTransitionOfflineAuthorizationStatus("transferred", "active")).toBe(false);
  });

  it("separates the four-hour recording boundary from replay grace", () => {
    expect(offlineRecordingAvailability(matchPackage, 0, Date.parse("2026-07-28T03:59:59.999Z"))).toBe("available");
    expect(offlineRecordingAvailability(matchPackage, 0, Date.parse("2026-07-28T04:00:00.000Z"))).toBe(
      "recording_expired",
    );
    expect(canReplayOfflineCommand(matchPackage, Date.parse("2026-07-28T04:14:59.999Z"))).toBe(true);
    expect(canReplayOfflineCommand(matchPackage, Date.parse("2026-07-28T04:15:00.000Z"))).toBe(false);
  });

  it("warns at 1800 and refuses new commands at 2000", () => {
    const now = Date.parse("2026-07-28T01:00:00.000Z");
    expect(offlineRecordingAvailability(matchPackage, 1_799, now)).toBe("available");
    expect(offlineRecordingAvailability(matchPackage, 1_800, now)).toBe("queue_warning");
    expect(offlineRecordingAvailability(matchPackage, 2_000, now)).toBe("queue_full");
  });

  it("derives expected sequence from durable queue order", () => {
    expect(expectedSequenceForOfflineCommand(10, [queued(1, eventCommand())])).toBe(11);
    expect(expectedSequenceForOfflineCommand(12, [queued(1, eventCommand())])).toBe(12);
    expect(expectedSequenceForOfflineCommand(12, [])).toBe(12);
  });

  it("resolves a local reversal through an earlier durable acknowledgement", () => {
    const first = queued(1, eventCommand());
    const reversal = queued(2, {
      kind: "event",
      client_event_id: "50000000-0000-4000-8000-000000000005",
      expected_sequence: 11,
      type: "reversal",
      occurred_at: "2026-07-28T00:02:00.000Z",
      reversal_target_client_event_id: first.command.client_event_id,
      reason: "Incorrect scorer",
    });
    const acknowledgement: OfflineAcknowledgement = {
      authorization_id: matchPackage.authorization_id,
      match_id: matchPackage.match_id,
      local_sequence: 1,
      client_event_id: first.command.client_event_id,
      command_fingerprint: "a".repeat(64),
      outcome: "accepted",
      event_id: "60000000-0000-4000-8000-000000000006",
      sequence: 11,
      aggregate_version: 11,
      server_received_at: "2026-07-28T00:03:00.000Z",
      acknowledged_at: "2026-07-28T00:03:00.000Z",
    };

    expect(resolveOfflineCommandForReplay(reversal, [acknowledgement])).toMatchObject({
      reversal_target_event_id: acknowledgement.event_id,
    });
    expect(reversal.command).toHaveProperty("reversal_target_client_event_id", first.command.client_event_id);
  });

  it("rejects gaps and commands after finalisation", () => {
    const finalisation = queued(1, {
      kind: "finalisation",
      client_event_id: "70000000-0000-4000-8000-000000000007",
      expected_sequence: 10,
      occurred_at: "2026-07-28T00:04:00.000Z",
    });
    expect(() =>
      assertOfflineQueueIntegrity(
        matchPackage,
        [finalisation, queued(2, { ...eventCommand(), expected_sequence: 11 })],
        [],
      ),
    ).toThrow("No command may follow offline finalisation");
    expect(() => assertOfflineQueueIntegrity(matchPackage, [queued(2, eventCommand())], [])).toThrow(
      "local sequences must be contiguous",
    );
  });

  it("rejects a local reversal that does not target an earlier queued command", () => {
    const reversal = queued(1, {
      kind: "event",
      client_event_id: "80000000-0000-4000-8000-000000000008",
      expected_sequence: 10,
      type: "reversal",
      occurred_at: "2026-07-28T00:02:00.000Z",
      reversal_target_client_event_id: "90000000-0000-4000-8000-000000000009",
      reason: "Wrong event",
    });
    expect(() => assertOfflineQueueIntegrity(matchPackage, [reversal], [])).toThrow("target an earlier command");
  });
});

function eventCommand(): OfflineCanonicalEventCommand {
  return {
    kind: "event",
    client_event_id: "40000000-0000-4000-8000-000000000004",
    expected_sequence: 10,
    type: "goal",
    occurred_at: "2026-07-28T00:01:00.000Z",
    team_slot: "home",
    unknown_participant: true,
    segment_number: 1,
    manual_time_seconds: 100,
  };
}
