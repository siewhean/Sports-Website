import type { CompetitionView, MatchView } from "./phase2";

type WorkspaceRecord = Record<string, unknown>;

export type OrganiserWorkspacePayload = {
  competition: WorkspaceRecord;
  settings: WorkspaceRecord | null;
  divisions: WorkspaceRecord[];
  capacity: WorkspaceRecord[];
  current_format: WorkspaceRecord | null;
  private_schedule: WorkspaceRecord | null;
  publication: WorkspaceRecord | null;
  access_passes: WorkspaceRecord[];
};

const sportLabels = {
  canoe_polo: "Canoe Polo",
  badminton: "Badminton",
  table_tennis: "Table Tennis",
  volleyball: "Volleyball",
  basketball: "Basketball",
} as const;

type SupportedSportCode = keyof typeof sportLabels;

function record(value: unknown): WorkspaceRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as WorkspaceRecord) : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function records(value: unknown): WorkspaceRecord[] {
  return Array.isArray(value) ? value.flatMap((item) => (record(item) ? [item as WorkspaceRecord] : [])) : [];
}

function supportedSportCode(value: unknown): value is SupportedSportCode {
  return typeof value === "string" && Object.hasOwn(sportLabels, value);
}

export function isOrganiserWorkspacePayload(value: unknown): value is OrganiserWorkspacePayload {
  const payload = record(value);
  const competition = record(payload?.competition);
  return Boolean(
    payload &&
      competition &&
      string(competition.id) &&
      string(competition.name) &&
      string(competition.slug) &&
      supportedSportCode(competition.sport_code) &&
      string(competition.timezone) &&
      string(competition.starts_on) &&
      string(competition.ends_on) &&
      Array.isArray(payload.divisions) &&
      Array.isArray(payload.capacity) &&
      Array.isArray(payload.access_passes),
  );
}

