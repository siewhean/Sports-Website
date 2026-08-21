import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  assertOfflineMatchAuthorization,
  assertOfflineCommand,
  assertOfflineQueueIntegrity,
  canTransitionOfflineAuthorizationStatus,
  offlineRecordingAvailability,
  canReplayOfflineCommand,
  gateCOfflineQueueWarningCount,
  gateCOfflineQueueLimit,
  gateCOfflineRecordingDurationMs,
  gateCOfflineReplayGraceMs,
  gateCOfflineTerminalRetentionMs,
  type OfflineQueuedCommand,
} from "@matchday/domain";
import {
  IndexedDbOfflineScoringRepository,
  openOfflineScoringDatabase,
  TERMINAL_RETENTION_MS,
} from "../../../apps/web/lib/offline-scoring/indexeddb";
import {
  createValidOfflineAuthorization,
  createValidOfflineEventCommand,
  TEST_UUIDS,
  TEST_PRINCIPAL_ID,
} from "../helpers/fixtures";

describe("Tier 5 Adversarial - Subsystem 3: Offline Scoring Lifecycle & Capacity", () => {
  const PRINCIPAL_A = "a".repeat(64);
  const PRINCIPAL_B = "b".repeat(64);

  it("ADV-OFF-01: server-authoritative token expiration enforces strict temporal boundaries across all windows", () => {
    const baseNow = Date.now();
    const authorizedAt = new Date(baseNow).toISOString();
    const recordingExpiresAt = new Date(baseNow + 4 * 60 * 60 * 1_000).toISOString(); // 4 hours
    const replayExpiresAt = new Date(baseNow + 4 * 60 * 60 * 1_000 + 15 * 60 * 1_000).toISOString(); // +15 mins grace
    const passExpiresAt = new Date(baseNow + 8 * 60 * 60 * 1_000).toISOString(); // 8 hours

    const auth = createValidOfflineAuthorization({
      authorized_at: authorizedAt,
      recording_expires_at: recordingExpiresAt,
      replay_expires_at: replayExpiresAt,
      pass_expires_at: passExpiresAt,
      status: "active",
    });

    // 1. Within recording window (t = 2 hours)
    const tWithinRecording = baseNow + 2 * 60 * 60 * 1_000;
    expect(offlineRecordingAvailability(auth, 0, tWithinRecording)).toBe("available");
    expect(canReplayOfflineCommand(auth, tWithinRecording)).toBe(true);

    // 2. Exact recording expiry boundary (t = 4 hours)
    const tRecordingExpired = Date.parse(recordingExpiresAt);
    expect(offlineRecordingAvailability(auth, 0, tRecordingExpired)).toBe("recording_expired");
    expect(canReplayOfflineCommand(auth, tRecordingExpired)).toBe(true); // Replay allowed during 15m grace window!

    // 3. During replay grace window (t = 4 hours 10 mins)
    const tGrace = Date.parse(recordingExpiresAt) + 10 * 60 * 1_000;
    expect(offlineRecordingAvailability(auth, 0, tGrace)).toBe("recording_expired");
    expect(canReplayOfflineCommand(auth, tGrace)).toBe(true);

    // 4. Exact replay expiry boundary (t = 4 hours 15 mins)
    const tReplayExpired = Date.parse(replayExpiresAt);
    expect(offlineRecordingAvailability(auth, 0, tReplayExpired)).toBe("replay_expired");
    expect(canReplayOfflineCommand(auth, tReplayExpired)).toBe(false); // Replay blocked!

    // 5. Pass expiration boundary (t = 8 hours)
    const tPassExpired = Date.parse(passExpiresAt);
    expect(offlineRecordingAvailability(auth, 0, tPassExpired)).toBe("pass_expired");
    expect(canReplayOfflineCommand(auth, tPassExpired)).toBe(false);

    // 6. Non-active statuses override temporal availability
    const completedAuth = { ...auth, status: "completed" as const };
    expect(offlineRecordingAvailability(completedAuth, 0, tWithinRecording)).toBe("completed");
    expect(canReplayOfflineCommand(completedAuth, tWithinRecording)).toBe(false);
  });

  it("ADV-OFF-02: enforces 2,000-command queue capacity model and warning thresholds (1,800 warning, 2,000 hard limit)", () => {
    expect(gateCOfflineQueueWarningCount).toBe(1_800);
    expect(gateCOfflineQueueLimit).toBe(2_000);
    expect(gateCOfflineRecordingDurationMs).toBe(14_400_000); // 4 hours
    expect(gateCOfflineReplayGraceMs).toBe(900_000); // 15 mins
    expect(gateCOfflineTerminalRetentionMs).toBe(259_200_000); // 72 hours

    const auth = createValidOfflineAuthorization();
    const now = Date.parse(auth.authorized_at) + 1_000;

    // Below warning count (0..1799) -> available
    expect(offlineRecordingAvailability(auth, 0, now)).toBe("available");
    expect(offlineRecordingAvailability(auth, 1_799, now)).toBe("available");

    // At warning count (1800..1999) -> queue_warning
    expect(offlineRecordingAvailability(auth, 1_800, now)).toBe("queue_warning");
    expect(offlineRecordingAvailability(auth, 1_999, now)).toBe("queue_warning");

    // At hard limit (2000) -> queue_full
    expect(offlineRecordingAvailability(auth, 2_000, now)).toBe("queue_full");

    // Generating 2001 commands violates queue integrity
    const commands: OfflineQueuedCommand[] = [];
    for (let i = 1; i <= 2_001; i++) {
      commands.push({
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: i,
        writer_generation: 1,
        command: createValidOfflineEventCommand(i - 1),
      });
    }

    expect(() => assertOfflineQueueIntegrity(auth, commands, [])).toThrow(
      "Offline queue exceeds its hard command limit",
    );
  });

  it("ADV-OFF-03: rejects adversarial client clock manipulation, out-of-order sequences, and rogue reversals", () => {
    const auth = createValidOfflineAuthorization();

    // 1. Non-contiguous local sequence (e.g. 1 then 3)
    const nonContiguousLocal: OfflineQueuedCommand[] = [
      {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: 1,
        writer_generation: 1,
        command: createValidOfflineEventCommand(0, TEST_UUIDS.clientEventId1),
      },
      {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: 3, // Skipped 2!
        writer_generation: 1,
        command: createValidOfflineEventCommand(1, TEST_UUIDS.clientEventId2),
      },
    ];
    expect(() => assertOfflineQueueIntegrity(auth, nonContiguousLocal, [])).toThrow(
      "Offline local sequences must be contiguous",
    );

    // 2. Expected sequence diverging from queue base
    const divergentExpected: OfflineQueuedCommand[] = [
      {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: 1,
        writer_generation: 1,
        command: createValidOfflineEventCommand(0, TEST_UUIDS.clientEventId1),
      },
      {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: 2,
        writer_generation: 1,
        command: createValidOfflineEventCommand(5, TEST_UUIDS.clientEventId2), // Diverged!
      },
    ];
    expect(() => assertOfflineQueueIntegrity(auth, divergentExpected, [])).toThrow(
      "Offline expected sequences must be contiguous from the immutable queue base",
    );

    // 3. Duplicate client_event_id in queue
    const duplicateEventId: OfflineQueuedCommand[] = [
      {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: 1,
        writer_generation: 1,
        command: createValidOfflineEventCommand(0, TEST_UUIDS.clientEventId1),
      },
      {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: 2,
        writer_generation: 1,
        command: createValidOfflineEventCommand(1, TEST_UUIDS.clientEventId1), // Duplicate!
      },
    ];
    expect(() => assertOfflineQueueIntegrity(auth, duplicateEventId, [])).toThrow(
      "Offline client event IDs must be unique",
    );

    // 4. Command appended after finalisation
    const postFinalisation: OfflineQueuedCommand[] = [
      {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: 1,
        writer_generation: 1,
        command: {
          kind: "finalisation",
          client_event_id: TEST_UUIDS.clientEventId1,
          expected_sequence: 0,
          occurred_at: new Date().toISOString(),
        },
      },
      {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: 2,
        writer_generation: 1,
        command: createValidOfflineEventCommand(1, TEST_UUIDS.clientEventId2),
      },
    ];
    expect(() => assertOfflineQueueIntegrity(auth, postFinalisation, [])).toThrow(
      "No command may follow offline finalisation",
    );

    // 5. Reversal targeting a non-existent earlier command
    const rogueReversal: OfflineQueuedCommand[] = [
      {
        authorization_id: auth.authorization_id,
        match_id: auth.match_id,
        local_sequence: 1,
        writer_generation: 1,
        command: {
          kind: "event",
          client_event_id: TEST_UUIDS.clientEventId1,
          expected_sequence: 0,
          type: "reversal",
          occurred_at: new Date().toISOString(),
          reversal_target_client_event_id: "non-existent-client-id",
        },
      },
    ];
    expect(() => assertOfflineQueueIntegrity(auth, rogueReversal, [])).toThrow(
      "Offline reversal must target an earlier command in the same queue",
    );
  });

  it("ADV-OFF-04: IndexedDB retention enforces 72-hour TTL and preserves unacknowledged conflicts indefinitely", async () => {
    expect(TERMINAL_RETENTION_MS).toBe(72 * 60 * 60 * 1_000);

    const factory = new IDBFactory();
    const repository = new IndexedDbOfflineScoringRepository(factory);

    const basePast = Date.now() - 100 * 3600_000;
    const auth = createValidOfflineAuthorization({
      principal_id: PRINCIPAL_A,
      status: "completed",
      authorized_at: new Date(basePast).toISOString(),
      recording_expires_at: new Date(basePast + 4 * 3600_000).toISOString(),
      replay_expires_at: new Date(basePast + 4 * 3600_000 + 10 * 60_000).toISOString(),
      pass_expires_at: new Date(basePast + 8 * 3600_000).toISOString(),
    });

    await repository.bindPrincipal(PRINCIPAL_A);
    await repository.saveMatchPackage(auth as any);

    const replayExpiresAtMs = Date.parse(auth.replay_expires_at);

    // Before 72 hours (e.g. 71 hours) -> retention protects data
    const t71h = replayExpiresAtMs + 71 * 60 * 60 * 1_000;
    expect(await repository.pruneTerminalQueue(auth.authorization_id, t71h)).toBe(false);
    expect(await repository.getMatchPackage(auth.authorization_id)).not.toBeNull();

    // Inject an unacknowledged conflict
    await repository.appendConflict({
      authorization_id: auth.authorization_id,
      match_id: auth.match_id,
      local_sequence: 1,
      client_event_id: TEST_UUIDS.clientEventId1,
      code: "stale_writer_generation",
      writer_generation: 1,
      recorded_at: "2026-08-01T02:00:00.000Z",
    });

    // Even after 100 days (way past 72 hours), unacknowledged conflict PRESERVES data!
    const t100Days = replayExpiresAtMs + 100 * 24 * 60 * 60 * 1_000;
    expect(await repository.pruneTerminalQueue(auth.authorization_id, t100Days)).toBe(false);
    expect(await repository.getMatchPackage(auth.authorization_id)).not.toBeNull();
  });

  it("ADV-OFF-05: enforces strict principal isolation and prevents cross-principal data leakage", async () => {
    const factory = new IDBFactory();
    const repository = new IndexedDbOfflineScoringRepository(factory);

    // 1. Principal A binds and creates active work
    await repository.bindPrincipal(PRINCIPAL_A);
    const authA = createValidOfflineAuthorization({
      authorization_id: TEST_UUIDS.authorizationId,
      principal_id: PRINCIPAL_A,
    });
    await repository.saveMatchPackage(authA as any);

    // Principal A enqueues command
    await repository.enqueue({
      authorization_id: authA.authorization_id,
      match_id: authA.match_id,
      local_sequence: 1,
      writer_generation: 1,
      enqueued_at: new Date().toISOString(),
      command: createValidOfflineEventCommand(0, TEST_UUIDS.clientEventId1),
    } as any);

    // 2. While Principal A has unresolved command, saving package for Principal B is rejected
    const authB = createValidOfflineAuthorization({
      authorization_id: "55555555-5555-4555-8555-555555555555",
      match_id: "66666666-6666-4666-8666-666666666666",
      principal_id: PRINCIPAL_B,
    });
    await expect(repository.saveMatchPackage(authB as any)).rejects.toThrow(
      "Resolve or export the existing principal's offline match before switching scoring access",
    );

    // 3. Principal B binds
    await repository.bindPrincipal(PRINCIPAL_B);

    // Principal B cannot see Principal A's match package
    expect(await repository.getMatchPackage(authA.authorization_id)).toBeNull();
    expect(await repository.getActiveMatchPackage()).toBeNull();

    // Principal B cannot read Principal A's command stream
    await expect(repository.listCommands(authA.authorization_id)).rejects.toThrow(
      "Offline match authorization is unavailable",
    );

    // 4. Principal A returns and binds
    await repository.bindPrincipal(PRINCIPAL_A);
    const restoredPkg = await repository.getMatchPackage(authA.authorization_id);
    expect(restoredPkg?.principal_id).toBe(PRINCIPAL_A);
    const restoredCmds = await repository.listCommands(authA.authorization_id);
    expect(restoredCmds).toHaveLength(1);
    expect(restoredCmds[0]?.command.client_event_id).toBe(TEST_UUIDS.clientEventId1);
  });
});
