const competitionSetupResumePrefix = "matchday:v1:competition-setup:last:";
const competitionSetupResumeVersion = 1;
const safeIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export type CompetitionSetupResume = Readonly<{
  competitionId: string;
  competitionName: string;
}>;

export function competitionSetupResumeStorageKey(accountId: string): string {
  return `${competitionSetupResumePrefix}${encodeURIComponent(accountId)}`;
}

export function serializeCompetitionSetupResume(value: CompetitionSetupResume): string {
  return JSON.stringify({
    version: competitionSetupResumeVersion,
    competitionId: value.competitionId,
    competitionName: value.competitionName,
  });
}

export function parseCompetitionSetupResume(raw: string | null): CompetitionSetupResume | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== competitionSetupResumeVersion ||
      typeof record.competitionId !== "string" ||
      !safeIdPattern.test(record.competitionId) ||
      typeof record.competitionName !== "string"
    )
      return null;
    const competitionName = record.competitionName.trim();
    if (!competitionName || competitionName.length > 160) return null;
    return { competitionId: record.competitionId, competitionName };
  } catch {
    return null;
  }
}

export function competitionSetupResumeHref(value: CompetitionSetupResume): string {
  return `/organiser/competitions/${encodeURIComponent(value.competitionId)}/setup`;
}
