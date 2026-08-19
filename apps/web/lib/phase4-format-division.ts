export type FormatDivisionOption = Readonly<{ id: string; name: string }>;

export function formatDivisionOptions(
  primary: FormatDivisionOption,
  divisions: readonly FormatDivisionOption[] | undefined,
): readonly FormatDivisionOption[] {
  const unique = new Map<string, FormatDivisionOption>();
  for (const division of [primary, ...(divisions ?? [])]) {
    if (division.id && division.name && !unique.has(division.id)) unique.set(division.id, division);
  }
  return [...unique.values()];
}

export function selectFormatDivision(
  divisions: readonly FormatDivisionOption[],
  requestedDivision: unknown,
): FormatDivisionOption | null {
  if (requestedDivision === undefined) return divisions[0] ?? null;
  if (typeof requestedDivision !== "string" || !requestedDivision) return null;
  return divisions.find((division) => division.id === requestedDivision) ?? null;
}

export function formatDivisionHref(competitionId: string, divisionId: string, advanced = false): string {
  const query = new URLSearchParams(advanced ? { division: divisionId, advanced: "1" } : { division: divisionId });
  return `/organiser/competitions/${encodeURIComponent(competitionId)}/format?${query.toString()}`;
}
