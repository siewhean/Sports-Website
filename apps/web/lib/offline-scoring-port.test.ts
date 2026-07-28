import type { GateCOfflineQueuedCommand } from "@matchday/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiOfflineScoringPort } from "./offline-scoring-port";

const queued: GateCOfflineQueuedCommand = {
  authorization_id: "10000000-0000-4000-8000-000000000001",
  match_id: "20000000-0000-4000-8000-000000000002",
  local_sequence: 1,
  writer_generation: 5,
  enqueued_at: "2026-07-28T00:01:00.000Z",
  command: {
    kind: "event",
    client_event_id: "30000000-0000-4000-8000-000000000003",
    expected_sequence: 0,
    type: "goal",
    occurred_at: "2026-07-28T00:01:00.000Z",
    team_slot: "home",
    participant_id: "40000000-0000-4000-8000-000000000004",
    segment_number: 1,
    manual_time_seconds: 60,
  },
};

describe("offline scoring API port", () => {
  it("maps the stable recording-expired code to the terminal expired authority state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "conflict", code: "OFFLINE_RECORDING_EXPIRED" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await new ApiOfflineScoringPort("50000000-0000-4000-8000-000000000005", 1, "gate-c-c3-v4").submit(
      queued,
      queued.command,
    );

    expect(result).toEqual({
      status: "blocked",
      error: { code: "authority_expired", category: "conflict" },
    });
    vi.unstubAllGlobals();
  });
});
