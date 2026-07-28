"use client";

import {
  gateCOfflineQueueLimit,
  type GateCOfflineAcknowledgement,
  type GateCOfflineMatchPackage,
  type GateCOfflineQueuedCommand,
} from "@matchday/contracts";
import {
  assertOfflineMatchAuthorization,
  assertOfflineQueueIntegrity,
  canTransitionOfflineAuthorizationStatus,
  canonicalOfflineJson,
  offlineRecordingAvailability,
} from "@matchday/domain";
import { buildOfflineDiagnosticDocument } from "./export";
import type { OfflineConflict, OfflineReplayAttempt, OfflineReplayState, OfflineScoringRepository } from "./types";

export const OFFLINE_SCORING_DATABASE_NAME = "matchday-offline-scoring";
export const OFFLINE_SCORING_DATABASE_VERSION = 1;

export const offlineScoringStoreNames = [
  "match_packages",
  "commands",
  "acknowledgements",
  "replay_attempts",
  "replay_state",
  "conflicts",
  "meta",
] as const;

const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

type OfflineStoreName = (typeof offlineScoringStoreNames)[number];

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

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function sha256Digest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains("match_packages")) {
    const packages = database.createObjectStore("match_packages", { keyPath: "authorization_id" });
    packages.createIndex("status", "status");
  }
  if (!database.objectStoreNames.contains("commands")) {
    const commands = database.createObjectStore("commands", {
      keyPath: ["authorization_id", "local_sequence"],
    });
    commands.createIndex("authorization_id", "authorization_id");
    commands.createIndex("authorization_client_event", ["authorization_id", "command.client_event_id"], {
      unique: true,
    });
  }
  if (!database.objectStoreNames.contains("acknowledgements")) {
    const acknowledgements = database.createObjectStore("acknowledgements", {
      keyPath: ["authorization_id", "local_sequence"],
    });
    acknowledgements.createIndex("authorization_id", "authorization_id");
    acknowledgements.createIndex("authorization_client_event", ["authorization_id", "client_event_id"], {
      unique: true,
    });
  }
  if (!database.objectStoreNames.contains("replay_attempts")) {
    const attempts = database.createObjectStore("replay_attempts", { keyPath: "id", autoIncrement: true });
    attempts.createIndex("authorization_id", "authorization_id");
  }
  if (!database.objectStoreNames.contains("replay_state")) {
    database.createObjectStore("replay_state", { keyPath: "authorization_id" });
  }
  if (!database.objectStoreNames.contains("conflicts")) {
    const conflicts = database.createObjectStore("conflicts", { keyPath: "id", autoIncrement: true });
    conflicts.createIndex("authorization_id", "authorization_id");
  }
  if (!database.objectStoreNames.contains("meta")) {
    database.createObjectStore("meta", { keyPath: "key" });
  }
}

export function openOfflineScoringDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(OFFLINE_SCORING_DATABASE_NAME, OFFLINE_SCORING_DATABASE_VERSION);
    request.onupgradeneeded = () => createStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline scoring storage is unavailable."));
    request.onblocked = () => reject(new Error("Offline scoring storage upgrade is blocked by another tab."));
  });
}

function authorizationRange(authorizationId: string): IDBValidKey {
  return authorizationId;
}

async function indexedValues<T>(
  database: IDBDatabase,
  storeName: OfflineStoreName,
  authorizationId: string,
): Promise<T[]> {
  const transaction = database.transaction(storeName);
  const result = await requestResult(
    transaction.objectStore(storeName).index("authorization_id").getAll(authorizationRange(authorizationId)),
  );
  return result as T[];
}

export class IndexedDbOfflineScoringRepository implements OfflineScoringRepository {
  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private async withDatabase<T>(action: (database: IDBDatabase) => Promise<T>): Promise<T> {
    const database = await openOfflineScoringDatabase(this.factory);
    try {
      return await action(database);
    } finally {
      database.close();
    }
  }

