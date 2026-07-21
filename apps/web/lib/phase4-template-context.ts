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
