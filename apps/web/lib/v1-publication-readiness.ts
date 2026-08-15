import type { CompetitionView } from "./phase2";

export type V1PublicationReadiness = Readonly<{
  totalMatches: number;
  finalMatches: number;
  liveMatches: number;
  scheduledMatches: number;
  scheduleVersion: number;
  resultVersion: number;
  schedulePublished: boolean;
  resultsPublished: boolean;
  tournamentComplete: boolean;
  publicAvailable: boolean;
}>;

function publicationVersions(value: string): { scheduleVersion: number; resultVersion: number } {
  const match = /^sch_(\d+) · res_(\d+)$/.exec(value);
  if (!match) return { scheduleVersion: 0, resultVersion: 0 };
  return {
    scheduleVersion: Number(match[1]),
    resultVersion: Number(match[2]),
  };
}

export function v1PublicationReadiness(competition: CompetitionView): V1PublicationReadiness {
  const totalMatches = competition.matches.length;
  const finalMatches = competition.matches.filter((match) => match.status === "final").length;
  const liveMatches = competition.matches.filter((match) => match.status === "live").length;
  const scheduledMatches = totalMatches - finalMatches - liveMatches;
  const { scheduleVersion, resultVersion } = publicationVersions(competition.publicationRevision);
  const schedulePublished = scheduleVersion > 0;
  const resultsPublished = resultVersion > 0;
  return {
    totalMatches,
    finalMatches,
    liveMatches,
    scheduledMatches,
    scheduleVersion,
    resultVersion,
    schedulePublished,
    resultsPublished,
    tournamentComplete: totalMatches > 0 && finalMatches === totalMatches,
    publicAvailable: schedulePublished || resultsPublished,
  };
}
