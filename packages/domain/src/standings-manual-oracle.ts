/**
 * Independent manual standings calculation oracle for QA-002 and QA-021.
 *
 * This implementation is deliberately transparent and built from first
 * principles to serve as an independent reference calculation during pilots and
 * automated verification.
 *
 * Supported Tiebreakers:
 * 1. Total Points
 * 2. Head-to-Head records (points/goal diff)
 * 3. Point / Goal Difference
 * 4. Total Points / Goals For
 * 5. Seed / Canonical Deterministic ID Fallback
 */

import type { StandingsEngineConfig, StandingsMatchResult, StandingsParticipant } from "./results.js";

export type ManualStandingsRow = {
  rank: number;
  entryId: string;
  entryName: string;
  seed: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifference: number;
  points: number;
  sportingTie: boolean;
};

export function computeManualStandingsOracle(
  participants: readonly StandingsParticipant[],
  results: readonly StandingsMatchResult[],
  config: StandingsEngineConfig,
): ManualStandingsRow[] {
  const winPts = config.winPoints ?? 3;
  const drawPts = config.drawPoints ?? 1;
  const lossPts = config.lossPoints ?? 0;

  // Initialize stats per participant
  const stats = new Map<
    string,
    {
      participant: StandingsParticipant;
      played: number;
      won: number;
      drawn: number;
      lost: number;
      pointsFor: number;
      pointsAgainst: number;
      points: number;
    }
  >();

  for (const p of participants) {
    stats.set(p.id, {
      participant: p,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      points: 0,
    });
  }

  // Aggregate results
  for (const match of results) {
    const home = stats.get(match.homeEntryId);
    const away = stats.get(match.awayEntryId);
    if (!home || !away) continue;

    home.played += 1;
    away.played += 1;
    home.pointsFor += match.homeScore;
    home.pointsAgainst += match.awayScore;
    away.pointsFor += match.awayScore;
    away.pointsAgainst += match.homeScore;

    if (match.homeScore > match.awayScore) {
      home.won += 1;
      home.points += winPts;
      away.lost += 1;
      away.points += lossPts;
    } else if (match.homeScore < match.awayScore) {
      away.won += 1;
      away.points += winPts;
      home.lost += 1;
      home.points += lossPts;
    } else {
      home.drawn += 1;
      home.points += drawPts;
      away.drawn += 1;
      away.points += drawPts;
    }
  }

  // Convert to sortable rows
  const rows = [...stats.values()].map((s) => ({
    entryId: s.participant.id,
    entryName: s.participant.name,
    seed: s.participant.seed,
    played: s.played,
    won: s.won,
    drawn: s.drawn,
    lost: s.lost,
    pointsFor: s.pointsFor,
    pointsAgainst: s.pointsAgainst,
    pointDifference: s.pointsFor - s.pointsAgainst,
    points: s.points,
  }));

  // Head-to-head lookup helper
  const getHeadToHeadPoints = (teamA: string, teamB: string): number => {
    let pts = 0;
    for (const match of results) {
      if (match.homeEntryId === teamA && match.awayEntryId === teamB) {
        if (match.homeScore > match.awayScore) pts += winPts;
        else if (match.homeScore === match.awayScore) pts += drawPts;
      } else if (match.awayEntryId === teamA && match.homeEntryId === teamB) {
        if (match.awayScore > match.homeScore) pts += winPts;
        else if (match.homeScore === match.awayScore) pts += drawPts;
      }
    }
    return pts;
  };

  // Sort rows based on primary hierarchy
  rows.sort((a, b) => {
    // 1. Total Points
    if (b.points !== a.points) return b.points - a.points;

    // 2. Head to Head
    const h2hA = getHeadToHeadPoints(a.entryId, b.entryId);
    const h2hB = getHeadToHeadPoints(b.entryId, a.entryId);
    if (h2hA !== h2hB) return h2hB - h2hA;

    // 3. Goal / Point Difference
    if (b.pointDifference !== a.pointDifference) return b.pointDifference - a.pointDifference;

    // 4. Points / Goals For
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;

    // 5. Seed
    if (a.seed !== b.seed) return a.seed - b.seed;

    // 6. Deterministic Entry ID
    return a.entryId.localeCompare(b.entryId);
  });

  // Assign ranks and detect sporting ties
  const rankedRows: ManualStandingsRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const curr = rows[i]!;
    const prev = i > 0 ? rows[i - 1]! : null;
    const next = i < rows.length - 1 ? rows[i + 1]! : null;

    const isTieWithPrev =
      prev !== null &&
      prev.points === curr.points &&
      prev.pointDifference === curr.pointDifference &&
      prev.pointsFor === curr.pointsFor &&
      getHeadToHeadPoints(prev.entryId, curr.entryId) === getHeadToHeadPoints(curr.entryId, prev.entryId);

    const isTieWithNext =
      next !== null &&
      next.points === curr.points &&
      next.pointDifference === curr.pointDifference &&
      next.pointsFor === curr.pointsFor &&
      getHeadToHeadPoints(curr.entryId, next.entryId) === getHeadToHeadPoints(next.entryId, curr.entryId);

    const sportingTie = isTieWithPrev || isTieWithNext;
    const rank = isTieWithPrev ? rankedRows[i - 1]!.rank : i + 1;

    rankedRows.push({
      ...curr,
      rank,
      sportingTie,
    });
  }

  return rankedRows;
}
