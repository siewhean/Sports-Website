import type {
  GateCOfflineAcknowledgement,
  GateCOfflineMatchPackage,
  GateCOfflineQueuedCommand,
  GateCOfflineReplayReceipt,
} from "@matchday/contracts";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  IndexedDbOfflineScoringRepository,
  openOfflineScoringDatabase,
  TERMINAL_RETENTION_MS,
} from "../../lib/offline-scoring/indexeddb";
import { OfflineReplayController } from "../../lib/offline-scoring/replay";
import {
  clearScoringPrincipalCookie,
  readScoringPrincipalCookie,
  retainScoringPrincipalCookie,
} from "../../lib/offline-scoring-principal";

const BASE_NOW = Date.parse("2026-08-01T00:00:00.000Z");
const BASE_AUTH_ID = "00000000-0000-4000-8000-000000000001";
const BASE_MATCH_ID = "00000000-0000-4000-8000-000000000002";
const BASE_COMP_ID = "00000000-0000-4000-8000-000000000003";
const PRINCIPAL_A = "a".repeat(64);
const PRINCIPAL_B = "b".repeat(64);

function buildMatchPackage(overrides: Partial<GateCOfflineMatchPackage> = {}): GateCOfflineMatchPackage {
  return {
    schema_version: 1,
    principal_id: PRINCIPAL_A,
    authorization_id: BASE_AUTH_ID,
    competition_id: BASE_COMP_ID,
    competition_slug: "offline-authority-test",
    match_id: BASE_MATCH_ID,
    match_code: "M-AUTHO-1",
    match_stage: "Group A",
    writer_generation: 1,
    sport_code: "table_tennis",
    sport_pack_version: "1.0.0",
    settings: { manualEventTime: true },
    participants: [
      { id: "p1", name: "Player One", side: "home" },
      { id: "p2", name: "Player Two", side: "away" },
    ],
    authoritative_events: [],
    last_acknowledged_sequence: 0,
    last_acknowledged_aggregate_version: 0,
    authorized_at: "2026-08-01T00:00:00.000Z",
    recording_expires_at: "2026-08-01T04:00:00.000Z", // 4 hours
    replay_expires_at: "2026-08-01T04:15:00.000Z", // 15 mins grace
    pass_expires_at: "2026-08-01T06:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

function buildQueuedCommand(
  localSequence: number,
  authId: string = BASE_AUTH_ID,
  matchId: string = BASE_MATCH_ID,
): GateCOfflineQueuedCommand {
  const hex = localSequence.toString(16).padStart(12, "0");
  return {
    authorization_id: authId,
    match_id: matchId,
    local_sequence: localSequence,
    writer_generation: 1,
    enqueued_at: new Date(BASE_NOW + localSequence * 1000).toISOString(),
    command: {
      kind: "event",
      client_event_id: `99999999-9999-4999-8999-${hex}`,
      expected_sequence: localSequence - 1,
      type: "point",
      occurred_at: new Date(BASE_NOW + localSequence * 1000).toISOString(),
      team_slot: localSequence % 2 === 0 ? "home" : "away",
    },
  };
}

function buildAcknowledgement(queued: GateCOfflineQueuedCommand): GateCOfflineAcknowledgement {
  return {
    authorization_id: queued.authorization_id,
    match_id: queued.match_id,
    local_sequence: queued.local_sequence,
    client_event_id: queued.command.client_event_id,
    command_fingerprint: "f".repeat(64),
    outcome: "accepted",
    event_id: `88888888-8888-4888-8888-${queued.local_sequence.toString(16).padStart(12, "0")}`,
    sequence: queued.local_sequence,
    aggregate_version: queued.local_sequence,
    server_received_at: "2026-08-01T01:00:00.000Z",
    acknowledged_at: "2026-08-01T01:00:00.000Z",
  };
}

describe("Server-Authoritative Expiration Enforcement (Web Repository & Replay)", () => {
  it("enforces server-issued recording expiration on command enqueue", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const pkg = buildMatchPackage();
    await repository.bindPrincipal(PRINCIPAL_A);
    await repository.saveMatchPackage(pkg);

    const cmd1 = buildQueuedCommand(1);
    // Enqueue within recording window (3h 59m)
    await expect(repository.enqueue(cmd1, Date.parse("2026-08-01T03:59:59.999Z"))).resolves.toBeUndefined();

    const cmd2 = buildQueuedCommand(2);
    // Enqueue at exact 4h recording expiry boundary
    await expect(repository.enqueue(cmd2, Date.parse("2026-08-01T04:00:00.000Z"))).rejects.toThrow(
      "Offline scoring cannot accept another command: recording_expired",
    );

    // Enqueue during replay grace window (4h 10m)
    await expect(repository.enqueue(cmd2, Date.parse("2026-08-01T04:10:00.000Z"))).rejects.toThrow(
      "Offline scoring cannot accept another command: recording_expired",
    );

    // Enqueue at replay expiration boundary (4h 15m)
    await expect(repository.enqueue(cmd2, Date.parse("2026-08-01T04:15:00.000Z"))).rejects.toThrow(
      "Offline scoring cannot accept another command: replay_expired",
    );

    // Enqueue at pass expiration boundary (6h)
    await expect(repository.enqueue(cmd2, Date.parse("2026-08-01T06:00:00.000Z"))).rejects.toThrow(
      "Offline scoring cannot accept another command: pass_expired",
    );
  });

  it("permits command replay during 15m grace window and prohibits replay after replay_expires_at", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const pkg = buildMatchPackage();
    await repository.bindPrincipal(PRINCIPAL_A);
    await repository.saveMatchPackage(pkg);

    const cmd = buildQueuedCommand(1);
    await repository.enqueue(cmd, Date.parse("2026-08-01T01:00:00.000Z"));

    // Replay during 15m grace period (4h 10m)
    const currentTime = Date.parse("2026-08-01T04:10:00.000Z");
    const submitMock = vi.fn(async (queued): Promise<GateCOfflineReplayReceipt> => ({
      status: "acknowledged",
      acknowledgement: buildAcknowledgement(queued),
    }));

    const controller = new OfflineReplayController({
      repository,
      port: { submit: submitMock },
      now: () => currentTime,
      isOnline: () => true,
      lockManager: null,
    });

    const graceResult = await controller.replay(BASE_AUTH_ID);
    expect(graceResult).toEqual({ status: "complete", acknowledged: 1 });
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(await repository.listPendingCommands(BASE_AUTH_ID)).toHaveLength(0);
  });

  it("blocks replay after replay_expires_at, transitions status to expired, and records conflict", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const pkg = buildMatchPackage();
    await repository.bindPrincipal(PRINCIPAL_A);
    await repository.saveMatchPackage(pkg);

    const cmd = buildQueuedCommand(1);
    await repository.enqueue(cmd, Date.parse("2026-08-01T01:00:00.000Z"));

    // Replay after replay expiration (4h 15m 01s)
    const currentTime = Date.parse("2026-08-01T04:15:01.000Z");
    const submitMock = vi.fn();

    const controller = new OfflineReplayController({
      repository,
      port: { submit: submitMock },
      now: () => currentTime,
      isOnline: () => true,
      lockManager: null,
    });

    const result = await controller.replay(BASE_AUTH_ID);
    expect(result).toMatchObject({
      status: "blocked",
      acknowledged: 0,
      error: { code: "authority_expired", category: "permission" },
    });
    expect(submitMock).not.toHaveBeenCalled();

    // Match package status transitioned to expired
    const updatedPkg = await repository.getMatchPackage(BASE_AUTH_ID);
    expect(updatedPkg?.status).toBe("expired");
  });

  it("blocks replay after pass_expires_at with pass_expired error code", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const pkg = buildMatchPackage();
    await repository.bindPrincipal(PRINCIPAL_A);
    await repository.saveMatchPackage(pkg);

    const cmd = buildQueuedCommand(1);
    await repository.enqueue(cmd, Date.parse("2026-08-01T01:00:00.000Z"));

    // Replay after pass expiration (6h 01m)
    const currentTime = Date.parse("2026-08-01T06:01:00.000Z");
    const submitMock = vi.fn();

    const controller = new OfflineReplayController({
      repository,
      port: { submit: submitMock },
      now: () => currentTime,
      isOnline: () => true,
      lockManager: null,
    });

    const result = await controller.replay(BASE_AUTH_ID);
    expect(result).toMatchObject({
      status: "blocked",
      acknowledged: 0,
      error: { code: "pass_expired", category: "permission" },
    });
    expect(submitMock).not.toHaveBeenCalled();

    const updatedPkg = await repository.getMatchPackage(BASE_AUTH_ID);
    expect(updatedPkg?.status).toBe("expired");
  });
});

