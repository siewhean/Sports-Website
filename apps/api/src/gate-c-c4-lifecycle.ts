import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import { RepairRepository, CompetitionRepository, type PendingRepairCaseRecord } from "./repositories/index.js";

type AccessRow = {
  organisation_id: string;
  competition_status: string;
  membership_role: "owner" | "organiser";
};

export type GateCC4PendingResultRepairCase = Readonly<{
  result_repair_case_id: string;
  correction_transaction_id: string;
  corrected_match_id: string;
  corrected_match_code: string;
  division_id: string;
  division_name: string;
  source_result_version: number;
  created_at: string;
}>;

export type GateCC4AbandonReceipt = Readonly<{
  repair_id: string;
  repair_revision_id: string;
  revision: number;
  status: "abandoned";
  abandoned_at: string;
}>;

export class GateCC4LifecycleOperations {
  private readonly repairRepo: RepairRepository;
  private readonly competitionRepo: CompetitionRepository;

  constructor(
    private readonly sql: PostgresJsSql,
    private readonly now: () => Date = () => new Date(),
    repairRepo?: RepairRepository,
    competitionRepo?: CompetitionRepository,
  ) {
    this.repairRepo = repairRepo ?? new RepairRepository(sql);
    this.competitionRepo = competitionRepo ?? new CompetitionRepository(sql);
  }

  private async access(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    competitionId: string,
    mutable = true,
  ): Promise<AccessRow> {
    const access = await this.competitionRepo.findCompetitionAccess(
      competitionId,
      actor.accountId,
      ["owner", "organiser"],
      tx,
    );
    if (!access) {
      throw new ApiError(404, ErrorCode.COMPETITION_ACCESS_DENIED, "Competition access denied");
    }
    if (mutable && access.competition_status === "archived") {
      throw new ApiError(409, ErrorCode.COMPETITION_ARCHIVED, "Archived competitions are immutable");
    }
    return {
      organisation_id: access.organisation_id,
      competition_status: access.competition_status,
      membership_role: access.membership_role as "owner" | "organiser",
    };
  }

  async listPendingCases(
    actor: Phase3Actor,
    competitionId: string,
  ): Promise<readonly GateCC4PendingResultRepairCase[]> {
    await this.access(this.sql, actor, competitionId, false);
    const rows = await this.repairRepo.listPendingCases(competitionId, this.sql);
    return rows.map((row: PendingRepairCaseRecord) => ({
      ...row,
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    }));
  }

  async abandonLatestRevision(
    actor: Phase3Actor,
    competitionId: string,
    repairId: string,
    request: { expected_revision: number; reason: string },
    requestId: string,
  ): Promise<GateCC4AbandonReceipt> {
    if (!this.sql.begin)
      throw new Error("Gate C4 lifecycle operations require a transaction-capable PostgreSQL client");
    const reason = request.reason.trim();
    if (reason.length < 3 || reason.length > 1_000) {
      throw new ApiError(
        422,
        ErrorCode.REPAIR_ABANDON_REASON_INVALID,
        "Abandonment reason must contain 3 to 1000 characters",
      );
    }
    return this.sql.begin(async (tx) => {
      const access = await this.access(tx, actor, competitionId);
      await this.repairRepo.acquireLifecycleLock(repairId, tx);
      const repairCase = await this.repairRepo.findCaseById(repairId, competitionId, "for_share", tx);
      if (!repairCase) {
        throw new ApiError(404, ErrorCode.REPAIR_CASE_NOT_FOUND, "Repair case not found");
      }
      const latest = await this.repairRepo.findLatestRevision(repairId, undefined, "for_update", tx);
      if (!latest) {
        throw new ApiError(404, ErrorCode.REPAIR_REVISION_NOT_FOUND, "Repair revision not found");
      }
      if (latest.revision !== request.expected_revision) {
        throw new ApiError(409, ErrorCode.REPAIR_REVISION_STALE, "A newer repair revision exists");
      }
      if (latest.status === "published") {
        throw new ApiError(409, ErrorCode.REPAIR_ALREADY_PUBLISHED, "Published repairs cannot be abandoned");
      }
      if (latest.status === "abandoned") {
        return {
          repair_id: repairId,
          repair_revision_id: latest.id,
          revision: latest.revision,
          status: "abandoned",
          abandoned_at: this.now().toISOString(),
        };
      }
      const abandoned = await this.repairRepo.appendRevision(
        {
          repairCaseId: repairCase.id,
          expectedSourceResultVersion: repairCase.source_result_version,
          expectedSourceScheduleVersion: repairCase.source_schedule_version,
          expectedAnalysisFingerprint: repairCase.analysis_fingerprint,
          parentRevisionId: latest.id,
          nextStatus: "abandoned",
          nextPublicationFingerprint: null,
          actorAccountId: actor.accountId,
        },
        tx,
      );
      const occurredAt = abandoned.created_at instanceof Date ? abandoned.created_at : new Date(abandoned.created_at);
      await this.repairRepo.insertAuditEvent(
        {
          occurredAt,
          requestId,
          actorAccountId: actor.accountId,
          organisationId: access.organisation_id,
          action: "repair.abandoned",
          targetType: "schedule_repair_revision",
          targetId: abandoned.id,
          reason,
          afterState: { repair_case_id: repairId, revision: abandoned.revision, status: "abandoned" },
          metadata: { competition_id: competitionId, repair_case_id: repairId },
        },
        tx,
      );
      await this.repairRepo.insertOutboxEvent(
        {
          aggregateType: "schedule_repair_revision",
          aggregateId: abandoned.id,
          eventType: "repair.abandoned",
          payload: { competition_id: competitionId, repair_case_id: repairId, revision: abandoned.revision },
          idempotencyKey: `${requestId}:repair.abandoned:${abandoned.id}`,
          createdAt: occurredAt,
        },
        tx,
      );
      return {
        repair_id: repairId,
        repair_revision_id: abandoned.id,
        revision: abandoned.revision,
        status: "abandoned",
        abandoned_at: occurredAt.toISOString(),
      };
    });
  }
}
