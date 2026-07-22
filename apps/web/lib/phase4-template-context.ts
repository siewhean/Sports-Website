const supportedSports = new Set(["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"]);

export function isLaunchSportCode(value: string): boolean {
  return supportedSports.has(value);
}

export type FormatTemplateCompetitionContext = Readonly<{
  competitionId: string;
  organisationId: string;
  sportCode: string;
}>;

export function competitionIdFromFormatReferer(referer: string | null, expectedOrigin: string): string | null {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    if (url.origin !== expectedOrigin) return null;
    const match = /^\/organiser\/competitions\/([^/]+)\/format\/?$/.exec(url.pathname);
    if (!match) return null;
    const competitionId = decodeURIComponent(match[1]!);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(competitionId)
      ? competitionId
      : null;
  } catch {
    return null;
  }
}

export function parseFormatTemplateCompetitionContext(
  value: unknown,
  expectedCompetitionId: string,
): FormatTemplateCompetitionContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source =
    record.competition && typeof record.competition === "object" && !Array.isArray(record.competition)
      ? (record.competition as Record<string, unknown>)
      : record;
  if (
    source.id !== expectedCompetitionId ||
    typeof source.organisation_id !== "string" ||
    typeof source.sport_code !== "string" ||
    !isLaunchSportCode(source.sport_code)
  )
    return null;
  return {
    competitionId: expectedCompetitionId,
    organisationId: source.organisation_id,
    sportCode: source.sport_code,
  };
}