  async saveMatchPackage(matchPackage: GateCOfflineMatchPackage): Promise<void> {
    assertOfflineMatchAuthorization(matchPackage);
    await this.withDatabase(async (database) => {
      const transaction = database.transaction(
        ["match_packages", "commands", "acknowledgements", "conflicts", "meta"],
        "readwrite",
      );
      const packages = transaction.objectStore("match_packages");
      const existingPackages = await requestResult<GateCOfflineMatchPackage[]>(packages.getAll());
      const sameAuthorization = existingPackages.find(
        (existing) => existing.authorization_id === matchPackage.authorization_id,
      );
      if (
        sameAuthorization &&
        (sameAuthorization.competition_id !== matchPackage.competition_id ||
          sameAuthorization.match_id !== matchPackage.match_id ||
          sameAuthorization.writer_generation !== matchPackage.writer_generation ||
          sameAuthorization.sport_code !== matchPackage.sport_code ||
          sameAuthorization.sport_pack_version !== matchPackage.sport_pack_version)
      ) {
        transaction.abort();
        throw new Error("Offline authorization identity and writer generation are immutable.");
      }
      if (
        sameAuthorization &&
        !canTransitionOfflineAuthorizationStatus(sameAuthorization.status, matchPackage.status)
      ) {
        transaction.abort();
        throw new Error("Offline authorization cannot return to an earlier lifecycle state.");
      }
      for (const existing of existingPackages) {
        if (existing.authorization_id === matchPackage.authorization_id || existing.status !== "active") continue;
        const [commands, acknowledgements, conflicts] = await Promise.all([
          requestResult<GateCOfflineQueuedCommand[]>(
            transaction.objectStore("commands").index("authorization_id").getAll(existing.authorization_id),
          ),
          requestResult<GateCOfflineAcknowledgement[]>(
            transaction.objectStore("acknowledgements").index("authorization_id").getAll(existing.authorization_id),
          ),
          requestResult<OfflineConflict[]>(
            transaction.objectStore("conflicts").index("authorization_id").getAll(existing.authorization_id),
          ),
        ]);
        if (commands.length > acknowledgements.length || conflicts.some((conflict) => !conflict.acknowledged_at)) {
          transaction.abort();
          throw new Error("Resolve or export the existing offline match before authorising another match.");
        }
      }

      for (const existing of existingPackages) {
        if (existing.authorization_id !== matchPackage.authorization_id && existing.status === "active") {
          packages.put({ ...existing, status: "completed" });
        }
      }
      packages.put(
        clone(
          sameAuthorization
            ? {
                ...matchPackage,
                last_acknowledged_sequence: sameAuthorization.last_acknowledged_sequence,
                last_acknowledged_aggregate_version: sameAuthorization.last_acknowledged_aggregate_version,
              }
            : matchPackage,
        ),
      );
      transaction.objectStore("meta").put({ key: "schema_version", value: OFFLINE_SCORING_DATABASE_VERSION });
      await transactionResult(transaction);
    });
  }

  async getMatchPackage(authorizationId: string): Promise<GateCOfflineMatchPackage | null> {
    return this.withDatabase(async (database) => {
      const value = await requestResult<GateCOfflineMatchPackage | undefined>(
        database.transaction("match_packages").objectStore("match_packages").get(authorizationId),
      );
      if (!value) return null;
      assertOfflineMatchAuthorization(value);
      return clone(value);
    });
  }

  async transitionMatchPackageStatus(
    authorizationId: string,
    status: Exclude<GateCOfflineMatchPackage["status"], "active">,
  ): Promise<void> {
    await this.withDatabase(async (database) => {
      const transaction = database.transaction("match_packages", "readwrite");
      const store = transaction.objectStore("match_packages");
      const current = await requestResult<GateCOfflineMatchPackage | undefined>(store.get(authorizationId));
      if (!current) {
        transaction.abort();
        throw new Error("Offline match authorization is unavailable.");
      }
      assertOfflineMatchAuthorization(current);
      if (!canTransitionOfflineAuthorizationStatus(current.status, status)) {
        transaction.abort();
        throw new Error("Offline authorization cannot return to an earlier lifecycle state.");
      }
      if (current.status !== status) store.put({ ...current, status });
      await transactionResult(transaction);
    });
  }

