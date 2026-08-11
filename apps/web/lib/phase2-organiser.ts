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
  permission: "read" | "write";
  read_only: boolean;
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

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function records(value: unknown): WorkspaceRecord[] {
  return Array.isArray(value) ? value.flatMap((item) => (record(item) ? [item as WorkspaceRecord] : [])) : [];
}

function supportedSportCode(value: unknown): value is SupportedSportCode {
  return typeof value === "string" && Object.hasOwn(sportLabels, value);
}

function validWorkspaceDivision(value: unknown): boolean {
  const division = record(value);
  if (!division || !string(division.id) || !string(division.name) || !Array.isArray(division.entries)) return false;
  return division.entries.every((rawEntry) => {
    const entry = record(rawEntry);
    return Boolean(
      entry &&
      string(entry.id) &&
      string(entry.name) &&
      (entry.seed === null || (Number.isInteger(entry.seed) && (entry.seed as number) >= 1)) &&
      Number.isInteger(entry.revision) &&
      typeof entry.status === "string" &&
      ["active", "confirmed", "withdrawn", "replaced"].includes(entry.status),
    );
  });
}

function validPrivateScheduleMatch(value: unknown): boolean {
  const match = record(value);
  if (!match || !["pending", "ready", "in_progress", "final", "corrected"].includes(String(match.state))) {
    return false;
  }
  if (match.state === "final" || match.state === "corrected") {
    return (
      nonNegativeInteger(match.home_score) !== null &&
      nonNegativeInteger(match.away_score) !== null &&
      nonNegativeInteger(match.result_version) !== null &&
      Number(match.result_version) >= 1
    );
  }
  const hasNoResult = match.home_score === null && match.away_score === null && match.result_version === null;
  const hasRetainedResult =
    match.state === "in_progress" &&
    nonNegativeInteger(match.home_score) !== null &&
    nonNegativeInteger(match.away_score) !== null &&
    nonNegativeInteger(match.result_version) !== null &&
    Number(match.result_version) >= 1;
  return hasNoResult || hasRetainedResult;
}

