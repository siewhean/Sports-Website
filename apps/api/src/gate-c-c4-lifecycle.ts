import type { PostgresJsSql } from "@matchday/identity";
import { ApiError } from "./errors.js";
import type { Phase3Actor } from "./phase-3-runtime.js";

type AccessRow = {
  organisation_id: string;
  competition_status: string;
  membership_role: "owner" | "organiser";
};

type RepairCaseRow = {
  id: string;
  competition_id: string;
  source_result_version: number;
  source_schedule_version: number;
  analysis_fingerprint: string;
};

type RevisionRow = {
  id: string;
  revision: number;
  status: "draft" | "ready" | "published" | "abandoned";
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

function required<T>(rows: readonly T[], code: string, message: string): T {
  const row = rows[0];
  if (!row) throw new ApiError(404, code, message);
  return row;
}

export class GateCC4LifecycleOperations {
  constructor(
    private readonly sql: PostgresJsSql,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async access(
    tx: PostgresJsSql,
    actor: Phase3Actor,
    competitionId: string,
    mutable = true,
  ): Promise<AccessRow> {
    const access = required(
      await tx.unsafe<AccessRow>(
        `SELECT competition.organisation_id,competition.status AS competition_status,
                membership.role AS membership_role
         FROM competitions competition
         JOIN organisation_memberships membership
           ON membership.organisation_id=competition.organisation_id
         WHERE competition.id=$1
           AND membership.account_id=$2
           AND membership.status='active'
           AND membership.role IN ('owner','organiser')`,
        [competitionId, actor.accountId],
      ),
      "COMPETITION_ACCESS_DENIED",
      "Competition access denied",
    );
    if (mutable && access.competition_status === "archived") {
      throw new ApiError(409, "COMPETITION_ARCHIVED", "Archived competitions are immutable");
    }
    return access;
  }

  async listPendingCases(
    actor: Phase3Actor,
    competitionId: string,
  ): Promise<readonly GateCC4PendingResultRepairCase[]> {
    await this.access(this.sql, actor, competitionId, false);
    const rows = await this.sql.unsafe<{
      result_repair_case_id: string;
      correction_transaction_id: string;
      corrected_match_id: string;
      corrected_match_code: string;
      division_id: string;
      division_name: string;
      source_result_version: number;
      created_at: Date | string;
    }>(
      `SELECT result_case.id AS result_repair_case_id,
              result_case.correction_transaction_id,
              result_case.corrected_match_id,
              match.code AS corrected_match_code,
              result_case.division_id,
              division.name AS division_name,
              result_case.source_result_version,
              result_case.created_at
       FROM result_repair_cases result_case
       JOIN matches match ON match.id=result_case.corrected_match_id
       JOIN divisions division ON division.id=result_case.division_id
       LEFT JOIN schedule_repair_cases schedule_case
         ON schedule_case.result_repair_case_id=result_case.id
       WHERE result_case.competition_id=$1
         AND schedule_case.id IS NULL
       ORDER BY result_case.created_at,result_case.id`,
      [competitionId],
    );
    return rows.map((row) => ({
      ...row,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    }));
  }

  async abandonLatestRevision(
    actor: Phase3Actor,
    competitionId: string,
    repairId: string,
    request: { expected_revision: number; reason: string },
    requestId: string,
  ): Promise<GateCC4AbandonReceipt> {
    if (!this.sql.begin) throw new Error("Gate C4 lifecycle operations require a transaction-capable PostgreSQL client");
    const reason = request.reason.trim();
    if (reason.length < 3 || reason.length > 1_000) {
      throw new ApiError(422, "REPAIR_ABANDON_REASON_INVALID", "Abandonment reason must contain 3 to 1000 characters");
    }
    return this.sql.begin(async (tx) => {
      const access = await this.access(tx, actor, competitionId);
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtextextended('gate-c:repair-lifecycle:'||$1,0))`, [repairId]);
      const repairCase = required(
        await tx.unsafe<RepairCaseRow>(
          `SELECT id,competition_id,source_result_version,source_schedule_version,analysis_fingerprint
           FROM schedule_repair_cases
           WHERE id=$1 AND competition_id=$2
           FOR KEY SHARE`,
          [repairId, competitionId],
        ),
        "REPAIR_CASE_NOT_FOUND",
        "Repair case not found",
      );
      const latest = required(
        await tx.unsafe<RevisionRow>(
          `SELECT id,revision,status
           FROM schedule_repair_revisions
           WHERE repair_case_id=$1
           ORDER BY revision DESC
           LIMIT 1
           FOR UPDATE`,
          [repairId],
        ),
        "REPAIR_REVISION_NOT_FOUND",
        "Repair revision not found",
      );
      if (latest.revision !== request.expected_revision) {
        throw new ApiError(409, "REPAIR_REVISION_STALE", "A newer repair revision exists");
      }
      if (latest.status === "published") {
        throw new ApiError(409, "REPAIR_ALREADY_PUBLISHED", "Published repairs cannot be abandoned");
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
      const abandoned = required(
        await tx.unsafe<RevisionRow & { created_at: Date | string }>(
          `SELECT * FROM gate_c_append_schedule_repair_revision($1,$2,$3,$4,$5,'abandoned',NULL,$6)`,
          [
            repairCase.id,
            repairCase.source_result_version,
            repairCase.source_schedule_version,
            repairCase.analysis_fingerprint,
            latest.id,
            actor.accountId,
          ],
        ),
        "REPAIR_ABANDON_FAILED",
        "Repair abandonment was not retained",
      );
      const occurredAt = abandoned.created_at instanceof Date ? abandoned.created_at : new Date(abandoned.created_at);
      await tx.unsafe(
        `INSERT INTO audit_events(
           occurred_at,request_id,actor_account_id,actor_type,organisation_id,
           action,target_type,target_id,reason,after_state,metadata
         ) VALUES($1,$2,$3,'account',$4,'repair.abandoned','schedule_repair_revision',$5,$6,$7::jsonb,$8::jsonb)`,
        [
          occurredAt,
          requestId,
          actor.accountId,
          access.organisation_id,
          abandoned.id,
          reason,
          { repair_case_id: repairId, revision: abandoned.revision, status: "abandoned" },
          { competition_id: competitionId, repair_case_id: repairId },
        ],
      );
      await tx.unsafe(
        `INSERT INTO outbox_events(
           aggregate_type,aggregate_id,event_type,payload,idempotency_key,created_at,available_at
         ) VALUES('schedule_repair_revision',$1,'repair.abandoned',$2::jsonb,$3,$4,$4)`,
        [
          abandoned.id,
          { competition_id: competitionId, repair_case_id: repairId, revision: abandoned.revision },
          `${requestId}:repair.abandoned:${abandoned.id}`,
          occurredAt,
        ],
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
