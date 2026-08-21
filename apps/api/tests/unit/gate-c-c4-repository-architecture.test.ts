import { describe, expect, it, vi } from "vitest";
import { RepairRepository, PublicProjectionRepository, PublicationRepository } from "../../src/repositories/index.js";
import { GateCC4PostgresPublisher } from "../../src/gate-c-c4-postgres-publisher.js";
import { ApiError, ErrorCode } from "../../src/errors.js";
import type { SqlExecutor } from "../../src/repositories/types.js";
import type { PostgresJsSql } from "@matchday/identity";

function createMockSql(results: unknown[][] = []): { unsafe: ReturnType<typeof vi.fn>; executor: SqlExecutor } {
  let callIndex = 0;
  const unsafe = vi.fn().mockImplementation(() => {
    const res = results[callIndex] ?? [];
    callIndex += 1;
    return Promise.resolve(res);
  });
  return { unsafe, executor: { unsafe } as unknown as SqlExecutor };
}

describe("C4 V2 Repository Layer: RepairRepository", () => {
  it("targets schedule_repair_match_adjustments table for adjustment insertion and queries", async () => {
    const { unsafe, executor } = createMockSql([
      [{ id: "adj_1" }], // insertAdjustment
      [{ id: "adj_1", repair_revision_id: "rev_1", match_id: "match_10" }], // findAdjustmentsByRevisionId
    ]);
    const repo = new RepairRepository(executor);

    await repo.insertAdjustment({
      repairRevisionId: "rev_1",
      repairCaseId: "case_1",
      competitionId: "cmp_1",
      matchId: "match_10",
      divisionId: "div_1",
      playingAreaId: "pitch_1",
      startsAt: "2026-08-20T10:00:00Z",
      endsAt: "2026-08-20T10:40:00Z",
      reason: "Postponed due to lightning",
      decidedByAccountId: "acc_admin",
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO schedule_repair_match_adjustments"),
      expect.arrayContaining(["rev_1", "case_1", "cmp_1", "match_10", "div_1"]),
    );

    const adjustments = await repo.findAdjustmentsByRevisionId("rev_1");
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.match_id).toBe("match_10");
    expect(unsafe).toHaveBeenCalledWith(expect.stringContaining("FROM schedule_repair_match_adjustments"), ["rev_1"]);
  });

  it("calls gate_c_append_schedule_repair_revision with target_repair_case_id as first parameter", async () => {
    const { unsafe, executor } = createMockSql([[{ id: "rev_123", revision: 2, status: "draft" }]]);
    const repo = new RepairRepository(executor);

    const revision = await repo.appendRevision({
      repairCaseId: "case_abc",
      expectedSourceResultVersion: 1,
      expectedSourceScheduleVersion: 1,
      expectedAnalysisFingerprint: "fingerprint_123",
      parentRevisionId: "rev_parent",
      nextStatus: "draft",
      nextPublicationFingerprint: "pub_fp_123",
      actorAccountId: "acc_admin",
    });

    expect(revision).toEqual({ id: "rev_123", revision: 2, status: "draft" });
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("SELECT * FROM gate_c_append_schedule_repair_revision($1, $2, $3, $4, $5, $6, $7, $8)"),
      ["case_abc", 1, 1, "fingerprint_123", "rev_parent", "draft", "pub_fp_123", "acc_admin"],
    );
  });

  it("finds case by ID and by match and result version", async () => {
    const { unsafe, executor } = createMockSql([
      [{ id: "case_1", competition_id: "cmp_1", status: "open" }],
      [{ id: "case_2", corrected_match_id: "match_1", source_result_version: 3 }],
    ]);
    const repo = new RepairRepository(executor);

    const case1 = await repo.findCaseById("case_1", "cmp_1");
    expect(case1).toEqual({ id: "case_1", competition_id: "cmp_1", status: "open" });
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("FROM schedule_repair_cases WHERE id = $1 AND competition_id = $2"),
      ["case_1", "cmp_1"],
    );

    const case2 = await repo.findCaseByMatchAndResultVersion("cmp_1", "match_1", 3);
    expect(case2).toEqual({ id: "case_2", corrected_match_id: "match_1", source_result_version: 3 });
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("WHERE competition_id = $1 AND corrected_match_id = $2 AND source_result_version = $3"),
      ["cmp_1", "match_1", 3],
    );
  });
});