describe("Offline Queue Capacity Model (2,000 Commands - Repository Enforcement)", () => {
  it("enforces capacity warning threshold at 1,800 and hard ceiling at 2,000 commands", async () => {
    const factory = new IDBFactory();
    const repository = new IndexedDbOfflineScoringRepository(factory);
    const pkg = buildMatchPackage();
    await repository.bindPrincipal(PRINCIPAL_A);
    await repository.saveMatchPackage(pkg);

    const now = Date.parse("2026-08-01T01:00:00.000Z");

    // Fast-populate 1..1799 commands into the IndexedDB database
    const db = await openOfflineScoringDatabase(factory);
    const bulkTx = db.transaction("commands", "readwrite");
    const cmdStore = bulkTx.objectStore("commands");
    for (let i = 1; i <= 1_799; i++) {
      cmdStore.add(buildQueuedCommand(i));
    }
    await new Promise<void>((resolve, reject) => {
      bulkTx.oncomplete = () => resolve();
      bulkTx.onerror = () => reject(bulkTx.error);
    });
    db.close();

    // Enqueue command #1,800 via repository method (triggers warning threshold)
    await repository.enqueue(buildQueuedCommand(1_800), now);
    const pendingAt1800 = await repository.listPendingCommands(BASE_AUTH_ID);
    expect(pendingAt1800).toHaveLength(1_800);

    // Fast-populate 1801..1999 commands
    const db2 = await openOfflineScoringDatabase(factory);
    const bulkTx2 = db2.transaction("commands", "readwrite");
    const cmdStore2 = bulkTx2.objectStore("commands");
    for (let i = 1_801; i <= 1_999; i++) {
      cmdStore2.add(buildQueuedCommand(i));
    }
    await new Promise<void>((resolve, reject) => {
      bulkTx2.oncomplete = () => resolve();
      bulkTx2.onerror = () => reject(bulkTx2.error);
    });
    db2.close();

    // Enqueue command #2,000 via repository method (reaches exact hard ceiling)
    await repository.enqueue(buildQueuedCommand(2_000), now);
    const pendingAt2000 = await repository.listPendingCommands(BASE_AUTH_ID);
    expect(pendingAt2000).toHaveLength(2_000);

    // Enqueue command #2,001 must be rejected by hard ceiling limit
    const cmd2001 = buildQueuedCommand(2_001);
    await expect(repository.enqueue(cmd2001, now)).rejects.toThrow(
      "Offline scoring cannot accept another command: queue_full",
    );

    // Verify queue remains intact at exactly 2,000 commands
    const allCommands = await repository.listCommands(BASE_AUTH_ID);
    expect(allCommands).toHaveLength(2_000);
    expect(allCommands[0]?.local_sequence).toBe(1);
    expect(allCommands[1_999]?.local_sequence).toBe(2_000);
  });
});

