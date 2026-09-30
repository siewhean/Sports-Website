import { civilMinuteAtEpoch } from "@matchday/domain";
import { phase4OfficialsCopy } from "./phase4-officials";

export type MatchTimeInterval = {
  startEpochMs: number;
  endEpochMs: number;
};

export function getMatchScheduledInterval(
  matchId: string,
  scheduleAssignments?: readonly { matchId: string; startsAt: string; endsAt: string }[] | null,
): MatchTimeInterval | null {
  if (!scheduleAssignments) return null;
  const assignment = scheduleAssignments.find((a) => a.matchId === matchId);
  if (!assignment) return null;
  const start = Date.parse(assignment.startsAt);
  const end = Date.parse(assignment.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
  return { startEpochMs: start, endEpochMs: end };
}

export function officialAvailabilityConflict(
  official: { name: string; id: string },
  windows: readonly { startsAt: string; endsAt: string }[] | undefined,
  matchInterval: MatchTimeInterval | null,
): string | null {
  if (!matchInterval) return null;
  if (!windows || windows.length === 0) {
    return phase4OfficialsCopy.conflictOfficialUnavailable(official.name);
  }

  const isCovered = windows.some((w) => {
    const wStart = Date.parse(w.startsAt);
    const wEnd = Date.parse(w.endsAt);
    if (!Number.isFinite(wStart) || !Number.isFinite(wEnd)) return false;
    return wStart <= matchInterval.startEpochMs && matchInterval.endEpochMs <= wEnd;
  });

  if (!isCovered) {
    return phase4OfficialsCopy.conflictOfficialUnavailable(official.name);
  }

  return null;
}

export function officialOverlapConflicts(
  official: { name: string; id: string },
  selectedMatchId: string,
  selectedInterval: MatchTimeInterval | null,
  allAssignments: readonly { matchId: string; officialId: string }[],
  scheduleAssignments: readonly { matchId: string; startsAt: string; endsAt: string }[] | null | undefined,
  matches: readonly { id: string; code: string }[],
): string[] {
  if (!selectedInterval || !scheduleAssignments) return [];

  const otherAssignments = allAssignments.filter((a) => a.officialId === official.id && a.matchId !== selectedMatchId);

  const conflicts: string[] = [];
  const seenMatchIds = new Set<string>();

  for (const other of otherAssignments) {
    if (seenMatchIds.has(other.matchId)) continue;
    const otherInterval = getMatchScheduledInterval(other.matchId, scheduleAssignments);
    if (!otherInterval) continue;

    // Half-open interval overlap check: [startA, endA) and [startB, endB)
    // Overlap condition: startA < endB && startB < endA
    if (
      selectedInterval.startEpochMs < otherInterval.endEpochMs &&
      otherInterval.startEpochMs < selectedInterval.endEpochMs
    ) {
      seenMatchIds.add(other.matchId);
      const otherMatch = matches.find((m) => m.id === other.matchId);
      const otherCode = otherMatch?.code ?? other.matchId;
      conflicts.push(phase4OfficialsCopy.conflictOfficialOverlap(official.name, otherCode));
    }
  }

  return conflicts;
}

export function formatMatchOptionLabel(match: {
  code: string;
  roundLabel?: string;
  homeLabel?: string;
  awayLabel?: string;
  divisionName?: string;
}): string {
  const details: string[] = [];
  if (match.roundLabel) details.push(match.roundLabel);
  if (match.homeLabel && match.awayLabel) {
    details.push(`${match.homeLabel} vs ${match.awayLabel}`);
  }
  if (match.divisionName) details.push(match.divisionName);

  if (details.length > 0) {
    return `${match.code} — ${details.join(" · ")}`;
  }
  return match.code;
}

export type ScheduledMatchSummary = {
  isScheduled: boolean;
  text: string;
  dateStr?: string;
  timeStr?: string;
  areaName?: string;
};

export function formatScheduledMatchSummary(
  assignment: { startsAt: string; endsAt: string; areaId: string } | null | undefined,
  areas: readonly { id: string; name: string }[] | undefined,
  timeZone: string,
): ScheduledMatchSummary {
  if (!assignment) {
    return {
      isScheduled: false,
      text: phase4OfficialsCopy.currentlyUnscheduled,
    };
  }

  const startEpoch = Date.parse(assignment.startsAt);
  const endEpoch = Date.parse(assignment.endsAt);
  if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)) {
    return {
      isScheduled: false,
      text: phase4OfficialsCopy.currentlyUnscheduled,
    };
  }

  const startCivil = civilMinuteAtEpoch(startEpoch, timeZone);
  const endCivil = civilMinuteAtEpoch(endEpoch, timeZone);

  const dateFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const dateStr = dateFormatter.format(new Date(startEpoch));
  const timeStr = `${startCivil.time}–${endCivil.time}`;
  const areaName = areas?.find((a) => a.id === assignment.areaId)?.name ?? assignment.areaId;

  return {
    isScheduled: true,
    dateStr,
    timeStr,
    areaName,
    text: phase4OfficialsCopy.matchScheduledSummary(dateStr, timeStr, areaName),
  };
}
