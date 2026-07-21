export type CapacitySurfaceState =
  "ready" | "loading" | "empty" | "error" | "offline" | "permission" | "read-only" | "conflict";

export type CapacityWindowDraft = Readonly<{
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  crossMidnight: boolean;
  startsAt?: string;
  endsAt?: string;
}>;

export type CapacityAreaDraft = Readonly<{
  id: string;
  name: string;
  sortOrder: number;
  slotMinutes: number;
  fixedReserveSlots: number;
  availability: readonly CapacityWindowDraft[];
  unavailable: readonly CapacityWindowDraft[];
}>;

export type CapacitySummary = Readonly<{
  timeZone: string;
  slotMinutes: number;
  rawTotalSlots: number;
  fixedReserveSlots: number;
  availableMatchSlots: number;
  requiredMatchSlots: number;
  remainingMatchSlots: number;
  status: "comfortable" | "tight" | "does_not_fit";
  areas: readonly Readonly<{
    areaId: string;
    areaName: string;
    sortOrder: number;
    usableMinutes: number;
    rawSlots: number;
    intervalCount: number;
  }>[];
  intervals: readonly Readonly<{
    id: string;
    areaId: string;
    areaName: string;
    startEpochMs: number;
    endEpochMs: number;
    startIso: string;
    endIso: string;
    usableMinutes: number;
    slots: number;
    unusedMinutes: number;
    sourceAvailabilityIds: readonly string[];
  }>[];
}>;

export type ParsedCapacityResponse = Readonly<{
  revision: number;
  timezone: string;
  permission: "read" | "write";
  readOnly: boolean;
  areas: readonly CapacityAreaDraft[];
  effective: CapacitySummary;
  idempotentReplay?: boolean;
}>;

export type CapacityDocument = Readonly<{
  state: CapacitySurfaceState;
  competitionId: string;
  competitionName: string;
  canEdit: boolean;
  revision: number;
  timezone: string;
  summary: CapacitySummary | null;
  areas: readonly CapacityAreaDraft[];
}>;

export type CapacityMutationBody = Readonly<{
  revision: number;
  timezone: string;
  areas: readonly Readonly<{
    id: string;
    name: string;
    sort_order: number;
    slot_minutes: number;
    fixed_reserve_slots: number;
    availability: readonly Readonly<{
      id: string;
      date: string;
      start_time: string;
      end_time: string;
      cross_midnight?: boolean;
    }>[];
    unavailable: readonly Readonly<{
      id: string;
      date: string;
      start_time: string;
      end_time: string;
      cross_midnight?: boolean;
    }>[];
  }>[];
}>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function parseEffectiveArea(value: unknown): CapacitySummary["areas"][number] | null {
  const item = record(value);
  if (!item || !exactKeys(item, ["areaId", "areaName", "sortOrder", "usableMinutes", "rawSlots", "intervalCount"]))
    return null;
  if (
    !UUID.test(String(item.areaId)) ||
    !nonEmpty(item.areaName) ||
    !integer(item.sortOrder) ||
    !integer(item.usableMinutes) ||
    !integer(item.rawSlots) ||
    !integer(item.intervalCount)
  )
    return null;
  return item as CapacitySummary["areas"][number];
}

function parseEffectiveInterval(value: unknown): CapacitySummary["intervals"][number] | null {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, [
      "id",
      "areaId",
      "areaName",
      "startEpochMs",
      "endEpochMs",
      "startIso",
      "endIso",
      "usableMinutes",
      "slots",
      "unusedMinutes",
      "sourceAvailabilityIds",
    ])
  )
    return null;
  if (
    !nonEmpty(item.id) ||
    !UUID.test(String(item.areaId)) ||
    !nonEmpty(item.areaName) ||
    typeof item.startEpochMs !== "number" ||
    typeof item.endEpochMs !== "number" ||
    !nonEmpty(item.startIso) ||
    !nonEmpty(item.endIso) ||
    Number.isNaN(Date.parse(item.startIso)) ||
    Number.isNaN(Date.parse(item.endIso)) ||
    !integer(item.usableMinutes) ||
    !integer(item.slots) ||
    !integer(item.unusedMinutes) ||
    !Array.isArray(item.sourceAvailabilityIds) ||
    !item.sourceAvailabilityIds.every((id) => typeof id === "string" && UUID.test(id))
  )
    return null;
  return item as CapacitySummary["intervals"][number];
}