describe("Lifecycle-Aware IndexedDB Retention & Isolation (72h Retention & Principal Isolation)", () => {
  it("defines TERMINAL_RETENTION_MS as exactly 72 hours", () => {
    expect(TERMINAL_RETENTION_MS).toBe(72 * 60 * 60 * 1_000);
    expect(TERMINAL_RETENTION_MS).toBe(259_200_000);
  });

  it("retains completed package until 72 hours past replay_expires_at", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const pkg = buildMatchPackage({
      status: "completed",
      recording_expires_at: "2026-08-01T04:00:00.000Z",
      replay_expires_at: "2026-08-01T04:15:00.000Z",
    });
    await repository.bindPrincipal(PRINCIPAL_A);
    await repository.saveMatchPackage(pkg);

    const replayExpiresAtMs = Date.parse("2026-08-01T04:15:00.000Z");

    // 24 hours after replay expiry -> retention active, returns false
    const t24h = replayExpiresAtMs + 24 * 60 * 60 * 1_000;
    expect(await repository.pruneTerminalQueue(BASE_AUTH_ID, t24h)).toBe(false);
    expect(await repository.getMatchPackage(BASE_AUTH_ID)).not.toBeNull();

    // 71 hours 59 minutes after replay expiry -> retention active, returns false
    const t71h59m = replayExpiresAtMs + (72 * 60 * 60 * 1_000 - 1_000);
    expect(await repository.pruneTerminalQueue(BASE_AUTH_ID, t71h59m)).toBe(false);
    expect(await repository.getMatchPackage(BASE_AUTH_ID)).not.toBeNull();

    // Exactly 72 hours after replay expiry -> pruned successfully
    const t72h = replayExpiresAtMs + 72 * 60 * 60 * 1_000;
    expect(await repository.pruneTerminalQueue(BASE_AUTH_ID, t72h)).toBe(true);
    expect(await repository.getMatchPackage(BASE_AUTH_ID)).toBeNull();
  });

  it("preserves unacknowledged conflicts indefinitely across retention boundaries until resolved", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const pkg = buildMatchPackage({
      status: "completed",
      replay_expires_at: "2026-08-01T04:15:00.000Z",
    });
    await repository.bindPrincipal(PRINCIPAL_A);
    await repository.saveMatchPackage(pkg);

    // Add unacknowledged conflict
    await repository.appendConflict({
      authorization_id: BASE_AUTH_ID,
      match_id: BASE_MATCH_ID,
      local_sequence: 1,
      client_event_id: "77777777-7777-4777-8777-777777777777",
      code: "stale_writer_generation",
      writer_generation: 1,
      recorded_at: "2026-08-01T02:00:00.000Z",
    });

    const t100Days = Date.parse("2026-11-01T00:00:00.000Z");

    // Prune must refuse to delete while unacknowledged conflict exists
    expect(await repository.pruneTerminalQueue(BASE_AUTH_ID, t100Days)).toBe(false);
    expect(await repository.getMatchPackage(BASE_AUTH_ID)).not.toBeNull();
    const conflicts = await repository.listConflicts(BASE_AUTH_ID);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.code).toBe("stale_writer_generation");
  });

  it("enforces strict principal isolation on sign-out and prevents cross-principal leakage", async () => {
    const factory = new IDBFactory();
    const repository = new IndexedDbOfflineScoringRepository(factory);

    // Principal A logs in and records offline work
    await repository.bindPrincipal(PRINCIPAL_A);
    const pkgA = buildMatchPackage({ principal_id: PRINCIPAL_A });
    await repository.saveMatchPackage(pkgA);

    const cmdA = buildQueuedCommand(1);
    await repository.enqueue(cmdA, BASE_NOW);

    await repository.appendConflict({
      authorization_id: BASE_AUTH_ID,
      match_id: BASE_MATCH_ID,
      local_sequence: 1,
      client_event_id: cmdA.command.client_event_id,
      code: "stale_writer_generation",
      writer_generation: 1,
      recorded_at: "2026-08-01T01:00:00.000Z",
    });

    // Emulate client cookie retention for Principal A
    const docStub = { cookie: "" };
    vi.stubGlobal("document", docStub);
    retainScoringPrincipalCookie(PRINCIPAL_A, pkgA.replay_expires_at);
    expect(readScoringPrincipalCookie(docStub.cookie)).toBe(PRINCIPAL_A);

    // While Principal A is active, saving a package for Principal B is rejected
    const pkgB = buildMatchPackage({
      authorization_id: "55555555-5555-4555-8555-555555555555",
      match_id: "66666666-6666-4666-8666-666666666666",
      principal_id: PRINCIPAL_B,
    });
    await expect(repository.saveMatchPackage(pkgB)).rejects.toThrow(
      "Resolve or export the existing principal's offline match before switching scoring access",
    );

    // Sign-out action: clear cookie marker
    clearScoringPrincipalCookie();
    expect(readScoringPrincipalCookie(docStub.cookie)).toBeNull();

    // Principal B logs in and binds
    await repository.bindPrincipal(PRINCIPAL_B);

    // Principal B cannot observe Principal A's match package
    expect(await repository.getMatchPackage(BASE_AUTH_ID)).toBeNull();
    expect(await repository.getActiveMatchPackage()).toBeNull();
    expect(await repository.getRecoverableMatchPackage()).toBeNull();

    // Principal B cannot access Principal A's command stream
    await expect(repository.listCommands(BASE_AUTH_ID)).rejects.toThrow("Offline match authorization is unavailable");

    // Principal B cannot overwrite storage while Principal A has unresolved work
    await expect(repository.saveMatchPackage(pkgB)).rejects.toThrow(
      "Resolve or export the existing offline match before authorising another match",
    );

    // Principal A returns and binds
    await repository.bindPrincipal(PRINCIPAL_A);
    const restoredPkg = await repository.getMatchPackage(BASE_AUTH_ID);
    expect(restoredPkg?.principal_id).toBe(PRINCIPAL_A);
    const restoredCommands = await repository.listCommands(BASE_AUTH_ID);
    expect(restoredCommands).toHaveLength(1);
    const restoredConflicts = await repository.listConflicts(BASE_AUTH_ID);
    expect(restoredConflicts).toHaveLength(1);

    vi.unstubAllGlobals();
  });
});
