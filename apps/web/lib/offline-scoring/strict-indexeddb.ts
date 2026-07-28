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

  saveMatchPackage = this.raw.saveMatchPackage.bind(this.raw);
  transitionMatchPackageStatus = this.raw.transitionMatchPackageStatus.bind(this.raw);
  getMatchPackage = this.raw.getMatchPackage.bind(this.raw);
  getActiveMatchPackage = this.raw.getActiveMatchPackage.bind(this.raw);
  getRecoverableMatchPackage = this.raw.getRecoverableMatchPackage.bind(this.raw);
  enqueue = this.raw.enqueue.bind(this.raw);
  listCommands = this.raw.listCommands.bind(this.raw);
  listAcknowledgements = this.raw.listAcknowledgements.bind(this.raw);
  listPendingCommands = this.raw.listPendingCommands.bind(this.raw);
  appendAcknowledgement = this.raw.appendAcknowledgement.bind(this.raw);
  appendReplayAttempt = this.raw.appendReplayAttempt.bind(this.raw);
  listReplayAttempts = this.raw.listReplayAttempts.bind(this.raw);
  appendConflict = this.raw.appendConflict.bind(this.raw);
  listConflicts = this.raw.listConflicts.bind(this.raw);
  recordDiagnosticExport = this.raw.recordDiagnosticExport.bind(this.raw);
  acquireReplayLease = this.raw.acquireReplayLease.bind(this.raw);
  renewReplayLease = this.raw.renewReplayLease.bind(this.raw);
  releaseReplayLease = this.raw.releaseReplayLease.bind(this.raw);
  pruneTerminalQueue = this.raw.pruneTerminalQueue.bind(this.raw);
  discardResolvedAuthorization = this.raw.discardResolvedAuthorization.bind(this.raw);

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
      const storeNames = [
        "match_packages",
        "commands",
        "acknowledgements",
        "replay_attempts",
        "replay_state",
        "conflicts",
        "meta",
      ] as const;
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
