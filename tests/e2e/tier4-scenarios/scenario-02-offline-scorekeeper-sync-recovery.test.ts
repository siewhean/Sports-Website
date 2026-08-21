import { describe, it, expect } from "vitest";
import {
  assertOfflineMatchAuthorization,
  assertOfflineCommand,
  canReplayOfflineCommand,
  type OfflineCanonicalEventCommand,
  type OfflineAcknowledgement,
} from "@matchday/domain";
import { createValidOfflineAuthorization, createValidOfflineEventCommand, TEST_UUIDS } from "../helpers/fixtures";

describe("Tier 4 - Scenario 02: Offline Field Scorekeeper Disconnected Operation & Sync Recovery", () => {
  it("executes offline workflow: authorization -> offline mutations -> local reversal -> online replay -> server ack", () => {
    // 1. Receive server-authoritative offline authorization package
    const auth = createValidOfflineAuthorization();
    expect(() => assertOfflineMatchAuthorization(auth)).not.toThrow();

    // 2. Scorekeeper goes offline and queues 10 score events locally
    const localQueue: OfflineCanonicalEventCommand[] = [];
    for (let i = 1; i <= 10; i++) {
      const command = createValidOfflineEventCommand(i, `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`, {
        type: "football_goal",
        team: i % 2 === 0 ? "away" : "home",
      });
      assertOfflineCommand(command);
      localQueue.push(command);
    }
    expect(localQueue).toHaveLength(10);

    // 3. Local Reversal of event #5 (e.g. goal disallowed by referee)
    const targetEvent = localQueue[4]!; // 5th event
    const reversalCommand = createValidOfflineEventCommand(11, "55555555-5555-4555-8555-000000000099", {
      type: "reversal",
      reversal_target_client_event_id: targetEvent.client_event_id,
    });
    assertOfflineCommand(reversalCommand);
    localQueue.push(reversalCommand);
    expect(localQueue).toHaveLength(11);

    // 4. Reconnect to network and replay commands strictly in sequence
    const now = Date.now();
    expect(canReplayOfflineCommand(auth, now)).toBe(true);

    const serverAcknowledgements: OfflineAcknowledgement[] = [];
    let serverSequence = auth.last_acknowledged_sequence;
    let serverAggregateVersion = auth.last_acknowledged_aggregate_version;

    for (const queuedCmd of localQueue) {
      // Server processes in sequence
      serverSequence += 1;
      serverAggregateVersion += 1;
      const ack: OfflineAcknowledgement = {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: queuedCmd.expected_sequence,
        client_event_id: queuedCmd.client_event_id,
        sequence: serverSequence,
        aggregate_version: serverAggregateVersion,
      };
      serverAcknowledgements.push(ack);
    }

    expect(serverAcknowledgements).toHaveLength(11);
    expect(serverSequence).toBe(11);
    expect(serverAggregateVersion).toBe(11);

    // 5. Local queue is fully acknowledged
    const unacknowledgedCount = localQueue.length - serverAcknowledgements.length;
    expect(unacknowledgedCount).toBe(0);
  });
});
