import { readFile } from "node:fs/promises";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type {
  GateCOfflineAcknowledgement,
  GateCOfflineMatchPackage,
  GateCOfflineQueuedCommand,
} from "@matchday/contracts";
import { createOfflineDiagnosticExport } from "./offline-scoring/export";
import { OfflineReplayController } from "./offline-scoring/replay";
import { StrictIndexedDbOfflineScoringRepository } from "./offline-scoring/strict-indexeddb";
import type { OfflineConflict, OfflineReplayAttempt, OfflineScoringRepository } from "./offline-scoring/types";

const authorizationId = "00000000-0000-4000-8000-000000000101";
const matchId = "00000000-0000-4000-8000-000000000102";
const competitionId = "00000000-0000-4000-8000-000000000103";
const clientEventId = "00000000-0000-4000-8000-000000000104";
const eventId = "00000000-0000-4000-8000-000000000105";
const now = Date.parse("2026-07-29T00:00:00.000Z");

function matchPackage(): GateCOfflineMatchPackage {
  return {
    schema_version: 1,
    authorization_id: authorizationId,
    competition_id: competitionId,
    competition_slug: "gate-c-c3-hardening",
    match_id: matchId,
    match_code: "M1",
    match_stage: "Group",
    writer_generation: 1,
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
    authorized_at: new Date(now).toISOString(),
    recording_expires_at: new Date(now + 4 * 60 * 60_000).toISOString(),
    replay_expires_at: new Date(now + 4 * 60 * 60_000 + 15 * 60_000).toISOString(),
    pass_expires_at: new Date(now + 5 * 60 * 60_000).toISOString(),
    status: "active",
  };
}

function queuedCommand(): GateCOfflineQueuedCommand {
  return {
    authorization_id: authorizationId,
    match_id: matchId,
    local_sequence: 1,
    writer_generation: 1,
    enqueued_at: new Date(now).toISOString(),
    command: {
      kind: "event",
      client_event_id: clientEventId,
      expected_sequence: 0,
      type: "match_started",
      occurred_at: new Date(now).toISOString(),
    },
  };
}

function replayAttempt(attempt: number): OfflineReplayAttempt {
  return {
    authorization_id: authorizationId,
    local_sequence: 1,
    attempt,
    started_at: new Date(now + attempt).toISOString(),
    completed_at: new Date(now + attempt + 1).toISOString(),
    outcome: "retry",
    error: { code: "server_unavailable", category: "retryable" },
  };
}

describe("Gate C C3 hardening", () => {
  it("invalidates export-confirmed deletion when replay evidence changes", async () => {
    const repository = new StrictIndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(queuedCommand(), now);
    await repository.appendReplayAttempt(replayAttempt(1));

    const exported = await createOfflineDiagnosticExport(repository, authorizationId, now + 10);
    expect(exported.document.replay_attempts).toHaveLength(1);
    expect(exported.document.authorization.queue_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.document.authorization.settings_fingerprint).toMatch(/^[a-f0-9]{64}$/);

    await repository.appendReplayAttempt(replayAttempt(2));
    await expect(repository.discardAfterExport(authorizationId, exported.sha256, exported.sha256)).rejects.toThrow(
      /changed after export/,
    );
    expect(await repository.getMatchPackage(authorizationId)).not.toBeNull();
    expect(await repository.listReplayAttempts(authorizationId)).toHaveLength(2);
  });

  it("refreshes an expired short lease once without marking the authority transferred", async () => {
    const storedPackage = matchPackage();
    const command = queuedCommand();
    const acknowledgements: GateCOfflineAcknowledgement[] = [];
    const attempts: OfflineReplayAttempt[] = [];
    const conflicts: OfflineConflict[] = [];
    const transition = vi.fn();
    const repository: OfflineScoringRepository = {
      saveMatchPackage: vi.fn(),
      transitionMatchPackageStatus: transition,
      getMatchPackage: vi.fn(async () => storedPackage),
      getActiveMatchPackage: vi.fn(async () => storedPackage),
      getRecoverableMatchPackage: vi.fn(async () => storedPackage),
      enqueue: vi.fn(),
      listCommands: vi.fn(async () => [command]),
      listAcknowledgements: vi.fn(async () => acknowledgements),
      listPendingCommands: vi.fn(async () => (acknowledgements.length ? [] : [command])),
      appendAcknowledgement: vi.fn(async (acknowledgement) => {
        acknowledgements.push(acknowledgement);
      }),
      appendReplayAttempt: vi.fn(async (attempt) => {
        attempts.push(attempt);
      }),
      listReplayAttempts: vi.fn(async () => attempts),
      appendConflict: vi.fn(async (conflict) => {
        conflicts.push(conflict);
      }),
      listConflicts: vi.fn(async () => conflicts),
      getReplayState: vi.fn(async () => null),
      recordDiagnosticExport: vi.fn(),
      acquireReplayLease: vi.fn(async () => 1),
      renewReplayLease: vi.fn(async () => true),
      releaseReplayLease: vi.fn(),
      pruneTerminalQueue: vi.fn(async () => false),
      discardResolvedAuthorization: vi.fn(),
      discardAfterExport: vi.fn(),
    };
    let submissions = 0;
    const refreshAuthority = vi.fn(async () => true);
    const controller = new OfflineReplayController({
      repository,
      lockManager: null,
      now: () => now,
      sleep: async () => undefined,
      isOnline: () => true,
      port: {
        refreshAuthority,
        submit: vi.fn(async () => {
          submissions += 1;
          if (submissions === 1) {
            return {
              status: "blocked" as const,
              error: { code: "stale_writer_generation" as const, category: "conflict" as const },
            };
          }
          return {
            status: "acknowledged" as const,
            acknowledgement: {
              authorization_id: authorizationId,
              match_id: matchId,
              local_sequence: 1,
              client_event_id: clientEventId,
              command_fingerprint: "a".repeat(64),
              outcome: "accepted" as const,
              event_id: eventId,
              sequence: 1,
              aggregate_version: 1,
              server_received_at: new Date(now).toISOString(),
              acknowledged_at: new Date(now).toISOString(),
            },
          };
        }),
      },
    });

    await expect(controller.replay(authorizationId)).resolves.toEqual({ status: "complete", acknowledged: 1 });
    expect(refreshAuthority).toHaveBeenCalledTimes(1);
    expect(transition).not.toHaveBeenCalledWith(authorizationId, "transferred");
    expect(conflicts).toHaveLength(0);
  });

  it("keeps append-only migrations and cached shell verification fail-closed", async () => {
    const migration = await readFile("../../packages/database/migrations/0032_gate_c_offline_replay.sql", "utf8");
    const worker = await readFile("public/sw.js", "utf8");
    const scorePage = await readFile("app/score/page.tsx", "utf8");

    expect(migration).not.toContain("DISABLE TRIGGER audit_events_no_update");
    expect(migration).not.toMatch(/UPDATE\s+audit_events/iu);
    expect(migration).not.toMatch(/UPDATE\s+outbox_events/iu);
    expect(worker).toContain("verifiedScoringShellResponse");
    expect(worker).toContain("response.headers.has(\"set-cookie\")");
    expect(worker).toContain("SCORING_SHELL_MARKER");
    expect(scorePage).toContain('data-offline-scoring-shell="v1"');
  });
});