function parseSummary(value: unknown): CapacitySummary | null {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, [
      "timeZone",
      "slotMinutes",
      "rawTotalSlots",
      "fixedReserveSlots",
      "availableMatchSlots",
      "requiredMatchSlots",
      "remainingMatchSlots",
      "status",
      "intervals",
      "areas",
    ])
  )
    return null;
  const areas = Array.isArray(item.areas) ? item.areas.map(parseEffectiveArea) : [];
  const intervals = Array.isArray(item.intervals) ? item.intervals.map(parseEffectiveInterval) : [];
  if (
    !Array.isArray(item.areas) ||
    areas.some((area) => !area) ||
    !Array.isArray(item.intervals) ||
    intervals.some((interval) => !interval) ||
    !nonEmpty(item.timeZone) ||
    !integer(item.slotMinutes, 1) ||
    !integer(item.rawTotalSlots) ||
    !integer(item.fixedReserveSlots) ||
    !integer(item.availableMatchSlots) ||
    !integer(item.requiredMatchSlots) ||
    !Number.isSafeInteger(item.remainingMatchSlots) ||
    !["comfortable", "tight", "does_not_fit"].includes(String(item.status))
  )
    return null;
  return { ...item, areas, intervals } as unknown as CapacitySummary;
}

function parseWindow(value: unknown): CapacityWindowDraft | null {
  const item = record(value);
  if (!item || !exactKeys(item, ["id", "date", "start_time", "end_time", "cross_midnight", "starts_at", "ends_at"]))
    return null;
  if (
    !UUID.test(String(item.id)) ||
    !validDate(String(item.date)) ||
    !TIME.test(String(item.start_time)) ||
    !TIME.test(String(item.end_time)) ||
    typeof item.cross_midnight !== "boolean" ||
    !nonEmpty(item.starts_at) ||
    !nonEmpty(item.ends_at) ||
    Number.isNaN(Date.parse(item.starts_at)) ||
    Number.isNaN(Date.parse(item.ends_at))
  )
    return null;
  return {
    id: item.id as string,
    date: item.date as string,
    startTime: item.start_time as string,
    endTime: item.end_time as string,
    crossMidnight: item.cross_midnight,
    startsAt: item.starts_at,
    endsAt: item.ends_at,
  };
}

function parseSourceArea(value: unknown): CapacityAreaDraft | null {
  const item = record(value);
  if (
    !item ||
    !exactKeys(item, ["id", "name", "sort_order", "slot_minutes", "fixed_reserve_slots", "availability", "unavailable"])
  )
    return null;
  const availability = Array.isArray(item.availability) ? item.availability.map(parseWindow) : [];
  const unavailable = Array.isArray(item.unavailable) ? item.unavailable.map(parseWindow) : [];
  if (
    !UUID.test(String(item.id)) ||
    !nonEmpty(item.name) ||
    !item.name.trim() ||
    !integer(item.sort_order) ||
    !integer(item.slot_minutes, 1) ||
    item.slot_minutes > 1440 ||
    !integer(item.fixed_reserve_slots) ||
    !Array.isArray(item.availability) ||
    availability.some((window) => !window) ||
    !Array.isArray(item.unavailable) ||
    unavailable.some((window) => !window)
  )
    return null;
  return {
    id: item.id as string,
    name: item.name as string,
    sortOrder: item.sort_order as number,
    slotMinutes: item.slot_minutes as number,
    fixedReserveSlots: item.fixed_reserve_slots as number,
    availability: availability as CapacityWindowDraft[],
    unavailable: unavailable as CapacityWindowDraft[],
  };
}

