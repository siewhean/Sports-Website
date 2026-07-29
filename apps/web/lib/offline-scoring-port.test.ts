import type { GateCOfflineMatchPackage, GateCOfflineQueuedCommand } from "@matchday/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiOfflineScoringPort } from "./offline-scoring-port";
import type { OfflineScoringRepository } from "./offline-scoring";

const authorizationId = "10000000-0000-4000-8000-000000000001";
const queued: GateCOfflineQueuedCommand = {
  authorization_id: authorizationId,
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

function offlinePackage(): GateCOfflineMatchPackage {
  return {
    schema_version: 1,
    principal_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    authorization_id: authorizationId,
    competition_id: "60000000-0000-4000-8000-000000000006",
    competition_slug: "offline-port-test",
    match_id: queued.match_id,
    match_code: "M1",
    match_stage: "Group",
    writer_generation: queued.writer_generation,
    sport_code: "canoe_polo",
    sport_pack_version: "canoe-polo-v1",
    settings: {},
    participants: [
      { id: "home", name: "Home", side: "home" },
      { id: "away", name: "Away", side: "away" },
    ],
    authoritative_events: [],
    last_acknowledged_sequence: 0,
    last_acknowledged_aggregate_version: 0,
    authorized_at: "2026-07-28T00:00:00.000Z",
    recording_expires_at: "2026-07-28T04:00:00.000Z",
    replay_expires_at: "2026-07-28T04:15:00.000Z",
    pass_expires_at: "2026-07-28T05:00:00.000Z",
    status: "active",
  };
}

function summaryRepository() {
  const matchPackage = offlinePackage();
  const saveMatchPackage = vi.fn(async () => undefined);
  const repository = {
    bindPrincipal: vi.fn(),
    getMatchPackage: vi.fn(async () => matchPackage),
    saveMatchPackage,
    listCommands: vi.fn(async () => [queued]),
    listAcknowledgements: vi.fn(async () => []),
    listPendingCommands: vi.fn(async () => [queued]),
  } as unknown as OfflineScoringRepository;
  return { repository, saveMatchPackage, matchPackage };
}

describe("offline scoring API port", () => {
  afterEach(() => vi.unstubAllGlobals());

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

    const result = await new ApiOfflineScoringPort("50000000-0000-4000-8000-000000000005", 1, "gate-c-c3-v5").submit(
      queued,
      queued.command,
    );

    expect(result).toEqual({
      status: "blocked",
      error: { code: "authority_expired", category: "conflict" },
    });
  });

  it("maps a confirmed takeover during refresh to a terminal transferred outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "conflict", code: "OFFLINE_AUTHORIZATION_TRANSFERRED" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { repository } = summaryRepository();
    const port = new ApiOfflineScoringPort("50000000-0000-4000-8000-000000000005", 1, "gate-c-c3-v5", repository);
    await expect(port.refreshAuthority(authorizationId)).resolves.toBe("authority_transferred");
  });

  it("persists renewed recording replay and pass windows after a successful refresh", async () => {
    const renewed = {
      authorization_id: authorizationId,
      principal_id: offlinePackage().principal_id,
      competition_id: offlinePackage().competition_id,
      match_id: queued.match_id,
      generation: queued.writer_generation,
      recording_expires_at: "2026-07-28T04:30:00.000Z",
      replay_expires_at: "2026-07-28T04:45:00.000Z",
      pass_expires_at: "2026-07-28T05:00:00.000Z",
      status: "active",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ offline: renewed, session: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { repository, saveMatchPackage, matchPackage } = summaryRepository();
    const port = new ApiOfflineScoringPort("50000000-0000-4000-8000-000000000005", 1, "gate-c-c3-v5", repository);
    await expect(port.refreshAuthority(authorizationId)).resolves.toBe("active");
    expect(saveMatchPackage).toHaveBeenCalledWith({
      ...matchPackage,
      recording_expires_at: renewed.recording_expires_at,
      replay_expires_at: renewed.replay_expires_at,
      pass_expires_at: renewed.pass_expires_at,
      status: "active",
    });
  });
});
