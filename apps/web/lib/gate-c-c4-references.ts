export type GateCC4ReferenceData = Readonly<{
  entries: readonly Readonly<{ id: string; division_id: string; name: string }>[];
  playing_areas: readonly Readonly<{ id: string; name: string }>[];
  matches: readonly Readonly<{ id: string; label: string; home: string; away: string }>[];
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

function matchReferences(value: unknown): GateCC4ReferenceData["matches"] | null {
  if (!Array.isArray(value)) return null;
  const matches: Array<{ id: string; label: string; home: string; away: string }> = [];
  const matchIds = new Set<string>();
  for (const match of value) {
    if (
      !record(match) ||
      !uuid(match.id) ||
      matchIds.has(match.id) ||
      typeof match.label !== "string" ||
      match.label.trim().length < 1 ||
      typeof match.home !== "string" ||
      match.home.trim().length < 1 ||
      typeof match.away !== "string" ||
      match.away.trim().length < 1
    ) {
      return null;
    }
    matchIds.add(match.id);
    matches.push({ id: match.id, label: match.label, home: match.home, away: match.away });
  }
  return matches;
}

function canonicalReferences(value: Record<string, unknown>): GateCC4ReferenceData | null {
  if (!Array.isArray(value.entries) || !Array.isArray(value.playing_areas)) return null;
  const entries: Array<{ id: string; division_id: string; name: string }> = [];
  const playingAreas: Array<{ id: string; name: string }> = [];
  const entryIds = new Set<string>();
  const areaIds = new Set<string>();
  const matches = matchReferences(value.matches);
  if (!matches) return null;

  for (const entry of value.entries) {
    if (
      !record(entry) ||
      !uuid(entry.id) ||
      entryIds.has(entry.id) ||
      !uuid(entry.division_id) ||
      typeof entry.name !== "string" ||
      entry.name.trim().length < 1
    ) {
      return null;
    }
    entryIds.add(entry.id);
    entries.push({ id: entry.id, division_id: entry.division_id, name: entry.name });
  }
  for (const area of value.playing_areas) {
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
    matches,
  };
}

function workspaceReferences(value: Record<string, unknown>): GateCC4ReferenceData | null {
  if (!Array.isArray(value.divisions) || !Array.isArray(value.capacity)) return null;
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
    matches: [],
  };
}

export function parseGateCC4References(value: unknown): GateCC4ReferenceData | null {
  if (!record(value)) return null;
  return canonicalReferences(value) ?? workspaceReferences(value);
}
