import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { materialiseFiveSportScoreEvent, type AppliedSportAction, type FiveSportScoreCommand } from "@matchday/domain";
import {
  historicalCorrectionReplacementEventIds,
  persistedHistoricalCorrectionReplacementEventIds,
} from "../../src/phase-2-runtime.js";

const target: AppliedSportAction = {
  eventId: "10000000-0000-4000-8000-000000000001",
  clientEventId: "10000000-0000-4000-8000-000000000002",
  eventType: "goal",
  label: "Goal",
  side: "home",
  participantId: "Player 1",
  segmentNumber: 1,
  scoreDelta: 1,
  manualTimeSeconds: 582,
  occurredAt: "2026-08-12T00:00:00.000Z",
  reversed: false,
};

function reversal(): FiveSportScoreCommand {
  return {
    clientEventId: randomUUID(),
    type: "reversal",
    occurredAt: "2026-08-12T01:00:00.000Z",
    reversalTargetEventId: target.eventId,
    reason: "Verified score-sheet correction",
  };
}

function replacement(overrides: Partial<FiveSportScoreCommand> = {}): FiveSportScoreCommand {
  return {
    clientEventId: randomUUID(),
    type: "goal",
    occurredAt: "2026-08-12T01:00:00.000Z",
    side: "away",
    participantId: "Player 2",
    segmentNumber: 1,
    manualTimeSeconds: 582,
    ...overrides,
  };
}

function staged(commands: readonly FiveSportScoreCommand[]) {
  return commands.map((command) => ({ id: randomUUID(), command }));
}

describe("historical organiser correction pairing", () => {
  it("authorises exactly one immediately paired historical replacement", () => {
    const commands = [reversal(), replacement()];
    const stagedCommands = staged(commands);

    expect(historicalCorrectionReplacementEventIds(commands, stagedCommands, [target])).toEqual(
      new Set([stagedCommands[1]!.id]),
    );
  });

  it("rejects misordered, extra, and non-identical historical replacements", () => {
    const first = replacement();
    const second = replacement();
    const lateReversal = reversal();
    expect(() =>
      historicalCorrectionReplacementEventIds([first, lateReversal], staged([first, lateReversal]), [target]),
    ).toThrow(/immediately and exactly/);
    const firstReversal = reversal();
    expect(() =>
      historicalCorrectionReplacementEventIds([firstReversal, first, second], staged([firstReversal, first, second]), [
        target,
      ]),
    ).toThrow(/immediately and exactly/);
    const wrongTimeReversal = reversal();
    const wrongTime = replacement({ manualTimeSeconds: 581 });
    expect(() =>
      historicalCorrectionReplacementEventIds([wrongTimeReversal, wrongTime], staged([wrongTimeReversal, wrongTime]), [
        target,
      ]),
    ).toThrow(/immediately and exactly/);
  });

  it("rehydrates only an immediately paired persisted historical replacement", () => {
    const matchId = "20000000-0000-4000-8000-000000000001";
    const metadata = (eventId: string, sequence: number) => ({
      eventId,
      matchId,
      sequence,
      actorId: "30000000-0000-4000-8000-000000000001",
      scoringSessionId: "40000000-0000-4000-8000-000000000001",
    });
    const goal = materialiseFiveSportScoreEvent(
      replacement({ clientEventId: randomUUID(), side: "home" }),
      metadata("50000000-0000-4000-8000-000000000001", 1),
    );
    const reverse = materialiseFiveSportScoreEvent(
      { ...reversal(), reversalTargetEventId: goal.eventId },
      metadata("50000000-0000-4000-8000-000000000002", 2),
    );
    const replacementEvent = materialiseFiveSportScoreEvent(
      replacement({ clientEventId: randomUUID() }),
      metadata("50000000-0000-4000-8000-000000000003", 3),
    );
    const unrelated = materialiseFiveSportScoreEvent(
      replacement({ clientEventId: randomUUID() }),
      metadata("50000000-0000-4000-8000-000000000004", 4),
    );

    expect(persistedHistoricalCorrectionReplacementEventIds([goal, reverse, replacementEvent, unrelated])).toEqual(
      new Set([replacementEvent.eventId]),
    );
  });
});