export function parseCapacityResponse(payload: unknown, competitionId: string): ParsedCapacityResponse | null {
  const item = record(payload);
  if (!item || item.competition_id !== competitionId) return null;
  const baseKeys = ["competition_id", "revision", "timezone", "permission", "read_only", "areas", "effective"];
  const allowedKeys = item.idempotent_replay === undefined ? baseKeys : [...baseKeys, "idempotent_replay"];
  if (!exactKeys(item, allowedKeys)) return null;
  const areas = Array.isArray(item.areas) ? item.areas.map(parseSourceArea) : [];
  const effective = parseSummary(item.effective);
  if (
    !integer(item.revision, 1) ||
    !nonEmpty(item.timezone) ||
    (item.permission !== "read" && item.permission !== "write") ||
    typeof item.read_only !== "boolean" ||
    (item.permission === "read") !== item.read_only ||
    !Array.isArray(item.areas) ||
    areas.some((area) => !area) ||
    !effective ||
    effective.timeZone !== item.timezone ||
    (item.idempotent_replay !== undefined && typeof item.idempotent_replay !== "boolean")
  )
    return null;
  const identifiers = areas.flatMap((area) => [
    area!.id,
    ...area!.availability.map((window) => window.id),
    ...area!.unavailable.map((window) => window.id),
  ]);
  if (new Set(identifiers).size !== identifiers.length) return null;
  return {
    revision: item.revision,
    timezone: item.timezone,
    permission: item.permission,
    readOnly: item.read_only,
    areas: areas as CapacityAreaDraft[],
    effective,
    ...(item.idempotent_replay === undefined ? {} : { idempotentReplay: item.idempotent_replay as boolean }),
  };
}

export function validateCapacityDraft(areas: readonly CapacityAreaDraft[]): Readonly<Record<string, string>> {
  const issues: Record<string, string> = {};
  if (areas.length === 0) issues.areas = "Add at least one playing area.";
  if (new Set(areas.map((area) => area.slotMinutes)).size > 1)
    issues.slotMinutes = "Every area must use the same match slot duration.";
  const identifiers = areas.flatMap((area) => [
    area.id,
    ...area.availability.map((window) => window.id),
    ...area.unavailable.map((window) => window.id),
  ]);
  if (identifiers.some((id) => !UUID.test(id)) || new Set(identifiers).size !== identifiers.length)
    issues.identifiers = "Capacity identifiers must be unique.";
  areas.forEach((area, areaIndex) => {
    if (!area.name.trim()) issues[`area-${areaIndex}-name`] = "Enter an area name.";
    if (!integer(area.slotMinutes, 1) || area.slotMinutes > 1440)
      issues[`area-${areaIndex}-slot`] = "Use 1–1440 minutes.";
    if (!integer(area.fixedReserveSlots)) issues[`area-${areaIndex}-reserve`] = "Use zero or more reserve slots.";
    if (area.availability.length === 0) issues[`area-${areaIndex}-availability`] = "Add an available window.";
    (["availability", "unavailable"] as const).forEach((kind) => {
      area[kind].forEach((window, windowIndex) => {
        const key = `area-${areaIndex}-${kind}-${windowIndex}`;
        if (!validDate(window.date) || !TIME.test(window.startTime) || !TIME.test(window.endTime))
          issues[key] = "Use a valid date and local 24-hour times.";
        else if (!window.crossMidnight && window.endTime <= window.startTime)
          issues[key] = "End must be later, or mark the window as crossing midnight.";
      });
    });
  });
  return issues;
}

export function capacityMutationBody(
  revision: number,
  timezone: string,
  areas: readonly CapacityAreaDraft[],
): CapacityMutationBody {
  const windowBody = (window: CapacityWindowDraft) => ({
    id: window.id,
    date: window.date,
    start_time: window.startTime,
    end_time: window.endTime,
    ...(window.crossMidnight ? { cross_midnight: true } : {}),
  });
  return {
    revision,
    timezone,
    areas: areas.map((area) => ({
      id: area.id,
      name: area.name.trim(),
      sort_order: area.sortOrder,
      slot_minutes: area.slotMinutes,
      fixed_reserve_slots: area.fixedReserveSlots,
      availability: area.availability.map(windowBody),
      unavailable: area.unavailable.map(windowBody),
    })),
  };
}

