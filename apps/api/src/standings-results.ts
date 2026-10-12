import type { StandingsEngineConfig, StandingsMatchResult } from "@matchday/domain";

export type PersistedStandingsResultRow = {
  match_id: string;
  home_entry_id: string;
  away_entry_id: string;
  home_score: number;
  away_score: number;
  state: "final" | "corrected";
  result_version: number;
  snapshot: Record<string, unknown> | string;
};

type CanonicalSnapshot = {
  segments?: Array<{ home?: number; away?: number }>;
  totalPoints?: { home?: number; away?: number };
  exceptionalOutcome?: string | null;
  winner?: "home" | "away" | null;
};

type GeneratedSnapshot = {
  homeSegments?: unknown;
  awaySegments?: unknown;
  forfeitLoserEntryId?: unknown;
  homeDisciplinePoints?: unknown;
  awayDisciplinePoints?: unknown;
};

/**
 * Converts one persisted match_result_snapshots row into a standings result.
 *
 * Two snapshot shapes are persisted: the canonical five-sport scoring state
 * written on finalisation (segments, totalPoints, winner, exceptionalOutcome)
 * and the generated shape written for withdrawal forfeits (homeSegments,
 * awaySegments, forfeitLoserEntryId). Every standings reader must understand
 * both, or a set sport fails segment validation and a walkover is scored as
 * the 0-0 canonical state instead of the sport's forfeit result.
 */
export function standingsResultFromSnapshot(
  row: PersistedStandingsResultRow,
  config: StandingsEngineConfig,
): StandingsMatchResult {
  const detail = (typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot) as Record<
    string,
    unknown
  > | null;
  const canonical = detail !== null && (Array.isArray(detail.segments) || "exceptionalOutcome" in detail);
  if (!canonical) {
    const generated = (detail ?? {}) as GeneratedSnapshot;
    const forfeitLoser = typeof generated.forfeitLoserEntryId === "string" ? generated.forfeitLoserEntryId : undefined;
    return {
      matchId: row.match_id,
      homeEntryId: row.home_entry_id,
      awayEntryId: row.away_entry_id,
      homeScore: row.home_score,
      awayScore: row.away_score,
      ...(Array.isArray(generated.homeSegments) && Array.isArray(generated.awaySegments)
        ? { homeSegments: generated.homeSegments as number[], awaySegments: generated.awaySegments as number[] }
        : {}),
      ...(typeof generated.homeDisciplinePoints === "number"
        ? { homeDisciplinePoints: generated.homeDisciplinePoints }
        : {}),
      ...(typeof generated.awayDisciplinePoints === "number"
        ? { awayDisciplinePoints: generated.awayDisciplinePoints }
        : {}),
      status: forfeitLoser ? "forfeit" : row.state,
      version: row.result_version,
      ...(forfeitLoser ? { forfeitLoserEntryId: forfeitLoser } : {}),
    };
  }
  const snapshot = detail as CanonicalSnapshot;
  const segments = Array.isArray(snapshot.segments) ? snapshot.segments : [];
  const forfeit = snapshot.exceptionalOutcome === "walkover" && Boolean(snapshot.winner);
  const homeWonForfeit = forfeit && snapshot.winner === "home";
  const forfeitHomeSegments = homeWonForfeit ? config.forfeitScore.homeSegments : config.forfeitScore.awaySegments;
  const forfeitAwaySegments = homeWonForfeit ? config.forfeitScore.awaySegments : config.forfeitScore.homeSegments;
  return {
    matchId: row.match_id,
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
    homeScore: forfeit
      ? homeWonForfeit
        ? config.forfeitScore.homeScore
        : config.forfeitScore.awayScore
      : Number(snapshot.totalPoints?.home ?? row.home_score),
    awayScore: forfeit
      ? homeWonForfeit
        ? config.forfeitScore.awayScore
        : config.forfeitScore.homeScore
      : Number(snapshot.totalPoints?.away ?? row.away_score),
    ...(!forfeit
      ? {
          homeSegments: segments.map((segment) => Number(segment.home ?? 0)),
          awaySegments: segments.map((segment) => Number(segment.away ?? 0)),
        }
      : forfeitHomeSegments && forfeitAwaySegments
        ? { homeSegments: forfeitHomeSegments, awaySegments: forfeitAwaySegments }
        : {}),
    status: forfeit ? ("forfeit" as const) : row.state,
    ...(forfeit
      ? {
          forfeitLoserEntryId: snapshot.winner === "home" ? row.away_entry_id : row.home_entry_id,
        }
      : {}),
    version: row.result_version,
  };
}

/**
 * The winning entry of a persisted result, or null for a draw. The canonical
 * scoring state carries its decided winner (including a walkover's declared
 * winner); generated forfeits name the loser; anything else compares scores.
 */
export function resultWinnerEntryId(row: PersistedStandingsResultRow): string | null {
  const detail = (typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot) as Record<
    string,
    unknown
  > | null;
  if (detail?.winner === "home") return row.home_entry_id;
  if (detail?.winner === "away") return row.away_entry_id;
  if (typeof detail?.forfeitLoserEntryId === "string") {
    return detail.forfeitLoserEntryId === row.home_entry_id ? row.away_entry_id : row.home_entry_id;
  }
  if (row.home_score === row.away_score) return null;
  return row.home_score > row.away_score ? row.home_entry_id : row.away_entry_id;
}
