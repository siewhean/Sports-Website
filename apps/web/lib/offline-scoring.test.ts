import type {
  GateCOfflineAcknowledgement,
  GateCOfflineMatchPackage,
  GateCOfflineQueuedCommand,
  GateCOfflineReplayReceipt,
} from "@matchday/contracts";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { createOfflineDiagnosticExport } from "./offline-scoring/export";
import {
  IndexedDbOfflineScoringRepository,
  OFFLINE_SCORING_DATABASE_NAME,
  offlineScoringStoreNames,
  openOfflineScoringDatabase,
} from "./offline-scoring/indexeddb";
import { OfflineReplayController } from "./offline-scoring/replay";
import type { OfflineScoringRepository } from "./offline-scoring/types";
import {
  OfflineReconnectSingleFlight,
  enqueueOfflineEvent,
  reconcileOfflineReplayRecovery,
  recoverOfflineScoringSession,
} from "./offline-scoring-coordinator";
import type { ScoringSessionView } from "./phase2";

const authorizationId = "10000000-0000-4000-8000-000000000001";
const matchId = "20000000-0000-4000-8000-000000000002";

describe("Gate C offline reconnect ownership", () => {
  it("serializes concurrent online, manual-sync and effect triggers into one operation", async () => {
    const owner = new OfflineReconnectSingleFlight();
    let release: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const operation = vi.fn(() => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (operation.mock.calls.length > 1) {
        active -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        release = () => {
          active -= 1;
          resolve();
        };
      });
    });

    const online = owner.run(operation);
    const manual = owner.run(operation);
    const effect = owner.run(operation);

    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(manual).toBe(online);
    expect(effect).toBe(online);
    release?.();
    await online;
    expect(operation).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);

    await owner.run(operation);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("runs one trailing reconnect when an online trigger arrives during an offline attempt", async () => {
    const owner = new OfflineReconnectSingleFlight();
    let releaseOfflineAttempt: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const outcomes: string[] = [];
    const operation = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const attempt = operation.mock.calls.length;
      if (attempt === 1) {
        await new Promise<void>((resolve) => {
          releaseOfflineAttempt = resolve;
        });
        outcomes.push("offline");
      } else {
        outcomes.push("synced");
      }
      active -= 1;
    });

    const manualSync = owner.run(operation);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    const onlineEvent = owner.run(operation);
    const duplicateEffect = owner.run(operation);
    expect(onlineEvent).toBe(manualSync);
    expect(duplicateEffect).toBe(manualSync);

    releaseOfflineAttempt?.();
    await manualSync;

    expect(operation).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual(["offline", "synced"]);
    expect(maximumActive).toBe(1);
    await expect(owner.waitForIdle()).resolves.toBeUndefined();
  });

  it("starts a new reconnect after the prior operation settles without a stale ownership window", async () => {
    const owner = new OfflineReconnectSingleFlight();
    const calls: string[] = [];
    const first = owner.run(async () => {
      calls.push("first");
    });
    await first;

    const second = owner.run(async () => {
      calls.push("second");
    });

    expect(second).not.toBe(first);
    await second;
    expect(calls).toEqual(["first", "second"]);
  });

  it("releases ownership after a failed reconnect so an explicit retry can proceed", async () => {
    const owner = new OfflineReconnectSingleFlight();
    const failure = new Error("offline");
    const operation = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);

    await expect(owner.run(operation)).rejects.toBe(failure);
    await expect(owner.run(operation)).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("allows destructive cleanup to wait until an aborted reconnect releases ownership", async () => {
    const owner = new OfflineReconnectSingleFlight();
    let release: (() => void) | undefined;
    const reconnect = owner.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let idle = false;
    const waiting = owner.waitForIdle().then(() => {
      idle = true;
    });

    await Promise.resolve();
    expect(idle).toBe(false);
    release?.();
    await reconnect;
    await waiting;
    expect(idle).toBe(true);
  });

  it("keeps a completed package terminal when authoritative recovery confirms finalisation", async () => {
    const saveMatchPackage = vi.fn();
    const repository = {
      listAcknowledgements: vi.fn().mockResolvedValue([
        {
          authorization_id: authorizationId,
          match_id: matchId,
          local_sequence: 3,
          client_event_id: "60000000-0000-4000-8000-000000000006",
          command_fingerprint: "a".repeat(64),
          outcome: "accepted",
          event_id: "50000000-0000-4000-8000-000000000005",
          sequence: 3,
          aggregate_version: 3,
          result_version: 1,
          publication_version: 1,
          server_received_at: "2026-07-28T01:10:00.000Z",
          acknowledged_at: "2026-07-28T01:10:00.000Z",
        },
      ]),
      saveMatchPackage,
    } as unknown as OfflineScoringRepository;
    const session = {
      matchId,
      scoreState: { lifecycle: "finalised" },
    } as unknown as ScoringSessionView;

    await expect(
      reconcileOfflineReplayRecovery(repository, session, {
        authorization_id: authorizationId,
      } as never),
    ).resolves.toEqual({
      receiptId: `${matchId}:v1`,
      publishedAt: "2026-07-28T01:10:00.000Z",
    });
    expect(saveMatchPackage).not.toHaveBeenCalled();
  });

  it("fails closed when finalised recovery has no durable result acknowledgement", async () => {
    const saveMatchPackage = vi.fn();
    const repository = {
      listAcknowledgements: vi.fn().mockResolvedValue([]),
      saveMatchPackage,
    } as unknown as OfflineScoringRepository;
    const session = {
      matchId,
      scoreState: { lifecycle: "finalised" },
    } as unknown as ScoringSessionView;

    await expect(
      reconcileOfflineReplayRecovery(repository, session, {
        authorization_id: authorizationId,
      } as never),
    ).rejects.toThrow("no durable finalisation acknowledgement");
    expect(saveMatchPackage).not.toHaveBeenCalled();
  });
});