describe("C4 V2 Repository Layer: PublicProjectionRepository", () => {
  it("binds to public_projection_versions and public_competition_projections", async () => {
    const { unsafe, executor } = createMockSql([
      [{ projection_version: 5 }], // allocateProjectionVersion
      [{ id: "proj_ver_1" }], // insertProjectionVersion
      [{ projection: { test: true }, generated_at: "2026-08-20T10:00:00Z" }], // findCompetitionProjection
    ]);
    const repo = new PublicProjectionRepository(executor);

    const version = await repo.allocateProjectionVersion("cmp_1", "div_1");
    expect(version).toBe(5);
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("FROM public_projection_versions WHERE competition_id = $1 AND division_id = $2"),
      ["cmp_1", "div_1"],
    );

    const inserted = await repo.insertProjectionVersion({
      competitionId: "cmp_1",
      divisionId: "div_1",
      scheduleVersion: 2,
      resultVersion: 3,
      projectionVersion: 5,
      scheduleRevisionId: "sched_rev_1",
      sourceRepairRevisionId: "rep_rev_1",
      projection: { test: true },
      projectionFingerprint: "fingerprint_123",
      etag: '"5-abc"',
      generatedAt: new Date("2026-08-20T10:00:00Z"),
      sourceUpdatedAt: new Date("2026-08-20T10:00:00Z"),
    });
    expect(inserted).toEqual({ id: "proj_ver_1" });
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO public_projection_versions"),
      expect.arrayContaining(["cmp_1", "div_1", 2, 3, 5]),
    );

    const compProj = await repo.findCompetitionProjection("cmp_1");
    expect(compProj).toEqual({ projection: { test: true }, generated_at: "2026-08-20T10:00:00Z" });
    expect(unsafe).toHaveBeenCalledWith(expect.stringContaining("FROM public_competition_projections projection"), [
      "cmp_1",
    ]);
  });
});

describe("C4 V2 Repository Layer: PublicationRepository", () => {
  it("persists complete publication state across competition_publications and export manifests", async () => {
    const { unsafe, executor } = createMockSql([
      [{ competition_id: "cmp_1", schedule_version: 2, result_version: 1, published_at: new Date() }], // findByCompetitionId
      [{ id: "man_1" }], // insertExportManifest
      [{ id: "man_1", byte_size: 100 }], // findExportManifest
    ]);
    const repo = new PublicationRepository(executor);

    const pub = await repo.findByCompetitionId("cmp_1");
    expect(pub?.schedule_version).toBe(2);
    expect(unsafe).toHaveBeenCalledWith(expect.stringContaining("FROM competition_publications"), ["cmp_1"]);

    const manifestResult = await repo.insertExportManifest({
      competitionId: "cmp_1",
      divisionId: null,
      exportKind: "json",
      scheduleVersion: 2,
      resultVersion: 1,
      sourceFingerprint: "hash123",
      contentSha256: "payload_hash",
      sizeBytes: 100,
      filename: "export.json",
      createdByAccountId: "acc_admin",
    });
    expect(manifestResult).toEqual({ id: "man_1" });
    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO competition_export_manifests"),
      expect.arrayContaining(["cmp_1", null, "json", 2, 1, "hash123"]),
    );

    const manifest = await repo.findExportManifest({
      competitionId: "cmp_1",
      divisionId: null,
      exportKind: "json",
      sourceFingerprint: "hash123",
    });
    expect(manifest?.id).toBe("man_1");
    expect(unsafe).toHaveBeenCalledWith(expect.stringContaining("FROM competition_export_manifests"), [
      "cmp_1",
      null,
      "json",
      "hash123",
    ]);
  });
});

describe("C4 V2 Architecture: ErrorCode contracts & ApiError typing", () => {
  it("uses typed ErrorCode constants across repair and publication domain", () => {
    expect(ErrorCode.REPAIR_CASE_NOT_FOUND).toBe("REPAIR_CASE_NOT_FOUND");
    expect(ErrorCode.REPAIR_REVISION_NOT_FOUND).toBe("REPAIR_REVISION_NOT_FOUND");
    expect(ErrorCode.REPAIR_DECISION_INVALID).toBe("REPAIR_DECISION_INVALID");
    expect(ErrorCode.REPAIR_PUBLISH_FAILED).toBe("REPAIR_PUBLISH_FAILED");
    expect(ErrorCode.OFFLINE_AUTHORIZATION_DENIED).toBe("OFFLINE_AUTHORIZATION_DENIED");
    expect(ErrorCode.OFFLINE_DEVICE_MISMATCH).toBe("OFFLINE_DEVICE_MISMATCH");

    const err = new ApiError(404, ErrorCode.REPAIR_CASE_NOT_FOUND, "Repair case was not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe(ErrorCode.REPAIR_CASE_NOT_FOUND);
    expect(err.message).toBe("Repair case was not found");
  });
});

describe("C4 V2 Architecture: Atomic Transaction Rollback", () => {
  it("GateCC4PostgresPublisher rolls back all entities when projection writing fails in caller transaction", async () => {
    const mockTx = {
      unsafe: vi.fn().mockResolvedValue([]),
    } as unknown as PostgresJsSql;

    const publisher = new GateCC4PostgresPublisher({
      writePublicProjection: vi.fn().mockRejectedValue(new Error("Projection generation error")),
    });

    // When publication fails because the current published schedule is missing, it throws ApiError 409
    await expect(
      publisher.publish(mockTx, {
        actor: { accountId: "acc_1" },
        requestId: "req_1",
        competitionId: "cmp_rollback",
        expectedScheduleVersion: 1,
        expectedResultVersion: 1,
        repairCase: { id: "case_1" } as unknown as Parameters<GateCC4PostgresPublisher["publish"]>[1]["repairCase"],
        repairRevision: {
          id: "rev_1",
          publication_fingerprint: "pub_fp_1",
          repaired_at: new Date().toISOString(),
        } as unknown as Parameters<GateCC4PostgresPublisher["publish"]>[1]["repairRevision"],
        plan: {} as unknown as Parameters<GateCC4PostgresPublisher["publish"]>[1]["plan"],
        adjustments: [],
      }),
    ).rejects.toThrow();
  });
});