export function isCapacityMutationBody(value: unknown): value is CapacityMutationBody {
  const body = record(value);
  if (
    !body ||
    !exactKeys(body, ["revision", "timezone", "areas"]) ||
    !integer(body.revision, 1) ||
    !nonEmpty(body.timezone) ||
    !Array.isArray(body.areas) ||
    body.areas.length === 0
  )
    return false;
  const areas = body.areas.map((area) => {
    const item = record(area);
    if (
      !item ||
      !exactKeys(item, [
        "id",
        "name",
        "sort_order",
        "slot_minutes",
        "fixed_reserve_slots",
        "availability",
        "unavailable",
      ])
    )
      return null;
    const parseMutationWindow = (candidate: unknown) => {
      const window = record(candidate);
      if (!window) return null;
      const keys =
        window.cross_midnight === undefined
          ? ["id", "date", "start_time", "end_time"]
          : ["id", "date", "start_time", "end_time", "cross_midnight"];
      if (
        !exactKeys(window, keys) ||
        !UUID.test(String(window.id)) ||
        !validDate(String(window.date)) ||
        !TIME.test(String(window.start_time)) ||
        !TIME.test(String(window.end_time)) ||
        (window.cross_midnight !== undefined && typeof window.cross_midnight !== "boolean") ||
        (window.cross_midnight !== true && String(window.end_time) <= String(window.start_time))
      )
        return null;
      return window;
    };
    const availability = Array.isArray(item.availability) ? item.availability.map(parseMutationWindow) : [];
    const unavailable = Array.isArray(item.unavailable) ? item.unavailable.map(parseMutationWindow) : [];
    if (
      !UUID.test(String(item.id)) ||
      !nonEmpty(item.name) ||
      !item.name.trim() ||
      !integer(item.sort_order) ||
      !integer(item.slot_minutes, 1) ||
      item.slot_minutes > 1440 ||
      !integer(item.fixed_reserve_slots) ||
      !Array.isArray(item.availability) ||
      item.availability.length === 0 ||
      availability.some((window) => !window) ||
      !Array.isArray(item.unavailable) ||
      unavailable.some((window) => !window)
    )
      return null;
    return { id: item.id as string, slotMinutes: item.slot_minutes as number, availability, unavailable };
  });
  if (areas.some((area) => !area) || new Set(areas.map((area) => area!.slotMinutes)).size !== 1) return false;
  const identifiers = areas.flatMap((area) => [
    area!.id,
    ...area!.availability.map((window) => window!.id),
    ...area!.unavailable.map((window) => window!.id),
  ]);
  return new Set(identifiers).size === identifiers.length;
}

export const phase3CapacityCopy = {
  title: "Capacity",
  intro: "Define continuous local-time windows for each playing area. Break remnants are never combined.",
  eyebrow: "Competition calendar",
  playingAreas: "Playing areas",
  addArea: "Add playing area",
  areaName: "Area name",
  slotMinutes: "Match slot (minutes)",
  reserveSlots: "Reserve slots",
  availableWindows: "Available windows",
  unavailableWindows: "Unavailable periods",
  addWindow: "Add window",
  addBreak: "Add unavailable period",
  remove: "Remove",
  date: "Date",
  starts: "Starts",
  ends: "Ends",
  crossMidnight: "Ends the next day",
  save: "Save capacity",
  saving: "Saving…",
  saved: "Capacity saved",
  unsaved: "Unsaved capacity changes",
  revision: "Capacity revision",
  timezone: "Source timezone",
  status: "Capacity status",
  available: "Available match slots",
  required: "Required match slots",
  remaining: "Remaining slots",
  comfortable: "Comfortable",
  tight: "Tight",
  does_not_fit: "Does not fit",
  permissionTitle: "Capacity is read-only",
  permissionBody: "Your membership can review capacity but cannot replace it.",
  errorTitle: "Capacity could not be loaded",
  errorBody: "The saved capacity was not changed.",
  offlineTitle: "Capacity is offline",
  offlineBody: "Reconnect before editing competition capacity.",
  emptyTitle: "No capacity configured",
  emptyBody: "Add the first playing area and its available window.",
  conflictTitle: "Capacity changed elsewhere",
  conflictBody: "Reload the current capacity, then review your changes before saving again.",
  commandFailed: "Capacity was not saved. Review the response and try again.",
  reviewFields: "Review the highlighted capacity fields before saving.",
  loading: "Loading saved capacity",
  loadingSection: "Loading competition capacity or results",
} as const;

export const phase3CapacityMachine = {
  section: "capacity" as const,
  put: "PUT" as const,
  applicationJson: "application/json" as const,
  requestInvalid: "REQUEST_INVALID" as const,
  invalidCommand: "Invalid capacity command",
  ready: "ready" as const,
  saved: "saved" as const,
  offline: "offline" as const,
  permission: "permission" as const,
  conflict: "conflict" as const,
  readOnly: "read-only" as const,
  unavailable: "unavailable" as const,
} as const;

export function removeAreaLabel(name: string): string {
  return `Remove ${name}`;
}