  async getActiveMatchPackage(): Promise<GateCOfflineMatchPackage | null> {
    return this.withDatabase(async (database) => {
      const values = await requestResult<GateCOfflineMatchPackage[]>(
        database.transaction("match_packages").objectStore("match_packages").index("status").getAll("active"),
      );
      if (values.length > 1) throw new Error("Offline scoring storage contains multiple active grants.");
      if (!values[0]) return null;
      assertOfflineMatchAuthorization(values[0]);
      return clone(values[0]);
    });
  }

  async getRecoverableMatchPackage(): Promise<GateCOfflineMatchPackage | null> {
    return this.withDatabase(async (database) => {
      const transaction = database.transaction(["match_packages", "commands", "acknowledgements", "conflicts"]);
      const packages = await requestResult<GateCOfflineMatchPackage[]>(
        transaction.objectStore("match_packages").getAll(),
      );
      const active = packages.filter(({ status }) => status === "active");
      if (active.length > 1) throw new Error("Offline scoring storage contains multiple active grants.");
      if (active[0]) {
        assertOfflineMatchAuthorization(active[0]);
        return clone(active[0]);
      }

      const recoverable: GateCOfflineMatchPackage[] = [];
      for (const matchPackage of packages) {
        const [commands, acknowledgements, conflicts] = await Promise.all([
          requestResult<GateCOfflineQueuedCommand[]>(
            transaction.objectStore("commands").index("authorization_id").getAll(matchPackage.authorization_id),
          ),
          requestResult<GateCOfflineAcknowledgement[]>(
            transaction.objectStore("acknowledgements").index("authorization_id").getAll(matchPackage.authorization_id),
          ),
          requestResult<OfflineConflict[]>(
            transaction.objectStore("conflicts").index("authorization_id").getAll(matchPackage.authorization_id),
          ),
        ]);
        if (commands.length > acknowledgements.length || conflicts.some((conflict) => !conflict.acknowledged_at)) {
          assertOfflineMatchAuthorization(matchPackage);
          recoverable.push(matchPackage);
        }
      }
      if (recoverable.length > 1) {
        throw new Error("Offline scoring storage contains multiple terminal queues requiring review.");
      }
      return recoverable[0] ? clone(recoverable[0]) : null;
    });
  }

  async enqueue(command: GateCOfflineQueuedCommand, now: number = Date.now()): Promise<void> {
    await this.withDatabase(async (database) => {
      const transaction = database.transaction(["match_packages", "commands", "acknowledgements"], "readwrite");
      const packageValue = await requestResult<GateCOfflineMatchPackage | undefined>(
        transaction.objectStore("match_packages").get(command.authorization_id),
      );
      if (!packageValue) {
        transaction.abort();
        throw new Error("Offline match authorization is unavailable.");
      }
      const commands = (await requestResult(
        transaction.objectStore("commands").index("authorization_id").getAll(command.authorization_id),
      )) as GateCOfflineQueuedCommand[];
      const acknowledgements = (await requestResult(
        transaction.objectStore("acknowledgements").index("authorization_id").getAll(command.authorization_id),
      )) as GateCOfflineAcknowledgement[];
      assertOfflineQueueIntegrity(packageValue, commands, acknowledgements);
      const pendingCommandCount = commands.length - acknowledgements.length;
      const availability = offlineRecordingAvailability(packageValue, pendingCommandCount, now);
      if (availability !== "available" && availability !== "queue_warning") {
        transaction.abort();
        throw new Error(`Offline scoring cannot accept another command: ${availability}.`);
      }
      if (pendingCommandCount >= gateCOfflineQueueLimit) {
        transaction.abort();
        throw new Error("Offline scoring command limit reached.");
      }
      const expectedLocalSequence = commands.length + 1;
      if (command.local_sequence !== expectedLocalSequence) {
        transaction.abort();
        throw new Error(`Offline local sequence must be ${expectedLocalSequence}.`);
      }
      assertOfflineQueueIntegrity(packageValue, [...commands, command], acknowledgements);
      transaction.objectStore("commands").add(clone(command));
      await transactionResult(transaction);
    });
  }