function validPrivateSchedule(value: unknown): boolean {
  if (value === null) return true;
  const schedule = record(value);
  return Boolean(
    schedule && Array.isArray(schedule.matches) && schedule.matches.every((match) => validPrivateScheduleMatch(match)),
  );
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
    payload.divisions.every(validWorkspaceDivision) &&
    Array.isArray(payload.capacity) &&
    Array.isArray(payload.access_passes) &&
    validPrivateSchedule(payload.private_schedule) &&
    (payload.permission === "read" || payload.permission === "write") &&
    typeof payload.read_only === "boolean",
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

type ParticipantSource = {
  type: string;
  entryId?: string;
  seed?: number;
  groupId?: string;
  rank?: number;
  matchId?: string;
};

function participantLabel(
  value: unknown,
  entries: ReadonlyMap<string, string>,
  entriesBySeed: ReadonlyMap<number, string>,
  matchCodes: ReadonlyMap<string, string>,
): string {
  const source = record(value) as ParticipantSource | null;
  if (!source) return "TBD";
  if (source.type === "entry" && source.entryId) return entries.get(source.entryId) ?? "TBD";
  // V1 direct-format graphs keep their stable, portable entry_seed sources in
  // the published definition. Resolve them against the organiser's current
  // division snapshot instead of showing a misleading TBD for a scheduled
  // group fixture whose participants are already known.
  if (source.type === "entry_seed" && Number.isSafeInteger(source.seed) && (source.seed ?? 0) > 0)
    return entriesBySeed.get(source.seed!) ?? "TBD";
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
  if (!supportedSportCode(competition.sport_code)) throw new Error("Competition sport is missing or unsupported");
  const sportCode = competition.sport_code;
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
  const entryNamesBySeed = new Map(
    entries.flatMap((entry) => {
      const seed = nonNegativeInteger(entry.seed);
      const name = string(entry.name);
      return seed && name ? [[seed, name] as const] : [];
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
  // A materialised schedule assigns database UUIDs to matches, while the
  // authored format graph keeps portable match IDs. The stable code links the
  // two representations for organiser display and scorer-pass selection.
  const formatByCode = new Map(
    formatMatches.flatMap((match) => {
      const code = string(match.code) ?? string(match.id);
      return code ? [[code, match] as const] : [];
    }),
  );
  const schedule = records(payload.private_schedule?.matches);
  const matches: MatchView[] = schedule.map((match) => {
    const id = string(match.match_id) ?? string(match.id) ?? "unknown-match";
    const formatMatch = formatById.get(id) ?? formatByCode.get(string(match.code) ?? "");
    if (!validPrivateScheduleMatch(match)) {
      throw new Error(`Private schedule match ${id} has an invalid scoring state`);
    }
    const state = String(match.state);
    const status: MatchView["status"] =
      state === "final" || state === "corrected" ? "final" : state === "in_progress" ? "live" : "scheduled";
    const homeScore = nonNegativeInteger(match.home_score);
    const awayScore = nonNegativeInteger(match.away_score);
    const resultVersion = nonNegativeInteger(match.result_version);
    return {
      id,
      label: string(match.code) ?? id,
      stage: titleCase(string(match.stage) ?? "scheduled"),
      time: time(match.starts_at, timezone),
      area: string(match.area) ?? "—",
      // The graph describes potential participants, while materialisation fills
      // the match slots after an advancement result. Prefer those authoritative
      // persisted entry IDs so organiser access controls expose resolved rounds.
      home:
        entryNames.get(string(match.home_entry_id) ?? "") ??
        participantLabel(formatMatch?.home, entryNames, entryNamesBySeed, matchCodes),
      away:
        entryNames.get(string(match.away_entry_id) ?? "") ??
        participantLabel(formatMatch?.away, entryNames, entryNamesBySeed, matchCodes),
      ...(homeScore === null ? {} : { homeScore }),
      ...(awayScore === null ? {} : { awayScore }),
      ...(resultVersion === null ? {} : { resultVersion }),
      status,
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
      const entryLimit = number(division.team_limit);
      const divisionEntries = records(division.entries).flatMap((entry) => {
        const entryId = string(entry.id);
        const entryName = string(entry.name);
        const status = string(entry.status);
        const seed = number(entry.seed);
        const revision = number(entry.revision);
        return entryId && entryName && status && revision !== null
          ? [{ id: entryId, name: entryName, seed, status, revision }]
          : [];
      });
      return id && name
        ? [
            {
              id,
              name,
              ...(entryLimit === null ? {} : { entryLimit }),
              entries: divisionEntries,
            },
          ]
        : [];
    }),
    teams: entries.flatMap((entry) => (string(entry.name) ? [string(entry.name)!] : [])),
    areas,
    matches,
    standings: [],
    bracket: [],
    audit: [],
    scheduleRows: scheduleRows(matches, areas, schedule),
    accessPasses: records(payload.access_passes).flatMap((pass) => {
      const id = string(pass.id);
      const matchId = string(pass.match_id);
      const role = pass.role;
      if (!id || !matchId || (role !== "viewer" && role !== "scorekeeper")) return [];
      const revoked = Boolean(pass.revoked_at ?? pass.revoked);
      const expiresAt = string(pass.expires_at);
      const expired = expiresAt ? Date.parse(expiresAt) <= Date.now() : true;
      const fallbackCodeStatus =
        pass.fallback_code_status === "available" ||
        pass.fallback_code_status === "rotation_required" ||
        pass.fallback_code_status === "unavailable"
          ? pass.fallback_code_status
          : undefined;
      return [
        {
          id,
          matchId,
          role,
          displayCode: "••••••••••••",
          expiresAt: dateTime(pass.expires_at, timezone),
          revoked,
          status: revoked ? "revoked" : expired ? "expired" : "active",
          ...(fallbackCodeStatus ? { fallbackCodeStatus } : {}),
        },
      ];
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
    canEdit: payload.permission === "write" && !payload.read_only,
  };
}
