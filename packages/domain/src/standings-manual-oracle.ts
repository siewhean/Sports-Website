/**
 * Independent manual standings calculation oracle for QA-002 and QA-021.
 *
 * This implementation is deliberately simple, transparent, and built from first
 * principles to serve as an independent reference calculation during pilots and
 * automated verification.
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

  // Sort primarily by points desc, then goal/point diff desc, then pointsFor desc
  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.pointDifference !== a.pointDifference) return b.pointDifference - a.pointDifference;
    if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    return a.entryId.localeCompare(b.entryId);
  });

  // Assign ranks & detect sporting ties
  let currentRank = 1;
  const resultRows: ManualStandingsRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i]!;
    const next = rows[i + 1];

    const isTiedWithPrev =
      prev !== undefined &&
      prev.points === curr.points &&
      prev.pointDifference === curr.pointDifference &&
      prev.pointsFor === curr.pointsFor;

    const isTiedWithNext =
      next !== undefined &&
      next.points === curr.points &&
      next.pointDifference === curr.pointDifference &&
      next.pointsFor === curr.pointsFor;

    if (!isTiedWithPrev) {
      currentRank = i + 1;
    }

    resultRows.push({
      ...curr,
      rank: currentRank,
      sportingTie: isTiedWithPrev || isTiedWithNext,
    });
  }

  return resultRows;
}