export function cookieHostMatches(requestHostHeader: string | null, apiHostname: string): boolean {
  if (!requestHostHeader) return false;
  try {
    const requestHostname = new URL(`http://${requestHostHeader}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const normalizedApiHostname = apiHostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (requestHostname === normalizedApiHostname) return true;
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
    return loopbackHosts.has(requestHostname) && loopbackHosts.has(normalizedApiHostname);
  } catch {
    return false;
  }
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateTime(value: unknown, timezone: string): string {
  const source = string(value);
  if (!source) return "—";
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime())) return source;
  try {
    return new Intl.DateTimeFormat("en-SG", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
      timeZone: timezone,
    }).format(parsed);
  } catch {
    return parsed.toISOString();
  }
}

function dateOnly(value: unknown): string {
  const source = string(value);
  if (!source) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
  if (!match) return source;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-SG", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function dateRange(startsOn: unknown, endsOn: unknown): string {
  const start = dateOnly(startsOn);
  const end = dateOnly(endsOn);
  return start === end ? start : `${start}–${end}`;
}

function time(value: unknown, timezone: string): string {
  const source = string(value);
  if (!source) return "—";
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime())) return source;
  try {
    return new Intl.DateTimeFormat("en-SG", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(parsed);
  } catch {
    return source;
  }
}

function setting(value: unknown, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value}${suffix}` : "—";
}

function capacityView(value: WorkspaceRecord, timezone: string, slotMinutes: number | null) {
  const windows = records(value.windows);
  const slotCount = slotMinutes
    ? windows.reduce((total, window) => {
        const start = new Date(string(window.starts_at) ?? "");
        const end = new Date(string(window.ends_at) ?? "");
        const minutes = (end.getTime() - start.getTime()) / 60_000;
        return total + (Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes / slotMinutes) : 0);
      }, 0)
    : null;
  return {
    name: string(value.name) ?? "—",
    availability:
      windows.map((window) => `${time(window.starts_at, timezone)}–${time(window.ends_at, timezone)}`).join(" · ") ||
      "—",
    slotCount,
  };
}

function scheduleRows(
  matches: readonly MatchView[],
  areas: readonly string[],
  rawSchedule: readonly WorkspaceRecord[],
) {
  const rows = new Map<string, { id: string; time: string; matches: MatchView[] }>();
  matches.forEach((match, index) => {
    const startsAt = string(rawSchedule[index]?.starts_at);
    const key = startsAt ?? `${match.id}-${index}`;
    const row = rows.get(key) ?? { id: key, time: match.time, matches: [] };
    row.matches.push(match);
    rows.set(key, row);
  });
  return [...rows.values()].map((row) => ({
    id: row.id,
    time: row.time,
    cells: areas.map((area) =>
      row.matches
        .filter((match) => match.area === area)
        .map((match) => `${match.label} · ${match.stage}`)
        .join(" / "),
    ),
  }));
}

type ParticipantSource = { type: string; entryId?: string; groupId?: string; rank?: number; matchId?: string };

function participantLabel(
  value: unknown,
  entries: ReadonlyMap<string, string>,
  matchCodes: ReadonlyMap<string, string>,
): string {
  const source = record(value) as ParticipantSource | null;
  if (!source) return "TBD";
  if (source.type === "entry" && source.entryId) return entries.get(source.entryId) ?? "TBD";
  if (source.type === "group_rank" && source.groupId && typeof source.rank === "number") {
    return `Group ${source.groupId} #${source.rank}`;
  }
  if ((source.type === "winner" || source.type === "loser") && source.matchId) {
    return `${titleCase(source.type)} ${matchCodes.get(source.matchId) ?? source.matchId}`;
  }
  return "TBD";
}

export function toOrganiserCompetitionView(payload: OrganiserWorkspacePayload): CompetitionView {
  const competition = payload.competition;
  const timezone = string(competition.timezone) ?? "UTC";
  const sportCode = supportedSportCode(competition.sport_code) ? competition.sport_code : "canoe_polo";
  const divisions = records(payload.divisions);
  const primaryDivision = divisions[0] ?? {};
  const entries = records(primaryDivision.entries);
  const entryNames = new Map(
    entries.flatMap((entry) => {
      const id = string(entry.id);
      const name = string(entry.name);
      return id && name ? [[id, name] as const] : [];
    }),
  );
  const formatDefinition = record(payload.current_format?.definition);
  const formatMatches = records(formatDefinition?.matches);
  const matchCodes = new Map(
    formatMatches.flatMap((match) => {
      const id = string(match.id);
      return id ? [[id, string(match.code) ?? id] as const] : [];
    }),
  );
  const formatById = new Map(
    formatMatches.flatMap((match) => (string(match.id) ? [[string(match.id)!, match] as const] : [])),
  );
  const schedule = records(payload.private_schedule?.matches);
  const matches: MatchView[] = schedule.map((match) => {
    const id = string(match.match_id) ?? string(match.id) ?? "unknown-match";
    const formatMatch = formatById.get(id);
    return {
      id,
      label: string(match.code) ?? id,
      stage: titleCase(string(match.stage) ?? "scheduled"),
      time: time(match.starts_at, timezone),
      area: string(match.area) ?? "—",
      home: participantLabel(formatMatch?.home, entryNames, matchCodes),
      away: participantLabel(formatMatch?.away, entryNames, matchCodes),
      status: "scheduled",
    };
  });
  const areas = [
    ...new Set([
      ...records(payload.capacity).flatMap((area) => (string(area.name) ? [string(area.name)!] : [])),
      ...matches.flatMap((match) => (match.area === "—" ? [] : [match.area])),
    ]),
  ];
  const publication = payload.publication;
  const settings = payload.settings;
  const slotMinutes = number(settings?.slot_minutes);
  const capacityAreas = records(payload.capacity).map((area) => capacityView(area, timezone, slotMinutes));
  const scheduleVersion = number(publication?.schedule_version) ?? 0;
  const resultVersion = number(publication?.result_version) ?? 0;
  const isPublished = Boolean(publication && (scheduleVersion > 0 || resultVersion > 0));
  const updatedAt = competition.updated_at ?? publication?.updated_at ?? competition.created_at;
  const formatSummary: ReadonlyArray<readonly [string, string]> = payload.current_format
    ? [
        ["Format revision", setting(payload.current_format.revision)],
        ["Groups", setting(records(formatDefinition?.groups).length)],
        ["Matches", setting(formatMatches.length)],
        [
          "Knockout stages",
          [
            ...new Set(
              formatMatches.flatMap((match) => {
                const stage = string(match.stage);
                return !stage || stage === "group" ? [] : [titleCase(stage)];
              }),
            ),
          ].join(" · ") || "—",
        ],
      ]
    : [];

  return {
    id: string(competition.id)!,
    slug: string(competition.slug)!,
    name: string(competition.name)!,
    sportCode,
    sport: sportLabels[sportCode],
    venue: areas.join(" · ") || string(primaryDivision.name) || "—",
    timezone,
    dateLabel: dateRange(competition.starts_on, competition.ends_on),
    publicationRevision: isPublished ? `sch_${scheduleVersion} · res_${resultVersion}` : "Not published",
    publishedAt: isPublished
      ? dateTime(publication?.schedule_published_at ?? publication?.results_published_at, timezone)
      : "—",
    lastUpdated: dateTime(updatedAt, timezone),
    division: {
      id: string(primaryDivision.id) ?? "unassigned",
      name: string(primaryDivision.name) ?? "No division",
      teamCount: entries.length,
      matchCount: matches.length,
    },
    divisions: divisions.flatMap((division) => {
      const id = string(division.id);
      const name = string(division.name);
      return id && name ? [{ id, name }] : [];
    }),
    teams: entries.flatMap((entry) => (string(entry.name) ? [string(entry.name)!] : [])),
    areas,
    matches,
    standings: [],
    bracket: [],
    audit: [],
    scheduleRows: scheduleRows(matches, areas, schedule),
    accessPasses: records(payload.access_passes).flatMap((pass) => {
      const matchId = string(pass.match_id);
      if (!matchId) return [];
      return [{ matchId, displayCode: "••••-••", expiresAt: dateTime(pass.expires_at, timezone) }];
    }),
    settings: settings
      ? [
          ["Periods", setting(settings.period_count)],
          ["Period length", setting(settings.period_minutes, " minutes")],
          ["Match slot", setting(settings.slot_minutes, " minutes")],
          [
            "Points",
            `${setting(settings.points_win)} · ${setting(settings.points_draw)} · ${setting(settings.points_loss)}`,
          ],
          ["Tie-break order", Array.isArray(settings.tiebreak_order) ? settings.tiebreak_order.join(" · ") : "—"],
        ]
      : [],
    capacityAreas,
    availableCapacity: slotMinutes ? capacityAreas.reduce((total, area) => total + (area.slotCount ?? 0), 0) : null,
    publishedVersionLabel: isPublished ? `Schedule ${scheduleVersion} · Results ${resultVersion}` : undefined,
    publicationState: isPublished ? "published" : "draft",
    formatSummary,
  };
}