  async listCommands(authorizationId: string): Promise<GateCOfflineQueuedCommand[]> {
    return this.withDatabase(async (database) => {
      const values = await indexedValues<GateCOfflineQueuedCommand>(database, "commands", authorizationId);
      return values.sort((left, right) => left.local_sequence - right.local_sequence).map(clone);
    });
  }

  async listAcknowledgements(authorizationId: string): Promise<GateCOfflineAcknowledgement[]> {
    return this.withDatabase(async (database) => {
      const values = await indexedValues<GateCOfflineAcknowledgement>(database, "acknowledgements", authorizationId);
      return values.sort((left, right) => left.local_sequence - right.local_sequence).map(clone);
    });
  }

  async listPendingCommands(authorizationId: string): Promise<GateCOfflineQueuedCommand[]> {
    const [commands, acknowledgements] = await Promise.all([
      this.listCommands(authorizationId),
      this.listAcknowledgements(authorizationId),
    ]);
    const acknowledged = new Set(acknowledgements.map(({ local_sequence }) => local_sequence));
    return commands.filter(({ local_sequence }) => !acknowledged.has(local_sequence));
  }

  async appendAcknowledgement(acknowledgement: GateCOfflineAcknowledgement): Promise<void> {
    await this.withDatabase(async (database) => {
      const transaction = database.transaction(["match_packages", "commands", "acknowledgements"], "readwrite");
      const key: IDBValidKey = [acknowledgement.authorization_id, acknowledgement.local_sequence];
      const command = await requestResult<GateCOfflineQueuedCommand | undefined>(
        transaction.objectStore("commands").get(key),
      );
      const matchPackage = await requestResult<GateCOfflineMatchPackage | undefined>(
        transaction.objectStore("match_packages").get(acknowledgement.authorization_id),
      );
      const store = transaction.objectStore("acknowledgements");
      const existing = await requestResult<GateCOfflineAcknowledgement | undefined>(store.get(key));
      if (existing) {
        if (canonicalOfflineJson(existing) !== canonicalOfflineJson(acknowledgement)) {
          transaction.abort();
          throw new Error("Offline acknowledgement is immutable.");
        }
        await transactionResult(transaction);
        return;
      }
      if (
        !command ||
        !matchPackage ||
        command.match_id !== acknowledgement.match_id ||
        command.command.client_event_id !== acknowledgement.client_event_id ||
        !/^[a-f0-9]{64}$/.test(acknowledgement.command_fingerprint) ||
        acknowledgement.sequence !== command.command.expected_sequence + 1 ||
        !Number.isSafeInteger(acknowledgement.aggregate_version) ||
        acknowledgement.aggregate_version !== acknowledgement.sequence ||
        !Number.isFinite(Date.parse(acknowledgement.server_received_at)) ||
        !Number.isFinite(Date.parse(acknowledgement.acknowledged_at)) ||
        (command.command.kind === "event" && !acknowledgement.event_id) ||
        (command.command.kind === "finalisation" &&
          (!Number.isSafeInteger(acknowledgement.result_version) ||
            !Number.isSafeInteger(acknowledgement.publication_version)))
      ) {
        transaction.abort();
        throw new Error("Offline acknowledgement does not match the queued command.");
      }
      const existingAcknowledgements = (await requestResult(
        store.index("authorization_id").getAll(acknowledgement.authorization_id),
      )) as GateCOfflineAcknowledgement[];
      if (acknowledgement.local_sequence !== existingAcknowledgements.length + 1) {
        transaction.abort();
        throw new Error("Offline acknowledgements must be recorded in queue order.");
      }
      store.add(clone(acknowledgement));
      transaction.objectStore("match_packages").put({
        ...matchPackage,
        last_acknowledged_sequence: Math.max(matchPackage.last_acknowledged_sequence, acknowledgement.sequence),
        last_acknowledged_aggregate_version: Math.max(
          matchPackage.last_acknowledged_aggregate_version,
          acknowledgement.aggregate_version,
        ),
      });
      await transactionResult(transaction);
    });
  }

