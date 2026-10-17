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
  groupMembership?: PlaceholderGroupMembership | null;
  divisionShortCode?: string | null;
  multiDivision?: boolean;
  isPublic?: boolean;
  fallbackIndex?: number;
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
  const underMatch = /^(?:under\s*|u-?)([0-9]+)/i.exec(trimmed);
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

/**
 * Validates whether an incoming registration can replace a placeholder entry (Phase 12 guard).
 * Pending registrations never replace a placeholder; only approved registrations do.
 */
export function canRegistrationReplacePlaceholder(registrationStatus: string): boolean {
  return registrationStatus === "approved";
}
