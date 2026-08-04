export type GateCC4ReferenceData = Readonly<{
  entries: readonly Readonly<{ id: string; division_id: string; name: string }>[];
  playing_areas: readonly Readonly<{ id: string; name: string }>[];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

export function parseGateCC4References(value: unknown): GateCC4ReferenceData | null {
  if (!record(value) || !Array.isArray(value.divisions) || !Array.isArray(value.capacity)) return null;
  const entries: Array<{ id: string; division_id: string; name: string }> = [];
  const playingAreas: Array<{ id: string; name: string }> = [];
  const entryIds = new Set<string>();
  const areaIds = new Set<string>();
  for (const division of value.divisions) {
    if (!record(division) || !uuid(division.id) || !Array.isArray(division.entries)) return null;
    for (const entry of division.entries) {
      if (
        !record(entry) ||
        !uuid(entry.id) ||
        entryIds.has(entry.id) ||
        typeof entry.name !== "string" ||
        entry.name.trim().length < 1
      ) {
        return null;
      }
      entryIds.add(entry.id);
      entries.push({ id: entry.id, division_id: division.id, name: entry.name });
    }
  }
  for (const area of value.capacity) {
    if (
      !record(area) ||
      !uuid(area.id) ||
      areaIds.has(area.id) ||
      typeof area.name !== "string" ||
      area.name.trim().length < 1
    ) {
      return null;
    }
    areaIds.add(area.id);
    playingAreas.push({ id: area.id, name: area.name });
  }
  return {
    entries: entries.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    playing_areas: playingAreas.sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
  };
}