  async appendReplayAttempt(attempt: OfflineReplayAttempt): Promise<void> {
    await this.appendAutoIncrement("replay_attempts", attempt);
  }

  async listReplayAttempts(authorizationId: string): Promise<OfflineReplayAttempt[]> {
    return this.withDatabase((database) =>
      indexedValues<OfflineReplayAttempt>(database, "replay_attempts", authorizationId),
    );
  }

  async appendConflict(conflict: OfflineConflict): Promise<void> {
    await this.appendAutoIncrement("conflicts", conflict);
  }

  async listConflicts(authorizationId: string): Promise<OfflineConflict[]> {
    return this.withDatabase((database) => indexedValues<OfflineConflict>(database, "conflicts", authorizationId));
  }

  async recordDiagnosticExport(
    authorizationId: string,
    sha256: string,
    canonicalJson: string,
    recordedAt: string,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(sha256) || (await sha256Digest(canonicalJson)) !== sha256) {
      throw new Error("Diagnostic export checksum is invalid.");
    }
    await this.withDatabase(async (database) => {
      const transaction = database.transaction("meta", "readwrite");
      transaction.objectStore("meta").put({
        key: `diagnostic_export:${authorizationId}`,
        authorization_id: authorizationId,
        sha256,
        canonical_json: canonicalJson,
        recorded_at: recordedAt,
      });
      await transactionResult(transaction);
    });
  }

  private async appendAutoIncrement(
    storeName: "replay_attempts" | "conflicts",
    value: OfflineReplayAttempt | OfflineConflict,
  ): Promise<void> {
    await this.withDatabase(async (database) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).add(clone(value));
      await transactionResult(transaction);
    });
  }

  async acquireReplayLease(
    authorizationId: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<number | null> {
    return this.withDatabase(async (database) => {
      const transaction = database.transaction("replay_state", "readwrite");
      const store = transaction.objectStore("replay_state");
      const current = await requestResult<OfflineReplayState | undefined>(store.get(authorizationId));
      if (current && current.owner_id !== ownerId && Date.parse(current.lease_expires_at) > now) {
        transaction.abort();
        return null;
      }
      const epoch = (current?.epoch ?? 0) + 1;
      store.put({
        authorization_id: authorizationId,
        owner_id: ownerId,
        epoch,
        lease_expires_at: new Date(now + ttlMs).toISOString(),
        updated_at: new Date(now).toISOString(),
      } satisfies OfflineReplayState);
      await transactionResult(transaction);
      return epoch;
    });
  }

  async renewReplayLease(
    authorizationId: string,
    ownerId: string,
    epoch: number,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    return this.withDatabase(async (database) => {
      const transaction = database.transaction("replay_state", "readwrite");
      const store = transaction.objectStore("replay_state");
      const current = await requestResult<OfflineReplayState | undefined>(store.get(authorizationId));
      if (!current || current.owner_id !== ownerId || current.epoch !== epoch) {
        transaction.abort();
        return false;
      }
      store.put({
        ...current,
        lease_expires_at: new Date(now + ttlMs).toISOString(),
        updated_at: new Date(now).toISOString(),
      });
      await transactionResult(transaction);
      return true;
    });
  }

  async releaseReplayLease(authorizationId: string, ownerId: string, epoch: number): Promise<void> {
    await this.withDatabase(async (database) => {
      const transaction = database.transaction("replay_state", "readwrite");
      const store = transaction.objectStore("replay_state");
      const current = await requestResult<OfflineReplayState | undefined>(store.get(authorizationId));
      if (current?.owner_id === ownerId && current.epoch === epoch) store.delete(authorizationId);
      await transactionResult(transaction);
    });
  }

  async pruneTerminalQueue(authorizationId: string, now: number): Promise<boolean> {
    return this.withDatabase(async (database) => {
      const matchPackage = await requestResult<GateCOfflineMatchPackage | undefined>(
        database.transaction("match_packages").objectStore("match_packages").get(authorizationId),
      );
      if (
        !matchPackage ||
        matchPackage.status !== "completed" ||
        now < Date.parse(matchPackage.replay_expires_at) + TERMINAL_RETENTION_MS
      ) {
        return false;
      }
      const pending = await this.listPendingCommands(authorizationId);
      const conflicts = await this.listConflicts(authorizationId);
      if (pending.length > 0 || conflicts.some((conflict) => !conflict.acknowledged_at)) return false;
      await this.deleteAuthorizationData(database, authorizationId);
      return true;
    });
  }

  async discardAfterExport(
    authorizationId: string,
    expectedExportSha256: string,
    confirmedSha256: string,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(expectedExportSha256) || expectedExportSha256 !== confirmedSha256) {
      throw new Error("Confirm the exact diagnostic export checksum before discarding offline work.");
    }
    const snapshot = await this.withDatabase(async (database) => {
      const transaction = database.transaction(
        ["match_packages", "commands", "acknowledgements", "conflicts", "meta"],
        "readonly",
      );
      const values = await Promise.all([
        requestResult<GateCOfflineMatchPackage | undefined>(
          transaction.objectStore("match_packages").get(authorizationId),
        ),
        requestResult<GateCOfflineQueuedCommand[]>(
          transaction.objectStore("commands").index("authorization_id").getAll(authorizationId),
        ),
        requestResult<GateCOfflineAcknowledgement[]>(
          transaction.objectStore("acknowledgements").index("authorization_id").getAll(authorizationId),
        ),
        requestResult<OfflineConflict[]>(
          transaction.objectStore("conflicts").index("authorization_id").getAll(authorizationId),
        ),
        requestResult<
          | {
              sha256: string;
              canonical_json: string;
              recorded_at: string;
            }
          | undefined
        >(transaction.objectStore("meta").get(`diagnostic_export:${authorizationId}`)),
      ]);
      return {
        matchPackage: values[0],
        commands: values[1],
        acknowledgements: values[2],
        conflicts: values[3],
        attestation: values[4],
      };
    });
    const currentCanonicalJson =
      snapshot.matchPackage && snapshot.attestation
        ? canonicalOfflineJson(
            await buildOfflineDiagnosticDocument(
              snapshot.matchPackage,
              snapshot.commands,
              snapshot.acknowledgements,
              snapshot.conflicts,
              snapshot.attestation.recorded_at,
            ),
          )
        : null;
    if (
      !snapshot.attestation ||
      snapshot.attestation.sha256 !== expectedExportSha256 ||
      snapshot.attestation.canonical_json !== currentCanonicalJson
    ) {
      throw new Error("Offline work changed after export; create and confirm a new diagnostic export.");
    }
    const rawSnapshot = canonicalOfflineJson(snapshot);

    await this.withDatabase(async (database) => {
      const transaction = database.transaction(
        ["match_packages", "commands", "acknowledgements", "replay_attempts", "replay_state", "conflicts", "meta"],
        "readwrite",
      );
      const current = await Promise.all([
        requestResult<GateCOfflineMatchPackage | undefined>(
          transaction.objectStore("match_packages").get(authorizationId),
        ),
        requestResult<GateCOfflineQueuedCommand[]>(
          transaction.objectStore("commands").index("authorization_id").getAll(authorizationId),
        ),
        requestResult<GateCOfflineAcknowledgement[]>(
          transaction.objectStore("acknowledgements").index("authorization_id").getAll(authorizationId),
        ),
        requestResult<OfflineConflict[]>(
          transaction.objectStore("conflicts").index("authorization_id").getAll(authorizationId),
        ),
        requestResult(transaction.objectStore("meta").get(`diagnostic_export:${authorizationId}`)),
      ]);
      const currentRawSnapshot = canonicalOfflineJson({
        matchPackage: current[0],
        commands: current[1],
        acknowledgements: current[2],
        conflicts: current[3],
        attestation: current[4],
      });
      if (currentRawSnapshot !== rawSnapshot) {
        transaction.abort();
        throw new Error("Offline work changed after export; create and confirm a new diagnostic export.");
      }
      await this.deleteAuthorizationDataInTransaction(transaction, authorizationId);
      await transactionResult(transaction);
    });
  }

  async discardResolvedAuthorization(authorizationId: string): Promise<void> {
    await this.withDatabase(async (database) => {
      const transaction = database.transaction(
        ["match_packages", "commands", "acknowledgements", "replay_attempts", "replay_state", "conflicts", "meta"],
        "readwrite",
      );
      const [matchPackage, commands, acknowledgements, conflicts] = await Promise.all([
        requestResult<GateCOfflineMatchPackage | undefined>(
          transaction.objectStore("match_packages").get(authorizationId),
        ),
        requestResult<GateCOfflineQueuedCommand[]>(
          transaction.objectStore("commands").index("authorization_id").getAll(authorizationId),
        ),
        requestResult<GateCOfflineAcknowledgement[]>(
          transaction.objectStore("acknowledgements").index("authorization_id").getAll(authorizationId),
        ),
        requestResult<OfflineConflict[]>(
          transaction.objectStore("conflicts").index("authorization_id").getAll(authorizationId),
        ),
      ]);
      if (!matchPackage) {
        return;
      }
      assertOfflineQueueIntegrity(matchPackage, commands, acknowledgements);
      if (commands.length !== acknowledgements.length || conflicts.some((conflict) => !conflict.acknowledged_at)) {
        transaction.abort();
        throw new Error("Unresolved offline work requires an exported diagnostic before discard.");
      }
      await this.deleteAuthorizationDataInTransaction(transaction, authorizationId);
      await transactionResult(transaction);
    });
  }

  private async deleteAuthorizationData(database: IDBDatabase, authorizationId: string): Promise<void> {
    const transaction = database.transaction(
      ["match_packages", "commands", "acknowledgements", "replay_attempts", "replay_state", "conflicts", "meta"],
      "readwrite",
    );
    await this.deleteAuthorizationDataInTransaction(transaction, authorizationId);
    await transactionResult(transaction);
  }

  private async deleteAuthorizationDataInTransaction(
    transaction: IDBTransaction,
    authorizationId: string,
  ): Promise<void> {
    transaction.objectStore("match_packages").delete(authorizationId);
    transaction.objectStore("replay_state").delete(authorizationId);
    transaction.objectStore("meta").delete(`diagnostic_export:${authorizationId}`);
    for (const storeName of ["commands", "acknowledgements", "replay_attempts", "conflicts"] as const) {
      const index = transaction.objectStore(storeName).index("authorization_id");
      await new Promise<void>((resolve, reject) => {
        const cursorRequest = index.openKeyCursor(authorizationRange(authorizationId));
        cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("Offline data cleanup failed."));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return resolve();
          transaction.objectStore(storeName).delete(cursor.primaryKey);
          cursor.continue();
        };
      });
    }
  }
}
