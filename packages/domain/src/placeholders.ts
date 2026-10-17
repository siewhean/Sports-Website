export type PlaceholderGroupMembership = Readonly<{
  groupLabel: string;
  position: number;
}>;

export type PlaceholderEntryInput = Readonly<{
  id?: string;
  name?: string;
  entry_type?: "team" | "individual" | "placeholder" | string;
  seed?: number | null;
}>;

export type PlaceholderLabelOptions = Readonly<{
  entry: PlaceholderEntryInput;
  groupMembership?: PlaceholderGroupMembership | null | undefined;
  divisionShortCode?: string | null | undefined;
  multiDivision?: boolean | undefined;
  isPublic?: boolean | undefined;
  fallbackIndex?: number | undefined;
}>;

/**
 * Auto-suggests a division short code (1-4 characters, uppercase alphanumeric)
 * based on the division name, avoiding collisions against any existing codes in the competition.
 *
 * Examples:
 * - "Men's Open" -> "M"
 * - "Women's Open" -> "W"
 * - "Under 18" -> "U18"
 * - "Under 21" -> "U21"
 * - "Mixed Open" -> "X"
 * - Collisions append digits (e.g. "M", "M2", "M3") up to 4 characters.
 */
export function generateDivisionShortCode(divisionName: string, existingCodes: Iterable<string> = []): string {
  const trimmed = divisionName.trim();
  const taken = new Set(Array.from(existingCodes).map((c) => c.toUpperCase()));

  let baseCode = "";
  // Keep in step with the SQL backfill in migration 0077 ("Under 16", "Under-16", "U16", "U-16" -> "U16").
  const underMatch = /^(?:under[\s-]*|u-?)([0-9]+)/i.exec(trimmed);
  if (underMatch?.[1]) {
    baseCode = `U${underMatch[1]}`;
  } else if (/^men/i.test(trimmed)) {
    baseCode = "M";
  } else if (/^women/i.test(trimmed)) {
    baseCode = "W";
  } else if (/^mixed/i.test(trimmed)) {
    baseCode = "X";
  } else if (/^open/i.test(trimmed)) {
    baseCode = "O";
  } else if (/^boys/i.test(trimmed)) {
    baseCode = "B";
  } else if (/^girls/i.test(trimmed)) {
    baseCode = "G";
  } else {
    const alphanumeric = trimmed.replace(/[^a-zA-Z0-9]/g, "");
    baseCode = alphanumeric.length > 0 ? alphanumeric[0]!.toUpperCase() : "D";
  }

  baseCode = baseCode.toUpperCase().slice(0, 4);
  if (!baseCode) baseCode = "D";

  let candidate = baseCode;
  let suffix = 2;

  while (taken.has(candidate)) {
    const suffixStr = String(suffix);
    const prefixLen = Math.max(1, 4 - suffixStr.length);
    candidate = `${baseCode.slice(0, prefixLen)}${suffixStr}`;
    suffix += 1;
  }

  return candidate;
}

/**
 * Derives the display label for an entry per D16.
 *
 * Rules:
 * - Real entries (entry_type !== 'placeholder'): always return their real name.
 * - Placeholders before format: "Team 1" .. "Team N", or with multiple divisions "M-1" .. "M-N".
 * - Placeholders after format: group + position "A1, A2…", or multi-division "M-A1".
 * - Public surfaces show placeholders as "Team A1 (TBC)" or "Team M-A1 (TBC)".
 */
export function placeholderLabel(options: PlaceholderLabelOptions): string {
  const { entry, groupMembership, divisionShortCode, multiDivision, isPublic, fallbackIndex } = options;

  // Real teams always display their entered name
  if (entry.entry_type && entry.entry_type !== "placeholder") {
    return entry.name ?? "";
  }

  const prefix = multiDivision && divisionShortCode ? divisionShortCode.trim().toUpperCase() : null;

  if (groupMembership) {
    const groupPos = `${groupMembership.groupLabel.toUpperCase()}${groupMembership.position}`;
    if (isPublic) {
      const code = prefix ? `${prefix}-${groupPos}` : groupPos;
      return `Team ${code} (TBC)`;
    }
    return prefix ? `${prefix}-${groupPos}` : groupPos;
  }

  // Before format: use seed or fallback index
  const pos = entry.seed ?? fallbackIndex ?? 1;
  if (isPublic) {
    const code = prefix ? `${prefix}-${pos}` : `${pos}`;
    return `Team ${code} (TBC)`;
  }

  if (prefix) {
    return `${prefix}-${pos}`;
  }

  return `Team ${pos}`;
}

/** Minimal structural view of a published format graph needed to place entries into groups. */
export type PlaceholderFormatGraph = Readonly<{
  stages: ReadonlyArray<Readonly<{ id: string; kind?: string; order: number; groupIds?: readonly string[] }>>;
  matches: ReadonlyArray<
    Readonly<{
      stageId: string;
      poolId?: string | null | undefined;
      purpose?: string;
      home: Readonly<{ type: string; seed?: number }>;
      away: Readonly<{ type: string; seed?: number }>;
    }>
  >;
}>;

export type PlaceholderGroup = Readonly<{
  /** Graph pool/group id (or stage id for a single round-robin pool). Internal; never publish it. */
  graphGroupId: string;
  /** Positional letter ("A", "B", ... "Z", "A1", ...) in format-graph order. */
  label: string;
  /** Seeds placed in this group, ascending; position = index + 1. */
  seeds: readonly number[];
}>;

function groupLetter(index: number): string {
  return String.fromCharCode(65 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26)) : "");
}

