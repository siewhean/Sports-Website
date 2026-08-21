import { describe, it, expect, vi } from "vitest";
import {
  buildRepairPublicationPlan,
  calculateAffectedMatchClosure,
  type AffectedMatchClosure,
  type RepairPublicationDecision,
} from "@matchday/domain";
import { ApiError, ErrorCode } from "../../../apps/api/src/errors";
import { GateCC4Runtime } from "../../../apps/api/src/gate-c-c4-runtime";
import {
  RepairRepository,
  CompetitionRepository,
  PublicationRepository,
  PublicProjectionRepository,
  ScheduleRepository,
} from "../../../apps/api/src/repositories";
import { TEST_UUIDS, createValidClosureInput } from "../helpers/fixtures";

describe("Tier 5 Adversarial - Subsystem 2: C4 Repair & Publication", () => {
  const actor = {
    accountId: TEST_UUIDS.accountId,
    roles: ["owner"] as const,
  };

  it("ADV-C4-01: rejects invalid or non-existent repair case IDs and correction transactions with typed 404 ErrorCodes", async () => {
    const mockSql: any = {
      begin: vi.fn(async (callback) => callback(mockSql)),
      unsafe: vi.fn(async () => []),
    };

    const mockCompRepo = new CompetitionRepository(mockSql);
    vi.spyOn(mockCompRepo, "findCompetitionAccess").mockResolvedValue({
      competition_id: TEST_UUIDS.competitionId,
      organisation_id: TEST_UUIDS.organisationId,
      competition_status: "published",
    });

    const mockRepairRepo = new RepairRepository(mockSql);
    vi.spyOn(mockRepairRepo, "findCaseById").mockResolvedValue(null);
    vi.spyOn(mockRepairRepo, "findSourceCorrection").mockResolvedValue(null);

    const runtime = new GateCC4Runtime(
      mockSql,
      undefined,
      undefined,
      mockRepairRepo,
      mockCompRepo,
      new PublicationRepository(mockSql),
      new PublicProjectionRepository(mockSql),
    );

    // 1. Unknown repair case on createRevision -> REPAIR_CASE_NOT_FOUND (404)
    await expect(
      runtime.createRevision(
        actor as any,
        TEST_UUIDS.competitionId,
        "non-existent-repair-id",
        {
          expected_result_version: 1,
          expected_schedule_version: 1,
          expected_analysis_fingerprint: "abc",
          status: "draft",
          parent_revision_id: null,
          decisions: [],
          schedule_adjustments: [],
        },
        "req-1",
      ),
    ).rejects.toThrow(ApiError);

    try {
      await runtime.createRevision(
        actor as any,
        TEST_UUIDS.competitionId,
        "non-existent-repair-id",
        {
          expected_result_version: 1,
          expected_schedule_version: 1,
          expected_analysis_fingerprint: "abc",
          status: "draft",
          parent_revision_id: null,
          decisions: [],
          schedule_adjustments: [],
        },
        "req-1",
      );
    } catch (error: any) {
      expect(error.code).toBe(ErrorCode.REPAIR_CASE_NOT_FOUND);
      expect(error.statusCode).toBe(404);
    }

    // 2. Unknown correction on analyseCorrection -> CORRECTION_NOT_FOUND (404)
    try {
      await runtime.analyseCorrection(actor as any, TEST_UUIDS.competitionId, "non-existent-correction-id", "req-2");
    } catch (error: any) {
      expect(error.code).toBe(ErrorCode.CORRECTION_NOT_FOUND);
      expect(error.statusCode).toBe(404);
    }
  });

  it("ADV-C4-02: detects stale source versions and concurrent revision conflicts (409 ErrorCodes)", async () => {
    const mockSql: any = {
      begin: vi.fn(async (callback) => callback(mockSql)),
      unsafe: vi.fn(async () => []),
    };

    const mockCompRepo = new CompetitionRepository(mockSql);
    vi.spyOn(mockCompRepo, "findCompetitionAccess").mockResolvedValue({
      competition_id: TEST_UUIDS.competitionId,
      organisation_id: TEST_UUIDS.organisationId,
      competition_status: "published",
    });

    const mockRepairRepo = new RepairRepository(mockSql);
    vi.spyOn(mockRepairRepo, "findCaseById").mockResolvedValue({
      id: TEST_UUIDS.repairCaseId,
      competition_id: TEST_UUIDS.competitionId,
      corrected_division_id: TEST_UUIDS.divisionId1,
      corrected_match_id: TEST_UUIDS.matchId1,
      correction_transaction_id: "corr-1",
      source_result_version: 2, // Current is 2
      source_schedule_version: 2, // Current is 2
      source_projection_version: 1,
      analysis_fingerprint: "current-fingerprint-sha256",
      analysis_fingerprint_input: "{}",
      created_by_account_id: TEST_UUIDS.accountId,
      created_at: new Date(),
    });

    const runtime = new GateCC4Runtime(
      mockSql,
      undefined,
      undefined,
      mockRepairRepo,
      mockCompRepo,
      new PublicationRepository(mockSql),
      new PublicProjectionRepository(mockSql),
    );

    // Stale expected result version (1 vs 2)
    try {
      await runtime.createRevision(
        actor as any,
        TEST_UUIDS.competitionId,
        TEST_UUIDS.repairCaseId,
        {
          expected_result_version: 1, // Stale!
          expected_schedule_version: 2,
          expected_analysis_fingerprint: "current-fingerprint-sha256",
          status: "draft",
          parent_revision_id: null,
          decisions: [],
          schedule_adjustments: [],
        },
        "req-3",
      );
    } catch (error: any) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe(ErrorCode.REPAIR_SOURCE_STALE);
      expect(error.statusCode).toBe(409);
    }
  });

  it("ADV-C4-03: enforces organiser decision completion and schedule adjustment boundaries", () => {
    const baseInput = createValidClosureInput();
    // Configure match2 as operationally locked so that it classifies as requires_organiser_decision
    const input: typeof baseInput = {
      ...baseInput,
      matches: baseInput.matches.map((m) =>
        m.matchId === TEST_UUIDS.matchId2 ? { ...m, operationallyLocked: true } : m,
      ),
    };
    const closure = calculateAffectedMatchClosure(input);

    // Match 2 requires decision because winner changed on an operationally locked match
    expect(closure.actions.length).toBeGreaterThan(0);
    const requiresDecisionAction = closure.actions.find((a) => a.action === "requires_organiser_decision");
    expect(requiresDecisionAction).toBeDefined();

    // Plan with empty decisions cannot be ready
    const incompletePlan = buildRepairPublicationPlan(closure, []);
    expect(incompletePlan.ready).toBe(false);
    expect(incompletePlan.unresolved.length).toBeGreaterThan(0);

    // Attempting invalid decision reason (<3 chars) throws error
    expect(() =>
      buildRepairPublicationPlan(closure, [
        {
          matchId: requiresDecisionAction!.matchId,
          slot: requiresDecisionAction!.slot,
          decision: "keep_current",
          reason: "no", // too short!
        },
      ]),
    ).toThrow(/requires a reason/);

    // Attempting manual decision without entry throws error
    expect(() =>
      buildRepairPublicationPlan(closure, [
        {
          matchId: requiresDecisionAction!.matchId,
          slot: requiresDecisionAction!.slot,
          decision: "set_manual_entry",
          selectedEntryId: "", // empty entry!
          reason: "Valid organiser manual reason",
        },
      ]),
    ).toThrow(/requires an entry/);

    // Valid plan becomes ready
    const completePlan = buildRepairPublicationPlan(closure, [
      {
        matchId: requiresDecisionAction!.matchId,
        slot: requiresDecisionAction!.slot,
        decision: "keep_current",
        reason: "Valid organiser resolution reason",
      },
    ]);
    expect(completePlan.ready).toBe(true);
    expect(completePlan.unresolved).toHaveLength(0);
  });

  it("ADV-C4-04: rejects idempotency key reuse with modified payload fingerprint", async () => {
    const mockSql: any = {
      begin: vi.fn(async (callback) => callback(mockSql)),
      unsafe: vi.fn(async () => []),
    };

    const mockCompRepo = new CompetitionRepository(mockSql);
    vi.spyOn(mockCompRepo, "findCompetitionAccess").mockResolvedValue({
      competition_id: TEST_UUIDS.competitionId,
      organisation_id: TEST_UUIDS.organisationId,
      competition_status: "published",
    });

    const mockRepairRepo = new RepairRepository(mockSql);
    vi.spyOn(mockRepairRepo, "acquirePublicationLock").mockResolvedValue(undefined);
    vi.spyOn(mockRepairRepo, "findPublicationReceiptByIdempotencyKey").mockResolvedValue({
      request_fingerprint: "original-hash-1111111111111111111111111111111111111111111111111111111111111111",
      response: { publication_id: "pub-1", duplicate: true },
    });

    const mockPubPort = {
      publish: vi.fn(),
    };

    const runtime = new GateCC4Runtime(
      mockSql,
      mockPubPort,
      undefined,
      mockRepairRepo,
      mockCompRepo,
      new PublicationRepository(mockSql),
      new PublicProjectionRepository(mockSql),
    );

    // Reusing idempotency key with different payload triggers IDEMPOTENCY_KEY_REUSED (409)
    try {
      await runtime.publishRevision(
        actor as any,
        {
          competition_id: TEST_UUIDS.competitionId,
          repair_id: TEST_UUIDS.repairCaseId,
          repair_revision_id: TEST_UUIDS.repairRevisionId,
          expected_result_version: 1,
          expected_schedule_version: 1,
          expected_analysis_fingerprint: "fingerprint",
          publication_idempotency_key: "idem-key-duplicate-test",
        },
        "req-idempotency",
      );
    } catch (error: any) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);
      expect(error.statusCode).toBe(409);
    }
  });

  it("ADV-C4-05: guarantees atomic rollback across revision, schedule, and projection on partial failure", async () => {
    let transactionCommitted = false;
    let transactionRolledBack = false;

    const mockTxSql: any = {
      unsafe: vi.fn(async () => []),
    };

    const mockSql: any = {
      begin: vi.fn(async (callback) => {
        try {
          const result = await callback(mockTxSql);
          transactionCommitted = true;
          return result;
        } catch (err) {
          transactionRolledBack = true;
          throw err;
        }
      }),
      unsafe: vi.fn(async () => []),
    };

    const input = createValidClosureInput();
    const closure = calculateAffectedMatchClosure(input);
    const plan = buildRepairPublicationPlan(closure, []);
    const { createHash } = await import("node:crypto");
    const analysisFingerprint = createHash("sha256").update(closure.analysisFingerprintInput).digest("hex");

    function stableJson(value: unknown): string {
      if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
      if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
          .join(",")}}`;
      }
      return JSON.stringify(value) ?? "null";
    }

    const pubFingerprint = createHash("sha256")
      .update(
        stableJson({
          schema_version: 1,
          plan: JSON.parse(plan.publicationFingerprintInput),
          schedule_adjustments: [],
        }),
      )
      .digest("hex");

    const mockCompRepo = new CompetitionRepository(mockSql);
    vi.spyOn(mockCompRepo, "findCompetitionAccess").mockResolvedValue({
      competition_id: TEST_UUIDS.competitionId,
      organisation_id: TEST_UUIDS.organisationId,
      competition_status: "published",
    });

    const mockRepairRepo = new RepairRepository(mockSql);
    vi.spyOn(mockRepairRepo, "acquirePublicationLock").mockResolvedValue(undefined);
    vi.spyOn(mockRepairRepo, "findPublicationReceiptByIdempotencyKey").mockResolvedValue(null);
    vi.spyOn(mockRepairRepo, "findCaseById").mockResolvedValue({
      id: TEST_UUIDS.repairCaseId,
      competition_id: TEST_UUIDS.competitionId,
      corrected_division_id: TEST_UUIDS.divisionId1,
      corrected_match_id: TEST_UUIDS.matchId1,
      correction_transaction_id: "corr-1",
      source_result_version: 1,
      source_schedule_version: 1,
      source_projection_version: 1,
      analysis_fingerprint: analysisFingerprint,
      analysis_fingerprint_input: closure.analysisFingerprintInput,
      created_by_account_id: TEST_UUIDS.accountId,
      created_at: new Date(),
    });
    vi.spyOn(mockRepairRepo, "findRevisionById").mockResolvedValue({
      id: TEST_UUIDS.repairRevisionId,
      repair_case_id: TEST_UUIDS.repairCaseId,
      competition_id: TEST_UUIDS.competitionId,
      revision: 1,
      parent_revision_id: null,
      status: "ready",
      source_result_version: 1,
      source_schedule_version: 1,
      source_projection_version: 1,
      analysis_fingerprint: analysisFingerprint,
      publication_fingerprint: pubFingerprint,
      created_by_account_id: TEST_UUIDS.accountId,
      created_at: new Date(),
    });

    vi.spyOn(mockRepairRepo, "findSourceCorrection").mockResolvedValue({
      correction_id: "corr-1",
      competition_id: TEST_UUIDS.competitionId,
      division_id: TEST_UUIDS.divisionId1,
      match_id: TEST_UUIDS.matchId1,
      result_version: 1,
      current_result_version: 1,
      schedule_version: 1,
      source_projection_version: 1,
      format_revision_id: "format-1",
    });
    vi.spyOn(mockRepairRepo, "findMatchesForAnalysis").mockResolvedValue(
      input.matches.map((m) => ({
        match_id: m.matchId,
        division_id: m.divisionId,
        state: m.state,
        home_entry_id: m.homeEntryId,
        away_entry_id: m.awayEntryId,
        home_control: m.homeControl,
        away_control: m.awayControl,
        operationally_locked: Boolean(m.operationallyLocked),
      })),
    );
    vi.spyOn(mockRepairRepo, "findDependenciesForAnalysis").mockResolvedValue(
      input.dependencies.map((d) => ({
        source_match_id: d.sourceMatchId,
        downstream_match_id: d.downstreamMatchId,
        slot: d.slot,
        outcome: d.outcome,
      })),
    );
    vi.spyOn(mockRepairRepo, "findOutcomesForAnalysis").mockResolvedValue([
      {
        match_id: TEST_UUIDS.matchId1,
        home_entry_id: TEST_UUIDS.entryHome,
        away_entry_id: TEST_UUIDS.entryAway,
        home_score: 0,
        away_score: 1,
      },
    ]);
    vi.spyOn(mockRepairRepo, "findPersistedActionsAndDecisions").mockResolvedValue([]);
    vi.spyOn(mockRepairRepo, "findAdjustmentsByRevisionId").mockResolvedValue([]);

    const mockPubRepo = new PublicationRepository(mockSql);
    vi.spyOn(mockPubRepo, "getVersions").mockResolvedValue({
      schedule_version: 1,
      result_version: 1,
    });

    // Failing publication port (simulating unexpected error during multi-step publication)
    const failingPubPort = {
      publish: vi.fn(async () => {
        throw new Error("Simulated downstream publication failure");
      }),
    };

    const runtime = new GateCC4Runtime(
      mockSql,
      failingPubPort,
      undefined,
      mockRepairRepo,
      mockCompRepo,
      mockPubRepo,
      new PublicProjectionRepository(mockSql),
    );

    await expect(
      runtime.publishRevision(
        actor as any,
        {
          competition_id: TEST_UUIDS.competitionId,
          repair_id: TEST_UUIDS.repairCaseId,
          repair_revision_id: TEST_UUIDS.repairRevisionId,
          expected_result_version: 1,
          expected_schedule_version: 1,
          expected_analysis_fingerprint: analysisFingerprint,
          publication_idempotency_key: "idem-key-atomic-test",
        },
        "req-fail",
      ),
    ).rejects.toThrow("Simulated downstream publication failure");

    expect(transactionRolledBack).toBe(true);
    expect(transactionCommitted).toBe(false);
  });
});
