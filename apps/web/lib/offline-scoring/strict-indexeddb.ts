"use client";

import type {
  GateCOfflineAcknowledgement,
  GateCOfflineMatchPackage,
  GateCOfflineQueuedCommand,
} from "@matchday/contracts";
import { canonicalOfflineJson } from "@matchday/domain";
import { buildOfflineDiagnosticDocument } from "./export";
import {
  IndexedDbOfflineScoringRepository as RawIndexedDbOfflineScoringRepository,
  openOfflineScoringDatabase,
} from "./indexeddb";
import type {
  OfflineConflict,
  OfflineReplayAttempt,
  OfflineReplayState,
  OfflineScoringRepository,
} from "./types";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline scoring storage request failed."));
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Offline scoring storage transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Offline scoring storage transaction aborted."));
  });
}

type ExportAttestation = {
  sha256: string;
  canonical_json: string;
  recorded_at: string;
};

type CompleteSnapshot = {
  matchPackage: GateCOfflineMatchPackage | undefined;
  commands: GateCOfflineQueuedCommand[];
  acknowledgements: GateCOfflineAcknowledgement[];
  replayAttempts: OfflineReplayAttempt[];
  replayState: OfflineReplayState | undefined;
  conflicts: OfflineConflict[];
  attestation: ExportAttestation | undefined;
};

async function readCompleteSnapshot(transaction: IDBTransaction, authorizationId: string): Promise<CompleteSnapshot> {
  const [matchPackage, commands, acknowledgements, replayAttempts, replayState, conflicts, attestation] =
    await Promise.all([
      requestResult<GateCOfflineMatchPackage | undefined>(
        transaction.objectStore("match_packages").get(authorizationId),
      ),
      requestResult<GateCOfflineQueuedCommand[]>(
        transaction.objectStore("commands").index("authorization_id").getAll(authorizationId),
      ),
      requestResult<GateCOfflineAcknowledgement[]>(
        transaction.objectStore("acknowledgements").index("authorization_id").getAll(authorizationId),
      ),
      requestResult<OfflineReplayAttempt[]>(
        transaction.objectStore("replay_attempts").index("authorization_id").getAll(authorizationId),
      ),
      requestResult<OfflineReplayState | undefined>(transaction.objectStore("replay_state").get(authorizationId)),
      requestResult<OfflineConflict[]>(
        transaction.objectStore("conflicts").index("authorization_id").getAll(authorizationId),
      ),
      requestResult<ExportAttestation | undefined>(
        transaction.objectStore("meta").get(`diagnostic_export:${authorizationId}`),
      ),
    ]);
  return { matchPackage, commands, acknowledgements, replayAttempts, replayState, conflicts, attestation };
}

async function deleteByAuthorization(
  transaction: IDBTransaction,
  storeName: "commands" | "acknowledgements" | "replay_attempts" | "conflicts",
  authorizationId: string,
): Promise<void> {
  const store = transaction.objectStore(storeName);
  const index = store.index("authorization_id");
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = index.openKeyCursor(authorizationId);
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("Offline data cleanup failed."));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return resolve();
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}

export class StrictIndexedDbOfflineScoringRepository implements OfflineScoringRepository {
  private readonly raw: RawIndexedDbOfflineScoringRepository;

  constructor(private readonly factory: IDBFactory = indexedDB) {
    this.raw = new RawIndexedDbOfflineScoringRepository(factory);
  }

  saveMatchPackage(matchPackage: GateCOfflineMatchPackage): Promise<void> {
    return this.raw.saveMatchPackage(matchPackage);
  }

  transitionMatchPackageStatus(
    authorizationId: string,
    status: Exclude<GateCOfflineMatchPackage["status"], "active">,
  ): Promise<void> {
    return this.raw.transitionMatchPackageStatus(authorizationId, status);
  }

  getMatchPackage(authorizationId: string): Promise<GateCOfflineMatchPackage | null> {
    return this.raw.getMatchPackage(authorizationId);
  }

  getActiveMatchPackage(): Promise<GateCOfflineMatchPackage | null> {
    return this.raw.getActiveMatchPackage();
  }

  getRecoverableMatchPackage(): Promise<GateCOfflineMatchPackage | null> {
    return this.raw.getRecoverableMatchPackage();
  }

  enqueue(command: GateCOfflineQueuedCommand, now?: number): Promise<void> {
    return this.raw.enqueue(command, now);
  }

  listCommands(authorizationId: string): Promise<GateCOfflineQueuedCommand[]> {
    return this.raw.listCommands(authorizationId);
  }

  listAcknowledgements(authorizationId: string): Promise<GateCOfflineAcknowledgement[]> {
    return this.raw.listAcknowledgements(authorizationId);
  }