function matchPackage(overrides: Partial<GateCOfflineMatchPackage> = {}): GateCOfflineMatchPackage {
  return {
    schema_version: 1,
    principal_id: "b".repeat(64),
    authorization_id: authorizationId,
    competition_id: "30000000-0000-4000-8000-000000000003",
    competition_slug: "offline-cup",
    match_id: matchId,
    match_code: "M1",
    match_stage: "Group A",
    writer_generation: 5,
    sport_code: "canoe_polo",
    sport_pack_version: "1.0.0",
    settings: { manualEventTime: true },
    participants: [{ id: "40000000-0000-4000-8000-000000000004", name: "Player One", side: "home" }],
    authoritative_events: [],
    last_acknowledged_sequence: 0,
    last_acknowledged_aggregate_version: 0,
    authorized_at: "2026-07-28T00:00:00.000Z",
    recording_expires_at: "2026-07-28T04:00:00.000Z",
    replay_expires_at: "2026-07-28T04:15:00.000Z",
    pass_expires_at: "2026-07-28T05:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

function event(localSequence: number, clientEventId: string): GateCOfflineQueuedCommand {
  return {
    authorization_id: authorizationId,
    match_id: matchId,
    local_sequence: localSequence,
    writer_generation: 5,
    enqueued_at: `2026-07-28T00:0${localSequence}:00.000Z`,
    command: {
      kind: "event",
      client_event_id: clientEventId,
      expected_sequence: localSequence - 1,
      type: "goal",
      occurred_at: `2026-07-28T00:0${localSequence}:00.000Z`,
      team_slot: "home",
      participant_id: "40000000-0000-4000-8000-000000000004",
      segment_number: 1,
      manual_time_seconds: 60,
    },
  };
}

function acknowledgement(command: GateCOfflineQueuedCommand): GateCOfflineAcknowledgement {
  return {
    authorization_id: authorizationId,
    match_id: matchId,
    local_sequence: command.local_sequence,
    client_event_id: command.command.client_event_id,
    command_fingerprint: String(command.local_sequence).repeat(64),
    outcome: "accepted",
    event_id: `50000000-0000-4000-8000-00000000000${command.local_sequence}`,
    sequence: command.local_sequence,
    aggregate_version: command.local_sequence,
    server_received_at: "2026-07-28T00:10:00.000Z",
    acknowledged_at: "2026-07-28T00:10:00.000Z",
  };
}

function repositoryWithOverrides(
  repository: OfflineScoringRepository,
  overrides: Partial<OfflineScoringRepository>,
): OfflineScoringRepository {
  return new Proxy(repository, {
    get(target, property) {
      const override = Reflect.get(overrides, property);
      if (override !== undefined) return override;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("Gate C native IndexedDB queue", () => {
  it("does not expose another scoring principal's retained match package or queue", async () => {
    const factory = new IDBFactory();
    const repository = new IndexedDbOfflineScoringRepository(factory);
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.saveMatchPackage(matchPackage({ principal_id: "b".repeat(64) }));
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));

    await repository.bindPrincipal("c".repeat(64));

    await expect(repository.getMatchPackage(authorizationId)).resolves.toBeNull();
    await expect(repository.getRecoverableMatchPackage()).resolves.toBeNull();
    await expect(repository.listCommands(authorizationId)).rejects.toThrow(
      "Offline match authorization is unavailable",
    );

    await repository.bindPrincipal("b".repeat(64));
    await expect(repository.getMatchPackage(authorizationId)).resolves.toMatchObject({
      principal_id: "b".repeat(64),
    });
    await expect(repository.listCommands(authorizationId)).resolves.toHaveLength(1);
  });

  it("creates exactly the seven schema-v1 stores and persists across reopen", async () => {
    const factory = new IDBFactory();
    const first = await openOfflineScoringDatabase(factory);
    expect([...first.objectStoreNames]).toEqual([...offlineScoringStoreNames].sort());
    first.close();

    const repository = new IndexedDbOfflineScoringRepository(factory);
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z"));
    expect(await repository.listPendingCommands(authorizationId)).toHaveLength(1);

    const reopened = new IndexedDbOfflineScoringRepository(factory);
    expect(await reopened.getMatchPackage(authorizationId)).toMatchObject({ match_id: matchId });
    expect(await reopened.listCommands(authorizationId)).toHaveLength(1);
  });

  it("keeps commands and acknowledgements immutable", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    await expect(repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"))).rejects.toThrow(
      "local sequence must be 2",
    );
    const receipt = acknowledgement(queued);
    await repository.appendAcknowledgement(receipt);
    await repository.appendAcknowledgement(receipt);
    await expect(repository.appendAcknowledgement({ ...receipt, aggregate_version: 9 })).rejects.toThrow("immutable");
    expect(await repository.listPendingCommands(authorizationId)).toEqual([]);
  });

  it("restores acknowledged local events without rolling the projection back", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const queued = {
      ...event(1, "60000000-0000-4000-8000-000000000006"),
      command: {
        ...event(1, "60000000-0000-4000-8000-000000000006").command,
        expected_sequence: 1,
      },
    } satisfies GateCOfflineQueuedCommand;
    await repository.saveMatchPackage(
      matchPackage({
        authoritative_events: [
          {
            event_id: "90000000-0000-4000-8000-000000000009",
            sequence: 1,
            command: {
              kind: "event",
              client_event_id: "91000000-0000-4000-8000-000000000009",
              expected_sequence: 0,
              type: "match_started",
              occurred_at: "2026-07-28T00:00:00.000Z",
            },
          },
        ],
        last_acknowledged_sequence: 1,
        last_acknowledged_aggregate_version: 1,
      }),
    );
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    const receipt = { ...acknowledgement(queued), sequence: 2, aggregate_version: 2 };
    await repository.appendAcknowledgement(receipt);

    const recovered = await recoverOfflineScoringSession(repository);

    expect(recovered?.pendingCount).toBe(0);
    expect(recovered?.session.scoreState.home).toBe(1);
    expect(recovered?.session.scoreState.actions).toEqual([
      expect.objectContaining({
        clientEventId: queued.command.client_event_id,
        eventId: receipt.event_id,
      }),
    ]);

    await repository.saveMatchPackage(
      matchPackage({
        authoritative_events: [
          {
            event_id: "90000000-0000-4000-8000-000000000009",
            sequence: 1,
            command: {
              kind: "event",
              client_event_id: "91000000-0000-4000-8000-000000000009",
              expected_sequence: 0,
              type: "match_started",
              occurred_at: "2026-07-28T00:00:00.000Z",
            },
          },
          {
            event_id: receipt.event_id!,
            sequence: 2,
            command: queued.command,
          },
        ],
        last_acknowledged_sequence: 2,
        last_acknowledged_aggregate_version: 2,
      }),
    );

    const promoted = await recoverOfflineScoringSession(repository);
    expect(promoted?.session.scoreState.home).toBe(1);
    expect(promoted?.session.scoreState.actions).toHaveLength(1);
    expect(promoted?.session.canonicalEvents).toHaveLength(2);

    const refreshedPackage = await repository.getMatchPackage(authorizationId);
    if (!refreshedPackage) throw new Error("Refreshed package is required");
    await enqueueOfflineEvent(
      repository,
      refreshedPackage,
      {
        clientEventId: "92000000-0000-4000-8000-000000000009",
        expectedSequence: 2,
        matchId,
        eventType: "incident",
        canonical: true,
        scorer: "",
        period: 1,
        segmentNumber: 1,
        manualTime: "08:00",
        manualTimeSeconds: 480,
        occurredAt: "2026-07-28T01:30:00.000Z",
      },
      Date.parse("2026-07-28T01:30:00.000Z"),
    );

    const allCommands = await repository.listCommands(authorizationId);
    expect(allCommands).toHaveLength(2);
    expect(allCommands[1]).toMatchObject({
      local_sequence: 2,
      command: { expected_sequence: 2, type: "incident" },
    });
    expect(await repository.listPendingCommands(authorizationId)).toEqual([allCommands[1]]);
  });

  it("fails closed when a stored command changes identity before restart recovery", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    const corrupted = repositoryWithOverrides(repository, {
      listCommands: async () => [
        {
          ...queued,
          match_id: "80000000-0000-4000-8000-000000000008",
        },
      ],
    });

    await expect(recoverOfflineScoringSession(corrupted)).rejects.toThrow("authorised match generation");
  });

  it("fails closed when stored acknowledgements are forged into a gapped prefix", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const first = event(1, "60000000-0000-4000-8000-000000000006");
    const second = event(2, "70000000-0000-4000-8000-000000000007");
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(first, Date.parse("2026-07-28T01:00:00Z"));
    await repository.enqueue(second, Date.parse("2026-07-28T01:01:00Z"));
    const corrupted = repositoryWithOverrides(repository, {
      listAcknowledgements: async () => [acknowledgement(second)],
    });

    await expect(recoverOfflineScoringSession(corrupted)).rejects.toThrow("contiguous prefix");
  });

  it("rejects commands outside the authorised match generation or expected sequence", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    const valid = event(1, "60000000-0000-4000-8000-000000000006");
    await expect(
      repository.enqueue({ ...valid, writer_generation: 4 }, Date.parse("2026-07-28T01:00:00Z")),
    ).rejects.toThrow("authorised match generation");
    await expect(
      repository.enqueue(
        { ...valid, command: { ...valid.command, expected_sequence: 3 } },
        Date.parse("2026-07-28T01:00:00Z"),
      ),
    ).rejects.toThrow("queue cannot begin");
    expect(await repository.listCommands(authorizationId)).toEqual([]);
  });

  it("fails closed when persisted authorization timestamps are corrupt", async () => {
    const factory = new IDBFactory();
    const repository = new IndexedDbOfflineScoringRepository(factory);
    await repository.saveMatchPackage(matchPackage());
    const database = await openOfflineScoringDatabase(factory);
    const transaction = database.transaction("match_packages", "readwrite");
    transaction.objectStore("match_packages").put({
      ...matchPackage(),
      recording_expires_at: "not-a-timestamp",
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    await expect(repository.getMatchPackage(authorizationId)).rejects.toThrow("windows are invalid");
    await expect(
      repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z")),
    ).rejects.toThrow("windows are invalid");
  });

  it("rejects incomplete finalisation acknowledgements", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const finalisation: GateCOfflineQueuedCommand = {
      authorization_id: authorizationId,
      match_id: matchId,
      local_sequence: 1,
      writer_generation: 5,
      enqueued_at: "2026-07-28T01:00:00.000Z",
      command: {
        kind: "finalisation",
        client_event_id: "60000000-0000-4000-8000-000000000006",
        expected_sequence: 0,
        occurred_at: "2026-07-28T01:00:00.000Z",
      },
    };
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(finalisation, Date.parse("2026-07-28T01:00:00Z"));
    await expect(
      repository.appendAcknowledgement({
        authorization_id: authorizationId,
        match_id: matchId,
        local_sequence: 1,
        client_event_id: finalisation.command.client_event_id,
        command_fingerprint: "a".repeat(64),
        outcome: "accepted",
        sequence: 1,
        aggregate_version: 1,
        server_received_at: "2026-07-28T01:01:00.000Z",
        acknowledged_at: "2026-07-28T01:01:00.000Z",
      }),
    ).rejects.toThrow("does not match");
  });

  it("refuses a second active profile grant while unresolved work exists", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z"));
    await expect(
      repository.saveMatchPackage(
        matchPackage({
          authorization_id: "70000000-0000-4000-8000-000000000007",
          match_id: "80000000-0000-4000-8000-000000000008",
        }),
      ),
    ).rejects.toThrow("existing offline match");
  });

  it("replaces a resolved profile grant and retires the previous package", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    await repository.appendAcknowledgement(acknowledgement(queued));
    const nextAuthorization = "70000000-0000-4000-8000-000000000007";
    await repository.saveMatchPackage(
      matchPackage({
        authorization_id: nextAuthorization,
        match_id: "80000000-0000-4000-8000-000000000008",
      }),
    );
    expect(await repository.getMatchPackage(authorizationId)).toMatchObject({ status: "completed" });
    expect(await repository.getActiveMatchPackage()).toMatchObject({ authorization_id: nextAuthorization });
  });

  it("requires an exact export checksum before destructive cleanup", async () => {
    const factory = new IDBFactory();
    const repository = new IndexedDbOfflineScoringRepository(factory);
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z"));
    const exported = await createOfflineDiagnosticExport(
      repository,
      authorizationId,
      Date.parse("2026-07-28T01:30:00Z"),
    );

    await expect(repository.discardAfterExport(authorizationId, exported.sha256, "b".repeat(64))).rejects.toThrow(
      "exact diagnostic export checksum",
    );
    await repository.discardAfterExport(authorizationId, exported.sha256, exported.sha256);
    expect(await repository.getMatchPackage(authorizationId)).toBeNull();

    const deletion = factory.deleteDatabase(OFFLINE_SCORING_DATABASE_NAME);
    await new Promise<void>((resolve, reject) => {
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
    });
  });

  it("discards a resolved authorization without export but refuses unresolved work", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    await repository.discardResolvedAuthorization(authorizationId);
    expect(await repository.getMatchPackage(authorizationId)).toBeNull();

    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z"));
    await expect(repository.discardResolvedAuthorization(authorizationId)).rejects.toThrow(
      "requires an exported diagnostic",
    );
    expect(await repository.getMatchPackage(authorizationId)).not.toBeNull();
  });

  it("refuses cleanup when append-only work changed after export", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z"));
    const exported = await createOfflineDiagnosticExport(
      repository,
      authorizationId,
      Date.parse("2026-07-28T01:30:00Z"),
    );
    await repository.enqueue(event(2, "70000000-0000-4000-8000-000000000007"), Date.parse("2026-07-28T01:31:00Z"));
    await expect(repository.discardAfterExport(authorizationId, exported.sha256, exported.sha256)).rejects.toThrow(
      "changed after export",
    );
    expect(await repository.listPendingCommands(authorizationId)).toHaveLength(2);
  });

  it("refuses cleanup after same-count command corruption", async () => {
    const factory = new IDBFactory();
    const repository = new IndexedDbOfflineScoringRepository(factory);
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    const exported = await createOfflineDiagnosticExport(
      repository,
      authorizationId,
      Date.parse("2026-07-28T01:30:00Z"),
    );
    const database = await openOfflineScoringDatabase(factory);
    const transaction = database.transaction("commands", "readwrite");
    transaction.objectStore("commands").put({
      ...queued,
      command: { ...queued.command, type: "red_card" },
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    await expect(repository.discardAfterExport(authorizationId, exported.sha256, exported.sha256)).rejects.toThrow(
      "changed after export",
    );
    expect(await repository.listCommands(authorizationId)).toHaveLength(1);
  });

  it("fences competing replay owners with a monotonic IndexedDB epoch", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    expect(await repository.acquireReplayLease(authorizationId, "owner-a", 1_000, 30_000)).toBe(1);
    expect(await repository.acquireReplayLease(authorizationId, "owner-b", 2_000, 30_000)).toBeNull();
    expect(await repository.acquireReplayLease(authorizationId, "owner-b", 31_001, 30_000)).toBe(2);
    expect(await repository.renewReplayLease(authorizationId, "owner-a", 1, 31_002, 30_000)).toBe(false);
  });

  it("prunes only an acknowledged terminal queue after the 72-hour retention window", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.saveMatchPackage(
      matchPackage({
        status: "completed",
        authorized_at: "2026-06-01T00:00:00.000Z",
        recording_expires_at: "2026-06-01T04:00:00.000Z",
        replay_expires_at: "2026-06-01T04:15:00.000Z",
        pass_expires_at: "2026-06-01T05:00:00.000Z",
      }),
    );
    // 72h retention: 2026-06-01T04:15:00.000Z + 72h = 2026-06-04T04:15:00.000Z
    await expect(repository.pruneTerminalQueue(authorizationId, Date.parse("2026-06-04T04:14:59.000Z"))).resolves.toBe(
      false,
    );
    await expect(repository.pruneTerminalQueue(authorizationId, Date.parse("2026-06-04T04:15:00.000Z"))).resolves.toBe(
      true,
    );
    expect(await repository.getMatchPackage(authorizationId)).toBeNull();

    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    await expect(repository.pruneTerminalQueue(authorizationId, Date.parse("2026-09-01T00:00:00.000Z"))).resolves.toBe(
      false,
    );
  });
});

