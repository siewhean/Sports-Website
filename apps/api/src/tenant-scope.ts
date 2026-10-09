import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode, type ApiErrorCode } from "./errors.js";

/**
 * Tenant-scope guards for child ids that arrive in a URL/body next to a (separately authorised)
 * competition id. Authorising `competitionId` says nothing about whether `divisionId`, `matchId`,
 * etc. belong to it, so every handler must prove the relationship BEFORE reading or locking the
 * child. A missing child and a child owned by another competition produce the identical 404, so the
 * response cannot be used as an existence/revision oracle for other tenants' data.
 */
export type ScopedChildKind = "division" | "match" | "entry" | "format_revision" | "schedule_revision" | "repair_case";

const SCOPES: Record<ScopedChildKind, { sql: string; code: ApiErrorCode; message: string; lockable?: boolean }> = {
  division: {
    sql: "SELECT t.id FROM divisions t WHERE t.id=$1 AND t.competition_id=$2",
    code: ErrorCode.DIVISION_NOT_FOUND,
    message: "Division not found",
  },
  match: {
    sql: "SELECT t.id FROM matches t WHERE t.id=$1 AND t.competition_id=$2",
    code: ErrorCode.MATCH_NOT_FOUND,
    message: "Match not found",
  },
  entry: {
    sql: "SELECT t.id FROM division_entries t JOIN divisions d ON d.id=t.division_id WHERE t.id=$1 AND d.competition_id=$2",
    code: ErrorCode.NOT_FOUND,
    message: "Entry not found",
  },
  format_revision: {
    sql: "SELECT t.id FROM format_revisions t WHERE t.id=$1 AND t.competition_id=$2",
    code: ErrorCode.FORMAT_REVISION_NOT_FOUND,
    message: "Format revision not found",
  },
  schedule_revision: {
    sql: "SELECT t.id FROM schedule_revisions t WHERE t.id=$1 AND t.competition_id=$2",
    code: ErrorCode.SCHEDULE_REVISION_NOT_FOUND,
    message: "Schedule revision not found",
  },
  repair_case: {
    // Either repair-case flavour; a UNION cannot take row locks.
    sql: `SELECT t.id FROM (
            SELECT id, competition_id FROM schedule_repair_cases
            UNION ALL
            SELECT id, competition_id FROM result_repair_cases
          ) t WHERE t.id=$1 AND t.competition_id=$2`,
    code: ErrorCode.REPAIR_CASE_NOT_FOUND,
    message: "Repair case not found",
    lockable: false,
  },
};

export async function assertChildInCompetition(
  sql: PostgresJsSql,
  kind: ScopedChildKind,
  childId: string,
  competitionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<void> {
  const scope = SCOPES[kind];
  const lock = options.forUpdate && scope.lockable !== false ? " FOR UPDATE OF t" : "";
  const rows = await sql.unsafe<{ id: string }>(`${scope.sql}${lock}`, [childId, competitionId]);
  if (!rows[0]) throw new ApiError(404, scope.code, scope.message);
}

export function assertDivisionInCompetition(
  sql: PostgresJsSql,
  divisionId: string,
  competitionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<void> {
  return assertChildInCompetition(sql, "division", divisionId, competitionId, options);
}