  listPendingCommands(authorizationId: string): Promise<GateCOfflineQueuedCommand[]> {
    return this.raw.listPendingCommands(authorizationId);
  }

  appendAcknowledgement(acknowledgement: GateCOfflineAcknowledgement): Promise<void> {
    return this.raw.appendAcknowledgement(acknowledgement);
  }

  appendReplayAttempt(attempt: OfflineReplayAttempt): Promise<void> {
    return this.raw.appendReplayAttempt(attempt);
  }

  listReplayAttempts(authorizationId: string): Promise<OfflineReplayAttempt[]> {
    return this.raw.listReplayAttempts(authorizationId);
  }

  appendConflict(conflict: OfflineConflict): Promise<void> {
    return this.raw.appendConflict(conflict);
  }

  listConflicts(authorizationId: string): Promise<OfflineConflict[]> {
    return this.raw.listConflicts(authorizationId);
  }

  recordDiagnosticExport(
    authorizationId: string,
    sha256: string,
    canonicalJson: string,
    recordedAt: string,
  ): Promise<void> {
    return this.raw.recordDiagnosticExport(authorizationId, sha256, canonicalJson, recordedAt);
  }

  acquireReplayLease(
    authorizationId: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<number | null> {
    return this.raw.acquireReplayLease(authorizationId, ownerId, now, ttlMs);
  }

  renewReplayLease(
    authorizationId: string,
    ownerId: string,
    epoch: number,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    return this.raw.renewReplayLease(authorizationId, ownerId, epoch, now, ttlMs);
  }

  releaseReplayLease(authorizationId: string, ownerId: string, epoch: number): Promise<void> {
    return this.raw.releaseReplayLease(authorizationId, ownerId, epoch);
  }

  pruneTerminalQueue(authorizationId: string, now: number): Promise<boolean> {
    return this.raw.pruneTerminalQueue(authorizationId, now);
  }

  discardResolvedAuthorization(authorizationId: string): Promise<void> {
    return this.raw.discardResolvedAuthorization(authorizationId);
  }

  async getReplayState(authorizationId: string): Promise<OfflineReplayState | null> {
    const database = await openOfflineScoringDatabase(this.factory);
    try {
      const value = await requestResult<OfflineReplayState | undefined>(
        database.transaction("replay_state").objectStore("replay_state").get(authorizationId),
      );
      return value ?? null;
    } finally {
      database.close();
    }
  }

  async discardAfterExport(
    authorizationId: string,
    expectedExportSha256: string,
    confirmedSha256: string,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(expectedExportSha256) || expectedExportSha256 !== confirmedSha256) {
      throw new Error("Confirm the exact diagnostic export checksum before discarding offline work.");
    }

    const database = await openOfflineScoringDatabase(this.factory);
    try {
      const storeNames: string[] = [
        "match_packages",
        "commands",
        "acknowledgements",
        "replay_attempts",
        "replay_state",
        "conflicts",
        "meta",
      ];
      const initialTransaction = database.transaction(storeNames, "readonly");
      const snapshot = await readCompleteSnapshot(initialTransaction, authorizationId);
      if (!snapshot.matchPackage || !snapshot.attestation) {
        throw new Error("Offline work changed after export; create and confirm a new diagnostic export.");
      }
      const document = await buildOfflineDiagnosticDocument(
        snapshot.matchPackage,
        snapshot.commands,
        snapshot.acknowledgements,
        snapshot.replayAttempts,
        snapshot.conflicts,
        snapshot.attestation.recorded_at,
        snapshot.replayState ?? null,
      );
      const canonical = canonicalOfflineJson(document);
      if (
        snapshot.attestation.sha256 !== expectedExportSha256 ||
        snapshot.attestation.canonical_json !== canonical
      ) {
        throw new Error("Offline work changed after export; create and confirm a new diagnostic export.");
      }
      const snapshotFingerprint = canonicalOfflineJson(snapshot);

      const deletionTransaction = database.transaction(storeNames, "readwrite");
      const current = await readCompleteSnapshot(deletionTransaction, authorizationId);
      if (canonicalOfflineJson(current) !== snapshotFingerprint) {
        deletionTransaction.abort();
        throw new Error("Offline work changed after export; create and confirm a new diagnostic export.");
      }
      deletionTransaction.objectStore("match_packages").delete(authorizationId);
      deletionTransaction.objectStore("replay_state").delete(authorizationId);
      deletionTransaction.objectStore("meta").delete(`diagnostic_export:${authorizationId}`);
      for (const storeName of ["commands", "acknowledgements", "replay_attempts", "conflicts"] as const) {
        await deleteByAuthorization(deletionTransaction, storeName, authorizationId);
      }
      await transactionResult(deletionTransaction);
    } finally {
      database.close();
    }
  }
}