describe("Gate C ordered replay", () => {
  it("uses non-blocking Web Locks without the incompatible signal option", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    const abortController = new AbortController();
    const request = vi.fn(
      async (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>): Promise<void> => {
        expect(name).toBe(`matchday-offline-replay:${authorizationId}`);
        expect(options).toEqual({ ifAvailable: true, mode: "exclusive" });
        expect(options).not.toHaveProperty("signal");
        await callback({ name, mode: "exclusive" } as Lock);
      },
    );
    const submit = vi.fn(async (_queued, _resolved, signal): Promise<GateCOfflineReplayReceipt> => {
      expect(signal).toBe(abortController.signal);
      return { status: "acknowledged", acknowledgement: acknowledgement(queued) };
    });
    const controller = new OfflineReplayController({
      repository,
      port: { submit },
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: { request: request as unknown as LockManager["request"] },
    });

    await expect(controller.replay(authorizationId, abortController.signal)).resolves.toEqual({
      status: "complete",
      acknowledged: 1,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-aborted replay before requesting a Web Lock", async () => {
    const abortController = new AbortController();
    abortController.abort(new DOMException("Sign-out cancelled replay.", "AbortError"));
    const request = vi.fn();
    const controller = new OfflineReplayController({
      repository: {} as OfflineScoringRepository,
      port: { submit: vi.fn() },
      lockManager: { request: request as unknown as LockManager["request"] },
    });

    await expect(controller.replay(authorizationId, abortController.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("submits one at a time in local order and durably records receipts", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const first = event(1, "60000000-0000-4000-8000-000000000006");
    const second = event(2, "70000000-0000-4000-8000-000000000007");
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(first, Date.parse("2026-07-28T01:00:00Z"));
    await repository.enqueue(second, Date.parse("2026-07-28T01:00:01Z"));
    const submitted: number[] = [];
    const controller = new OfflineReplayController({
      repository,
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
      port: {
        submit: async (queued): Promise<GateCOfflineReplayReceipt> => {
          submitted.push(queued.local_sequence);
          expect(submitted.length).toBe(queued.local_sequence);
          return { status: "acknowledged", acknowledgement: acknowledgement(queued) };
        },
      },
    });

    await expect(controller.replay(authorizationId)).resolves.toEqual({ status: "complete", acknowledged: 2 });
    expect(submitted).toEqual([1, 2]);
    expect(await repository.listPendingCommands(authorizationId)).toEqual([]);
  });

  it("stops at the first conflict without submitting later commands", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z"));
    await repository.enqueue(event(2, "70000000-0000-4000-8000-000000000007"), Date.parse("2026-07-28T01:00:01Z"));
    const submit = vi.fn(async (): Promise<GateCOfflineReplayReceipt> => ({
      status: "blocked",
      error: { code: "stale_writer_generation", category: "conflict" },
    }));
    const controller = new OfflineReplayController({
      repository,
      port: { submit },
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
    });

    await expect(controller.replay(authorizationId)).resolves.toMatchObject({
      status: "blocked",
      acknowledged: 0,
      error: { code: "stale_writer_generation" },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await repository.listPendingCommands(authorizationId)).toHaveLength(2);
    expect(await repository.listConflicts(authorizationId)).toMatchObject([
      { local_sequence: 1, code: "stale_writer_generation" },
    ]);
  });

  it("does not persist a stale receipt after another fallback owner acquires a newer epoch", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    let now = 1_000;
    const controller = new OfflineReplayController({
      repository,
      now: () => now,
      isOnline: () => true,
      lockManager: null,
      port: {
        submit: async (): Promise<GateCOfflineReplayReceipt> => {
          now = 31_001;
          expect(await repository.acquireReplayLease(authorizationId, "new-owner", now, 30_000)).toBe(2);
          return { status: "acknowledged", acknowledgement: acknowledgement(queued) };
        },
      },
    });

    await expect(controller.replay(authorizationId)).resolves.toEqual({ status: "busy", acknowledged: 0 });
    expect(await repository.listAcknowledgements(authorizationId)).toEqual([]);
    expect(await repository.listReplayAttempts(authorizationId)).toEqual([]);
    expect(await repository.listPendingCommands(authorizationId)).toHaveLength(1);
  });

  it("fences a mounted principal switch during replay and preserves the unresolved queue", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const principalA = "a".repeat(64);
    const principalB = "b".repeat(64);
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.bindPrincipal(principalA);
    await repository.saveMatchPackage(matchPackage({ principal_id: principalA }));
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    let releaseSubmit: (() => void) | undefined;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const submit = vi.fn(async (): Promise<GateCOfflineReplayReceipt> => {
      await submitGate;
      return { status: "acknowledged", acknowledgement: acknowledgement(queued) };
    });
    const controller = new OfflineReplayController({
      repository,
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
      port: { submit },
    });
    const primaryReplay = controller.replay(authorizationId);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(repository.listPendingCommands(authorizationId)).resolves.toHaveLength(1));
    await repository.bindPrincipal(principalB);

    const secondReplay = await new OfflineReplayController({
      repository,
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
      port: { submit: vi.fn() },
    }).replay(authorizationId);
    expect(secondReplay).toEqual({ status: "busy", acknowledged: 0 });
    expect(await repository.getMatchPackage(authorizationId)).toBeNull();

    releaseSubmit?.();
    await expect(primaryReplay).resolves.toEqual({
      status: "blocked",
      acknowledged: 0,
      error: { code: "storage_corrupt", category: "storage" },
    });

    await repository.bindPrincipal(principalA);
    expect(await repository.getMatchPackage(authorizationId)).not.toBeNull();
    expect(await repository.listPendingCommands(authorizationId)).toHaveLength(1);
    expect(await repository.listAcknowledgements(authorizationId)).toEqual([]);
  });

  it("rejects a receipt when the active principal switches away and back during submission", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const principalA = "a".repeat(64);
    const principalB = "b".repeat(64);
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.bindPrincipal(principalA);
    await repository.saveMatchPackage(matchPackage({ principal_id: principalA }));
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    let releaseSubmit: (() => void) | undefined;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const submit = vi.fn(async (): Promise<GateCOfflineReplayReceipt> => {
      await submitGate;
      return { status: "acknowledged", acknowledgement: acknowledgement(queued) };
    });
    const replay = new OfflineReplayController({
      repository,
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
      port: { submit },
    }).replay(authorizationId);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

    await repository.bindPrincipal(principalB);
    await repository.bindPrincipal(principalA);
    releaseSubmit?.();

    await expect(replay).resolves.toEqual({ status: "busy", acknowledged: 0 });
    expect(await repository.listPendingCommands(authorizationId)).toHaveLength(1);
    expect(await repository.listReplayAttempts(authorizationId)).toEqual([]);
    expect(await repository.listAcknowledgements(authorizationId)).toEqual([]);
  });

  it("resolves a queued local reversal to the earlier server event receipt", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const first = event(1, "60000000-0000-4000-8000-000000000006");
    const reversal: GateCOfflineQueuedCommand = {
      authorization_id: authorizationId,
      match_id: matchId,
      local_sequence: 2,
      writer_generation: 5,
      enqueued_at: "2026-07-28T01:01:00.000Z",
      command: {
        kind: "event",
        client_event_id: "70000000-0000-4000-8000-000000000007",
        expected_sequence: 1,
        type: "reversal",
        occurred_at: "2026-07-28T01:01:00.000Z",
        reversal_target_client_event_id: first.command.client_event_id,
        reason: "Wrong scorer",
      },
    };
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(first, Date.parse("2026-07-28T01:00:00Z"));
    await repository.enqueue(reversal, Date.parse("2026-07-28T01:01:00Z"));
    const resolvedTargets: Array<string | undefined> = [];
    const controller = new OfflineReplayController({
      repository,
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
      port: {
        submit: async (queued, resolved): Promise<GateCOfflineReplayReceipt> => {
          resolvedTargets.push(resolved.kind === "event" ? resolved.reversal_target_event_id : undefined);
          return { status: "acknowledged", acknowledgement: acknowledgement(queued) };
        },
      },
    });
    await controller.replay(authorizationId);
    expect(resolvedTargets).toEqual([undefined, acknowledgement(first).event_id]);
    expect(reversal.command).toHaveProperty("reversal_target_client_event_id", first.command.client_event_id);
  });

  it("uses the bounded 1/2/4/8/16 second retry schedule then retains the command", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z"));
    const sleeps: number[] = [];
    const submit = vi.fn(async (): Promise<GateCOfflineReplayReceipt> => ({
      status: "retry",
      error: { code: "server_unavailable", category: "retryable" },
    }));
    const controller = new OfflineReplayController({
      repository,
      port: { submit },
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    await expect(controller.replay(authorizationId)).resolves.toMatchObject({
      status: "blocked",
      acknowledged: 0,
      error: { code: "server_unavailable" },
    });
    expect(submit).toHaveBeenCalledTimes(6);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(await repository.listPendingCommands(authorizationId)).toHaveLength(1);
  });

  it("cancels before retry backoff when the signal was aborted while a submission was in flight", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z"));
    const abortController = new AbortController();
    const sleep = vi.fn();
    const submit = vi.fn(async (): Promise<GateCOfflineReplayReceipt> => {
      abortController.abort(new DOMException("Sign-out cancelled replay.", "AbortError"));
      return {
        status: "retry",
        error: { code: "server_unavailable", category: "retryable" },
      };
    });
    const controller = new OfflineReplayController({
      repository,
      port: { submit },
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
      sleep,
    });

    await expect(controller.replay(authorizationId, abortController.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(await repository.listPendingCommands(authorizationId)).toHaveLength(1);
    expect(await repository.acquireReplayLease(authorizationId, "next-owner", 1, 30_000)).toBe(1);
  });

  it("reports transferred authority without submitting queued work", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(
      matchPackage({
        authoritative_events: [
          {
            event_id: "90000000-0000-4000-8000-000000000009",
            sequence: 1,
            command: {
              kind: "event",
              client_event_id: "91000000-0000-4000-8000-000000000009",
              expected_sequence: 0,
              type: "match_started",
              occurred_at: "2026-07-28T00:00:00.000Z",
            },
          },
        ],
        last_acknowledged_sequence: 1,
        last_acknowledged_aggregate_version: 1,
      }),
    );
    const queued = event(1, "60000000-0000-4000-8000-000000000006");
    await repository.enqueue(
      { ...queued, command: { ...queued.command, expected_sequence: 1 } },
      Date.parse("2026-07-28T01:00:00Z"),
    );
    await repository.transitionMatchPackageStatus(authorizationId, "transferred");
    const submit = vi.fn();
    const controller = new OfflineReplayController({
      repository,
      port: { submit },
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
    });
    await expect(controller.replay(authorizationId)).resolves.toMatchObject({
      status: "blocked",
      error: { code: "authority_transferred" },
    });
    expect(submit).not.toHaveBeenCalled();
    await expect(recoverOfflineScoringSession(repository)).resolves.toMatchObject({
      matchPackage: { status: "transferred" },
      pendingCount: 1,
      session: { readOnly: true, scoreState: { home: 1 } },
    });
    await expect(createOfflineDiagnosticExport(repository, authorizationId)).resolves.toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    ["authority_revoked", "revoked"],
    ["authority_expired", "expired"],
    ["stale_writer_generation", "transferred"],
  ] as const)("persists %s as terminal %s across restart", async (code, expectedStatus) => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(event(1, "60000000-0000-4000-8000-000000000006"), Date.parse("2026-07-28T01:00:00Z"));
    const controller = new OfflineReplayController({
      repository,
      now: () => Date.parse("2026-07-28T01:10:00Z"),
      isOnline: () => true,
      lockManager: null,
      port: {
        submit: async (): Promise<GateCOfflineReplayReceipt> => ({
          status: "blocked",
          error: { code, category: "permission" },
        }),
      },
    });
    await expect(controller.replay(authorizationId)).resolves.toMatchObject({ status: "blocked" });
    expect(await repository.getMatchPackage(authorizationId)).toMatchObject({ status: expectedStatus });
    await expect(
      repository.enqueue(event(2, "70000000-0000-4000-8000-000000000007"), Date.parse("2026-07-28T01:11:00Z")),
    ).rejects.toThrow(`cannot accept another command: ${expectedStatus}`);
  });
});