/**
 * Derives the ordered groups of a format graph from the graph itself: stages in their `order`,
 * groups in the stage's own `groupIds` order, and each group's seeds from the `entry_seed`
 * sources of its pool matches. Letters are assigned sequentially in that order, so labels never
 * depend on database row ids.
 */
export function placeholderGroupsFromGraph(graph: PlaceholderFormatGraph | null | undefined): PlaceholderGroup[] {
  if (!graph || !Array.isArray(graph.stages) || !Array.isArray(graph.matches)) return [];
  const stages = [...graph.stages].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const seedsByGroup = new Map<string, Set<number>>();
  for (const match of graph.matches) {
    if (match.purpose !== undefined && match.purpose !== "pool") continue;
    const groupId = match.poolId ?? match.stageId;
    for (const source of [match.home, match.away]) {
      if (source?.type !== "entry_seed" || typeof source.seed !== "number") continue;
      const seeds = seedsByGroup.get(groupId) ?? new Set<number>();
      seeds.add(source.seed);
      seedsByGroup.set(groupId, seeds);
    }
  }
  const orderedGroupIds: string[] = [];
  const seen = new Set<string>();
  const push = (groupId: string) => {
    if (seen.has(groupId) || !seedsByGroup.has(groupId)) return;
    seen.add(groupId);
    orderedGroupIds.push(groupId);
  };
  for (const stage of stages) {
    for (const groupId of stage.groupIds ?? []) push(groupId);
    push(stage.id);
    // Pools the stage does not list (legacy graphs) follow its listed groups, in id order.
    const stray = graph.matches
      .filter((match) => match.stageId === stage.id && match.poolId && !seen.has(match.poolId))
      .map((match) => match.poolId as string)
      .sort();
    for (const groupId of stray) push(groupId);
  }
  const claimed = new Set<number>();
  const groups: PlaceholderGroup[] = [];
  for (const groupId of orderedGroupIds) {
    // A seed belongs to the first group (in graph order) that draws it.
    const seeds = [...seedsByGroup.get(groupId)!].filter((seed) => !claimed.has(seed)).sort((a, b) => a - b);
    if (seeds.length === 0) continue;
    for (const seed of seeds) claimed.add(seed);
    groups.push({ graphGroupId: groupId, label: groupLetter(groups.length), seeds });
  }
  return groups;
}

export type PlaceholderLabelEntry = Readonly<{
  id: string;
  name: string;
  entryType: string;
  seed: number | null;
  createdAt: string | Date;
}>;

export type PlaceholderLabelDivision = Readonly<{
  id: string;
  shortCode: string | null;
  entries: readonly PlaceholderLabelEntry[];
  /** The division's published format graph, or null before a format is published. */
  graph?: PlaceholderFormatGraph | null | undefined;
}>;

export type ResolvedPlaceholderLabel = Readonly<{
  divisionId: string;
  groupMembership: PlaceholderGroupMembership | null;
  /** Stable ordinal used before a format places the entry: its seed, else the lowest free number. */
  ordinal: number;
  organiserLabel: string;
  publicLabel: string;
}>;

function createdAtMillis(value: string | Date): number {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(millis) ? millis : 0;
}

/**
 * Single source of truth for placeholder labels across organiser and public surfaces.
 *
 * - Group letter and position come from the published format graph (see placeholderGroupsFromGraph)
 *   and the entry's seed, so moving an entry to another seed moves it to that seed's group slot.
 * - Entries the graph does not place use their seed, or (null seed) the lowest positive number not
 *   used by any seed in the division, assigned in creation order. Null-seed entries therefore never
 *   collapse onto one label, and the ordinal does not depend on the caller's row order.
 */
export function resolvePlaceholderLabels(
  divisions: readonly PlaceholderLabelDivision[],
): Map<string, ResolvedPlaceholderLabel> {
  const multiDivision = divisions.length > 1;
  const resolved = new Map<string, ResolvedPlaceholderLabel>();
  for (const division of divisions) {
    const membershipBySeed = new Map<number, PlaceholderGroupMembership>();
    for (const group of placeholderGroupsFromGraph(division.graph)) {
      group.seeds.forEach((seed, index) =>
        membershipBySeed.set(seed, { groupLabel: group.label, position: index + 1 }),
      );
    }
    const ordered = [...division.entries].sort(
      (a, b) => createdAtMillis(a.createdAt) - createdAtMillis(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const usedOrdinals = new Set(ordered.flatMap((entry) => (typeof entry.seed === "number" ? [entry.seed] : [])));
    let nextFree = 1;
    for (const entry of ordered) {
      let ordinal: number;
      if (typeof entry.seed === "number") {
        ordinal = entry.seed;
      } else {
        while (usedOrdinals.has(nextFree)) nextFree += 1;
        ordinal = nextFree;
        usedOrdinals.add(ordinal);
      }
      const groupMembership = typeof entry.seed === "number" ? (membershipBySeed.get(entry.seed) ?? null) : null;
      const labelEntry = { id: entry.id, name: entry.name, entry_type: entry.entryType, seed: ordinal };
      const shared = {
        entry: labelEntry,
        groupMembership,
        divisionShortCode: division.shortCode,
        multiDivision,
        fallbackIndex: ordinal,
      };
      resolved.set(entry.id, {
        divisionId: division.id,
        groupMembership,
        ordinal,
        organiserLabel: placeholderLabel(shared),
        publicLabel: placeholderLabel({ ...shared, isPublic: true }),
      });
    }
  }
  return resolved;
}

/**
 * Validates whether an incoming registration can replace a placeholder entry (Phase 12 guard).
 * Pending registrations never replace a placeholder; only approved registrations do.
 */
export function canRegistrationReplacePlaceholder(registrationStatus: string): boolean {
  return registrationStatus === "approved";
}
