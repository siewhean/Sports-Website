import type { PostgresJsSql } from "@matchday/identity";
import { ApiError, ErrorCode } from "./errors.js";

export const DIVISION_SHORT_CODE_UNIQUE_CONSTRAINT = "divisions_competition_short_code_unique";

/** Upper-cased short codes already used in the competition, for collision-free suggestions. */
export async function loadDivisionShortCodes(database: PostgresJsSql, competitionId: string): Promise<Set<string>> {
  const rows = await database.unsafe<{ short_code: string | null }>(
    `SELECT short_code FROM divisions WHERE competition_id=$1 AND short_code IS NOT NULL`,
    [competitionId],
  );
  return new Set(rows.flatMap((row) => (row.short_code ? [row.short_code.toUpperCase()] : [])));
}

function isShortCodeUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    const constraint = candidate.constraint_name ?? candidate.constraint;
    if (
      String(candidate.code) === "23505" &&
      typeof constraint === "string" &&
      constraint.includes(DIVISION_SHORT_CODE_UNIQUE_CONSTRAINT)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Runs a division insert/update and maps a concurrent short-code collision (unique index
 * divisions_competition_short_code_unique) to HTTP 409 instead of a 500.
 */
export async function withDivisionShortCodeConflict<T>(operation: () => PromiseLike<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isShortCodeUniqueViolation(error)) {
      throw new ApiError(409, ErrorCode.CONFLICT, "Division short code already exists in this competition");
    }
    throw error;
  }
}