describe("Gate C sanitized recovery export", () => {
  it("retains only queue metadata, server fingerprints, timestamps, and conflict codes", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const original = event(1, "60000000-0000-4000-8000-000000000006");
    if (original.command.kind !== "event") throw new Error("Test fixture must be an event.");
    const queued: GateCOfflineQueuedCommand = {
      ...original,
      command: {
        ...original.command,
        participant_id: "Alex Smith",
        reason: "Contact scorer@example.com or +65 9123 4567",
      },
    };
    await repository.saveMatchPackage(matchPackage());
    await repository.enqueue(queued, Date.parse("2026-07-28T01:00:00Z"));
    await repository.appendAcknowledgement(acknowledgement(queued));
    await repository.appendConflict({
      authorization_id: authorizationId,
      match_id: matchId,
      local_sequence: queued.local_sequence,
      client_event_id: queued.command.client_event_id,
      code: "stale_writer_generation",
      command_fingerprint: "a".repeat(64),
      writer_generation: queued.writer_generation,
      recorded_at: "2026-07-28T01:10:00.000Z",
    });

    const exported = await createOfflineDiagnosticExport(
      repository,
      authorizationId,
      Date.parse("2026-07-28T02:00:00Z"),
    );
    expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.document).toMatchObject({
      export_version: 2,
      queue: {
        command_count: 1,
        acknowledged_count: 1,
        pending_count: 0,
        first_local_sequence: 1,
        last_local_sequence: 1,
        writer_generations: [5],
      },
      acknowledgements: [
        {
          local_sequence: 1,
          command_fingerprint: "1".repeat(64),
          outcome: "accepted",
        },
      ],
      conflicts: [
        {
          local_sequence: 1,
          code: "stale_writer_generation",
          command_fingerprint: "a".repeat(64),
        },
      ],
    });

    for (const forbidden of [
      "canonical_commands",
      '"command"',
      '"participant_id"',
      '"reason"',
      '"client_event_id"',
      '"event_id"',
      "private_integrity",
      "Player One",
      "Alex Smith",
      "manualEventTime",
      "scorer@example.com",
      "9123 4567",
      "[redacted-",
    ]) {
      expect(exported.json).not.toContain(forbidden);
    }
  });

  it("omits adversarial participant, credential, device, network, contact, and reason values", async () => {
    const repository = new IndexedDbOfflineScoringRepository(new IDBFactory());
    const secrets = [
      "participant-low-entropy",
      "reason-low-entropy",
      "raw-device-id-123",
      "offline-verifier-secret",
      "access-token-secret",
      "session-cookie-secret",
      "192.0.2.123",
      "support@example.test",
      "+65 8000 0000",
    ];
    const queued = event(1, "80000000-0000-4000-8000-000000000008");
    if (queued.command.kind !== "event") throw new Error("Test fixture must be an event.");

    await repository.saveMatchPackage(
      matchPackage({
        participants: [{ id: "40000000-0000-4000-8000-000000000004", name: secrets[0]!, side: "home" }],
        settings: {
          raw_device_id: secrets[2],
          offline_verifier: secrets[3],
          access_token: secrets[4],
          session_cookie: secrets[5],
          client_ip: secrets[6],
          contact: secrets[7],
        },
      }),
    );
    await repository.enqueue(
      {
        ...queued,
        command: {
          ...queued.command,
          participant_id: secrets[0],
          reason: `${secrets[1]} ${secrets[7]} ${secrets[8]}`,
        },
      },
      Date.parse("2026-07-28T01:00:00Z"),
    );

    const exported = await createOfflineDiagnosticExport(
      repository,
      authorizationId,
      Date.parse("2026-07-28T02:00:00Z"),
    );
    for (const secret of [...secrets, queued.command.client_event_id]) {
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(exported.json).not.toContain(secret);
      expect(exported.json).not.toContain(digest);
      expect(exported.json).not.toContain(digest.slice(0, 16));
    }
    expect(exported.json).not.toMatch(/\[redacted-(?:participant|reason):[a-f0-9]{16}\]/);
  });
});
