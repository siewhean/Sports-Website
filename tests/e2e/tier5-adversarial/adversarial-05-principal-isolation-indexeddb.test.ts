import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbOfflineScoringRepository,
  TERMINAL_RETENTION_MS,
} from "../../../apps/web/lib/offline-scoring/indexeddb";
import { createOfflineDiagnosticExport } from "../../../apps/web/lib/offline-scoring/export";
import { OfflineReplayFenceError } from "../../../apps/web/lib/offline-scoring/types";
import { createValidOfflineAuthorization, createValidOfflineEventCommand, TEST_UUIDS } from "../helpers/fixtures";
import type { GateCOfflineMatchPackage } from "@matchday/contracts";

const PRINCIPAL_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRINCIPAL_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Tier 5 Adversarial - Subsystem 5: Principal Isolation & Storage Security Hardening", () => {
  let factory: IDBFactory;
  let repo: IndexedDbOfflineScoringRepository;

  beforeEach(() => {
    factory = new IDBFactory();
    repo = new IndexedDbOfflineScoringRepository(factory);
  });

  describe("1. Cross-Principal Data Isolation & Switch Fences", () => {
    it("ADV-ISO-01: prevents Principal B from accessing Principal A's match packages or queued commands", async () => {
      // 1. Principal A binds and saves active match package
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkgA: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkgA);

      const cmd1 = {
        authorization_id: TEST_UUIDS.authorizationId,
        match_id: TEST_UUIDS.matchId1,
        writer_generation: 1,
        local_sequence: 1,
        command: createValidOfflineEventCommand(0, TEST_UUIDS.clientEventId1),
        enqueued_at: new Date().toISOString(),
      };
      await repo.enqueue(cmd1);

      // Verify Principal A can read package and commands
      const retrievedA = await repo.getMatchPackage(TEST_UUIDS.authorizationId);
      expect(retrievedA?.authorization_id).toBe(TEST_UUIDS.authorizationId);
      const cmdsA = await repo.listCommands(TEST_UUIDS.authorizationId);
      expect(cmdsA).toHaveLength(1);

      // 2. Principal B logs in and binds
      await repo.bindPrincipal(PRINCIPAL_B);

      // Verify Principal B gets zero data
      const retrievedB = await repo.getMatchPackage(TEST_UUIDS.authorizationId);
      expect(retrievedB).toBeNull();

      const activeB = await repo.getActiveMatchPackage();
      expect(activeB).toBeNull();

      const recoverableB = await repo.getRecoverableMatchPackage();
      expect(recoverableB).toBeNull();

      await expect(repo.listCommands(TEST_UUIDS.authorizationId)).rejects.toThrow(
        "Offline match authorization is unavailable.",
      );
      await expect(repo.listAcknowledgements(TEST_UUIDS.authorizationId)).rejects.toThrow(
        "Offline match authorization is unavailable.",
      );

      // 3. Switch back to Principal A -> All data is restored
      await repo.bindPrincipal(PRINCIPAL_A);
      const restoredA = await repo.getMatchPackage(TEST_UUIDS.authorizationId);
      expect(restoredA?.authorization_id).toBe(TEST_UUIDS.authorizationId);
      const restoredCmdsA = await repo.listCommands(TEST_UUIDS.authorizationId);
      expect(restoredCmdsA).toHaveLength(1);
    });

    it("ADV-ISO-02: blocks saving a new match package for Principal B when Principal A has unresolved offline work", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkgA: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkgA);

      // Attempt to save a match package for Principal B
      const pkgB: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: "55555555-5555-4555-8555-555555555555",
        principal_id: PRINCIPAL_B,
      });

      await expect(repo.saveMatchPackage(pkgB)).rejects.toThrow(
        "Resolve or export the existing principal's offline match before switching scoring access.",
      );
    });

    it("ADV-ISO-03: rejects binding an invalid principal identifier (non-64-hex string)", async () => {
      await expect(repo.bindPrincipal("invalid-principal-id-not-64-hex")).rejects.toThrow(
        "Offline scoring principal is invalid.",
      );
      await expect(repo.bindPrincipal("")).rejects.toThrow("Offline scoring principal is invalid.");
      await expect(repo.bindPrincipal("G".repeat(64))).rejects.toThrow("Offline scoring principal is invalid.");
    });
  });

  describe("2. Unacknowledged Conflict & Pending Command Protection", () => {
    it("ADV-ISO-04: blocks discard of authorization while pending unacknowledged commands exist", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkg: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkg);

      const cmd1 = {
        authorization_id: TEST_UUIDS.authorizationId,
        match_id: TEST_UUIDS.matchId1,
        writer_generation: 1,
        local_sequence: 1,
        command: createValidOfflineEventCommand(0, TEST_UUIDS.clientEventId1),
        enqueued_at: new Date().toISOString(),
      };
      await repo.enqueue(cmd1);

      // Attempting to discard without acknowledgement or diagnostic export
      await expect(repo.discardResolvedAuthorization(TEST_UUIDS.authorizationId)).rejects.toThrow(
        "Unresolved offline work requires an exported diagnostic before discard.",
      );
    });

    it("ADV-ISO-05: blocks discard of authorization while unacknowledged conflicts exist", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkg: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkg);

      // Append an unresolved conflict (acknowledged_at is undefined)
      await repo.appendConflict({
        authorization_id: TEST_UUIDS.authorizationId,
        match_id: TEST_UUIDS.matchId1,
        local_sequence: 1,
        client_event_id: TEST_UUIDS.clientEventId1,
        code: "invalid_sequence",
        writer_generation: 1,
        recorded_at: new Date().toISOString(),
        acknowledged_at: undefined,
      });

      await expect(repo.discardResolvedAuthorization(TEST_UUIDS.authorizationId)).rejects.toThrow(
        "Unresolved offline work requires an exported diagnostic before discard.",
      );
    });

    it("ADV-ISO-06: blocks saving second match package when first package has unacknowledged conflicts", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkg1: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkg1);

      await repo.appendConflict({
        authorization_id: TEST_UUIDS.authorizationId,
        match_id: TEST_UUIDS.matchId1,
        local_sequence: 1,
        client_event_id: TEST_UUIDS.clientEventId1,
        code: "generation_stale",
        writer_generation: 1,
        recorded_at: new Date().toISOString(),
        acknowledged_at: undefined,
      });

      const pkg2: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: "66666666-6666-4666-8666-666666666666",
        match_id: TEST_UUIDS.matchId2,
        principal_id: PRINCIPAL_A,
      });

      await expect(repo.saveMatchPackage(pkg2)).rejects.toThrow(
        "Resolve or export the existing offline match before authorising another match.",
      );
    });

    it("ADV-ISO-07: pruneTerminalQueue refuses to purge package if pending commands or unacknowledged conflicts exist", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const now = Date.now();
      const basePast = now - 100 * 3600_000;

      const pkg: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
        status: "active",
        authorized_at: new Date(basePast - 3.5 * 3600_000).toISOString(),
        recording_expires_at: new Date(basePast).toISOString(),
        replay_expires_at: new Date(basePast + 10 * 60_000).toISOString(),
        pass_expires_at: new Date(basePast + 8 * 3600_000).toISOString(),
      });
      await repo.saveMatchPackage(pkg);

      const cmd1 = {
        authorization_id: TEST_UUIDS.authorizationId,
        match_id: TEST_UUIDS.matchId1,
        writer_generation: 1,
        local_sequence: 1,
        command: createValidOfflineEventCommand(0, TEST_UUIDS.clientEventId1),
        enqueued_at: new Date(basePast - 1000).toISOString(),
      };
      await repo.enqueue(cmd1, basePast - 1000);

      // Transition to completed
      await repo.transitionMatchPackageStatus(TEST_UUIDS.authorizationId, "completed");

      // prune attempt should return false because 1 command is pending acknowledgement!
      const pruned = await repo.pruneTerminalQueue(TEST_UUIDS.authorizationId, now);
      expect(pruned).toBe(false);

      // Verify package still exists
      const remainingPkg = await repo.getMatchPackage(TEST_UUIDS.authorizationId);
      expect(remainingPkg).not.toBeNull();
    });
  });

  describe("3. Diagnostic Export Attestation & Tamper Fencing", () => {
    it("ADV-ISO-08: rejects discardAfterExport when confirmed checksum does not match expected export", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkg: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkg);

      const exportReceipt = await createOfflineDiagnosticExport(repo, TEST_UUIDS.authorizationId);

      // Wrong confirmed SHA
      const wrongSha = "0".repeat(64);
      await expect(repo.discardAfterExport(TEST_UUIDS.authorizationId, exportReceipt.sha256, wrongSha)).rejects.toThrow(
        "Confirm the exact diagnostic export checksum before discarding offline work.",
      );
    });

    it("ADV-ISO-09: detects data mutation after export and blocks discardAfterExport", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkg: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkg);

      const exportReceipt = await createOfflineDiagnosticExport(repo, TEST_UUIDS.authorizationId);

      // Post-export mutation: enqueuing a new command after export was recorded!
      const newCmd = {
        authorization_id: TEST_UUIDS.authorizationId,
        match_id: TEST_UUIDS.matchId1,
        writer_generation: 1,
        local_sequence: 1,
        command: createValidOfflineEventCommand(0, TEST_UUIDS.clientEventId1),
        enqueued_at: new Date().toISOString(),
      };
      await repo.enqueue(newCmd);

      // discardAfterExport must detect that snapshot integrity digest changed!
      await expect(
        repo.discardAfterExport(TEST_UUIDS.authorizationId, exportReceipt.sha256, exportReceipt.sha256),
      ).rejects.toThrow("Offline work changed after export; create and confirm a new diagnostic export.");
    });

    it("ADV-ISO-10: cleanly purges all 7 object stores after valid confirmed export", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkg: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkg);

      const exportReceipt = await createOfflineDiagnosticExport(repo, TEST_UUIDS.authorizationId);

      await repo.discardAfterExport(TEST_UUIDS.authorizationId, exportReceipt.sha256, exportReceipt.sha256);

      // Package and diagnostic export meta are completely removed
      const remainingPkg = await repo.getMatchPackage(TEST_UUIDS.authorizationId);
      expect(remainingPkg).toBeNull();
      const remainingCmds = await repo.listCommands(TEST_UUIDS.authorizationId).catch(() => null);
      expect(remainingCmds).toBeNull();
    });
  });

  describe("4. Replay Fence & Lease Concurrency", () => {
    it("ADV-ISO-11: acquireReplayLease blocks competing owner while unexpired lease is held", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkg: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkg);

      const now = Date.now();
      const owner1 = "worker-owner-1";
      const owner2 = "worker-owner-2";

      // Owner 1 acquires lease for 10 seconds
      const epoch1 = await repo.acquireReplayLease(TEST_UUIDS.authorizationId, owner1, now, 10_000);
      expect(epoch1).toBe(1);

      // Owner 2 tries to acquire immediately -> blocked (returns null)
      const epoch2 = await repo.acquireReplayLease(TEST_UUIDS.authorizationId, owner2, now + 1000, 10_000);
      expect(epoch2).toBeNull();

      // Owner 1 renews lease -> succeeds
      const renewed = await repo.renewReplayLease(TEST_UUIDS.authorizationId, owner1, 1, now + 2000, 10_000);
      expect(renewed).toBe(true);

      // Owner 1 attempts renewal with stale epoch 0 -> fails
      const staleRenewed = await repo.renewReplayLease(TEST_UUIDS.authorizationId, owner1, 0, now + 2000, 10_000);
      expect(staleRenewed).toBe(false);

      // Owner 1 releases lease
      await repo.releaseReplayLease(TEST_UUIDS.authorizationId, owner1, 1);

      // Owner 2 can now acquire lease
      const epoch2AfterRelease = await repo.acquireReplayLease(TEST_UUIDS.authorizationId, owner2, now + 3000, 10_000);
      expect(epoch2AfterRelease).toBe(1);
    });

    it("ADV-ISO-12: rejects operations with stale replay fence or on principal change", async () => {
      await repo.bindPrincipal(PRINCIPAL_A);
      const pkg: GateCOfflineMatchPackage = createValidOfflineAuthorization({
        authorization_id: TEST_UUIDS.authorizationId,
        principal_id: PRINCIPAL_A,
      });
      await repo.saveMatchPackage(pkg);

      const now = Date.now();
      const owner1 = "worker-owner-1";
      await repo.acquireReplayLease(TEST_UUIDS.authorizationId, owner1, now, 10_000);

      // Attempting status transition with stale epoch (epoch 999 instead of 1)
      await expect(
        repo.transitionMatchPackageStatus(TEST_UUIDS.authorizationId, "completed", {
          owner_id: owner1,
          epoch: 999,
        }),
      ).rejects.toThrow(OfflineReplayFenceError);

      // Switch principal and attempt operation with previous fence -> throws principal changed error
      await repo.bindPrincipal(PRINCIPAL_B);
      await expect(
        repo.transitionMatchPackageStatus(TEST_UUIDS.authorizationId, "completed", {
          owner_id: owner1,
          epoch: 1,
        }),
      ).rejects.toThrow(OfflineReplayFenceError);
    });
  });
});
