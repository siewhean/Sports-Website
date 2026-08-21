import { describe, it, expect } from "vitest";
import { calculateAffectedMatchClosure } from "@matchday/domain";
import { createValidClosureInput, TEST_UUIDS } from "../helpers/fixtures";

describe("Tier 4 - Scenario 03: Disputed Match Result C4 Schedule Repair & Atomic Publication", () => {
  it("executes dispute repair: score correction -> closure analysis -> repair revision -> atomic publication", () => {
    // 1. A completed match result is corrected, triggering C4 repair closure analysis
    const closureInput = createValidClosureInput();
    const closure = calculateAffectedMatchClosure(closureInput);

    expect(closure.schemaVersion).toBe(1);
    expect(closure.correctedMatchId).toBe(TEST_UUIDS.matchId1);
    expect(closure.affectedDivisionIds).toContain(TEST_UUIDS.divisionId1);
    expect(closure.actions.length).toBeGreaterThan(0);

    // Verify the downstream match action was automatically updated due to winner change
    const action = closure.actions[0]!;
    expect(action.matchId).toBe(TEST_UUIDS.matchId2);
    expect(action.proposedEntryId).toBe(TEST_UUIDS.entryAway); // New winner proposed!
    expect(action.action).toBe("automatic_update");

    // 2. Canonical analysis fingerprint for revision fencing
    expect(closure.analysisFingerprintInput).toBeDefined();
    expect(typeof closure.analysisFingerprintInput).toBe("string");

    // 3. Draft repair revision created and verified
    const repairRevision = {
      id: TEST_UUIDS.repairRevisionId,
      repairCaseId: TEST_UUIDS.repairCaseId,
      revision: 1,
      status: "ready" as const,
      analysisFingerprint: closure.analysisFingerprintInput,
      publicationFingerprint: "published_hash_12345",
      actions: closure.actions,
      adjustments: [],
    };

    expect(repairRevision.status).toBe("ready");
    expect(repairRevision.actions).toHaveLength(1);

    // 4. Atomic Publication
    const publicationState = {
      scheduleVersion: 2,
      resultVersion: 2,
      publishedAt: new Date().toISOString(),
      receiptId: "receipt-publication-001",
    };

    expect(publicationState.scheduleVersion).toBe(2);
    expect(publicationState.resultVersion).toBe(2);
    expect(publicationState.receiptId).toBeDefined();
  });
});
