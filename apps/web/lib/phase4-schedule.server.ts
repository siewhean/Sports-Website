import "server-only";

import { interpolate } from "@matchday/ui";
import { cookies, headers } from "next/headers";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { cookieHostMatches } from "@/lib/phase2-organiser";
import {
  phase4ScheduleCopy,
  parseScheduleJobView,
  parseScheduleRevisionView,
  parseScheduleRevisionComparison,
  selectComparableScheduleOptions,
  surfaceStateFromStatus,
  type QualityComponent,
  type ScheduleDocument,
  type ScheduleObjective,
  type ScheduleOption,
  type ScheduleRevision,
  type ScheduleRevisionComparison,
  type ScheduleSurfaceState,
} from "@/lib/phase4-schedule";

const previewStates = new Set<ScheduleSurfaceState>([
  "ready",
  "read-only",
  "permission",
  "offline",
  "error",
  "loading",
  "empty",
]);

type ScheduleInput = Readonly<{
  competitionId: string;
  competitionName: string;
  timeZone: string;
  publicationRevision: string;
  previewState?: string;
}>;

function apiBaseUrl(): URL | null {
  const configured = process.env.MATCHDAY_API_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function sessionCookieHeader(apiUrl: URL): Promise<string | null> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() || requestHeaders.get("host");
  if (!cookieHostMatches(host, apiUrl.hostname)) return null;
  const store = await cookies();
  for (const name of ["__Host-matchday_session", "matchday_session"] as const) {
    const value = store.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

export function scheduleUnavailableDocument(input: ScheduleInput, state: ScheduleSurfaceState): ScheduleDocument {
  return {
    state,
    competitionId: input.competitionId,
    competitionName: input.competitionName,
    timeZone: input.timeZone,
    publicationRevision: input.publicationRevision,
    sourceRevision: 1,
    capacityRevision: 1,
    constraints: {},
    canEdit: false,
    canPublish: false,
    activeJob: null,
    currentRevision: null,
    revisions: [],
    alternatives: [],
    areas: [],
    slots: [],
    matches: [],
    locks: [],
    warnings: [],
  };
}

export async function getScheduleDocument(input: ScheduleInput): Promise<ScheduleDocument> {
  const preview =
    input.previewState && previewStates.has(input.previewState as ScheduleSurfaceState)
      ? (input.previewState as ScheduleSurfaceState)
      : null;
  if (demoFixturesEnabled()) return demoDocument(input, preview ?? "ready");
  if (preview && preview !== "ready" && process.env.NODE_ENV !== "production")
    return scheduleUnavailableDocument(input, preview);
  const base = apiBaseUrl();
  if (!base) return scheduleUnavailableDocument(input, "error");
  const cookie = await sessionCookieHeader(base);
  if (!cookie) return scheduleUnavailableDocument(input, "permission");
  try {
    const response = await fetch(
      new URL(`/api/v1/competitions/${encodeURIComponent(input.competitionId)}/schedule-workspace`, base),
      { cache: "no-store", headers: { accept: "application/json", cookie } },
    );
    if (!response.ok) return scheduleUnavailableDocument(input, surfaceStateFromStatus(response.status));
    const payload: unknown = await response.json();
    const parsed = parseScheduleWorkspace(payload, input);
    if (!parsed) return scheduleUnavailableDocument(input, "error");
    const jobsResponse = await fetch(
      new URL(`/api/v1/competitions/${encodeURIComponent(input.competitionId)}/schedule-jobs`, base),
      { cache: "no-store", headers: { accept: "application/json", cookie } },
    );
    if (!jobsResponse.ok) return parsed;
    const jobsPayload: unknown = await jobsResponse.json();
    if (!Array.isArray(jobsPayload)) return parsed;
    const jobs = jobsPayload
      .map((job) => parseScheduleJobView(job))
      .filter((job): job is NonNullable<typeof job> => job !== null);
    const comparable = selectComparableScheduleOptions(jobs, parsed.sourceRevision, parsed.capacityRevision);
    return { ...parsed, alternatives: comparable };
  } catch {
    return scheduleUnavailableDocument(input, "offline");
  }
}

export function parseScheduleWorkspace(value: unknown, input: ScheduleInput): ScheduleDocument | null {
  const root = record(value);
  if (
    !root ||
    !exact(root, [
      "competition",
      "generation",
      "areas",
      "matches",
      "active_job",
      "current_revision",
      "revisions",
      "locks",
      "warnings",
    ])
  )
    return null;
  const competition = record(root.competition);
  const generation = record(root.generation);
  if (
    !competition ||
    !exact(competition, ["id", "name", "time_zone", "status", "permission", "read_only", "publication"]) ||
    competition.id !== input.competitionId ||
    typeof competition.name !== "string" ||
    typeof competition.time_zone !== "string" ||
    typeof competition.status !== "string" ||
    competition.permission !== "write" ||
    typeof competition.read_only !== "boolean"
  )
    return null;
  const publication = record(competition.publication);
  if (
    !publication ||
    !exact(publication, ["schedule_version", "published_schedule_revision_id"]) ||
    !integer(publication.schedule_version) ||
    (publication.published_schedule_revision_id !== null &&
      typeof publication.published_schedule_revision_id !== "string")
  )
    return null;
  if (
    !generation ||
    !exact(generation, [
      "source_revision",
      "capacity_revision",
      "capacity_hash",
      "objective",
      "format_revisions",
      "constraints",
    ]) ||
    !integer(generation.source_revision, 1) ||
    !integer(generation.capacity_revision, 1) ||
    typeof generation.capacity_hash !== "string" ||
    !["fastest", "balanced", "rest_focused"].includes(String(generation.objective)) ||
    !Array.isArray(generation.format_revisions) ||
    !validFormatRevisions(generation.format_revisions) ||
    !validConstraints(generation.constraints)
  )
    return null;
  if (
    !Array.isArray(root.areas) ||
    !Array.isArray(root.matches) ||
    !Array.isArray(root.revisions) ||
    !Array.isArray(root.locks) ||
    !Array.isArray(root.warnings)
  )
    return null;

  const areas: Array<ScheduleDocument["areas"][number]> = [];
  const slots: Array<ScheduleDocument["slots"][number]> = [];
  for (const value of root.areas) {
    const area = record(value);
    if (
      !area ||
      !exact(area, ["id", "name", "type", "slot_minutes", "slots"]) ||
      typeof area.id !== "string" ||
      typeof area.name !== "string" ||
      area.type !== "playing_area" ||
      !integer(area.slot_minutes, 1) ||
      !Array.isArray(area.slots)
    )
      return null;
    areas.push({ id: area.id, name: area.name, kind: "playing_area" });
    for (const value of area.slots) {
      const slot = record(value);
      if (
        !slot ||
        !exact(slot, ["id", "interval_id", "start_epoch_ms", "end_epoch_ms"]) ||
        typeof slot.id !== "string" ||
        typeof slot.interval_id !== "string" ||
        !integer(slot.start_epoch_ms) ||
        !integer(slot.end_epoch_ms, 1) ||
        slot.end_epoch_ms <= slot.start_epoch_ms
      )
        return null;
      slots.push({
        id: slot.id,
        intervalId: slot.interval_id,
        areaId: area.id,
        startsAt: new Date(slot.start_epoch_ms).toISOString(),
        endsAt: new Date(slot.end_epoch_ms).toISOString(),
        available: true,
        disabledReason: null,
      });
    }
  }
  const currentRevision =
    root.current_revision === null ? null : parseScheduleRevisionView(root.current_revision, true);
  if (root.current_revision !== null && !currentRevision) return null;
  const revisions = root.revisions.map((revision) => parseScheduleRevisionView(revision));
  if (revisions.some((revision) => !revision)) return null;
  const activeJob = root.active_job === null ? null : parseScheduleJobView(root.active_job);
  if (root.active_job !== null && !activeJob) return null;
  const assigned = new Set(currentRevision?.assignments.map((assignment) => assignment.matchId) ?? []);
  const matches: Array<ScheduleDocument["matches"][number]> = [];
  for (const value of root.matches) {
    const match = record(value);
    if (
      !match ||
      !exact(match, [
        "id",
        "division_id",
        "division_name",
        "round",
        "label",
        "stage",
        "home",
        "away",
        "duration_minutes",
        "dependency_match_ids",
        "status",
      ]) ||
      ![
        match.id,
        match.division_id,
        match.division_name,
        match.label,
        match.stage,
        match.home,
        match.away,
        match.status,
      ].every((field) => typeof field === "string") ||
      !integer(match.round, 1) ||
      !integer(match.duration_minutes, 1) ||
      !Array.isArray(match.dependency_match_ids) ||
      !match.dependency_match_ids.every((id) => typeof id === "string")
    )
      return null;
    matches.push({
      id: match.id as string,
      divisionId: match.division_id as string,
      divisionName: match.division_name as string,
      roundLabel: `${match.stage} ${match.round}`,
      code: match.label as string,
      homeLabel: match.home as string,
      awayLabel: match.away as string,
      durationMinutes: match.duration_minutes as number,
      dependencyMatchIds: match.dependency_match_ids as string[],
      status:
        match.status === "complete" || match.status === "completed"
          ? "complete"
          : match.status === "conflict"
            ? "conflict"
            : assigned.has(match.id as string)
              ? "scheduled"
              : "unscheduled",
    });
  }
  const locks: Array<ScheduleDocument["locks"][number]> = [];
  for (const value of root.locks) {
    const lock = record(value);
    if (
      !lock ||
      !exact(lock, [
        "id",
        "match_id",
        "source_schedule_revision_id",
        "playing_area_id",
        "start_epoch_ms",
        "end_epoch_ms",
        "locked_by",
        "created_at",
      ]) ||
      typeof lock.id !== "string" ||
      typeof lock.match_id !== "string" ||
      (lock.source_schedule_revision_id !== null && typeof lock.source_schedule_revision_id !== "string") ||
      typeof lock.playing_area_id !== "string" ||
      !integer(lock.start_epoch_ms) ||
      !integer(lock.end_epoch_ms, 1) ||
      lock.end_epoch_ms <= lock.start_epoch_ms ||
      typeof lock.locked_by !== "string" ||
      !iso(lock.created_at)
    )
      return null;
    locks.push({
      matchId: lock.match_id,
      areaId: lock.playing_area_id,
      startsAt: new Date(lock.start_epoch_ms).toISOString(),
      endsAt: new Date(lock.end_epoch_ms).toISOString(),
    });
  }
  const warnings: Array<ScheduleDocument["warnings"][number]> = [];
  for (const value of root.warnings) {
    const warning = record(value);
    if (
      !warning ||
      !exact(warning, ["id", "schedule_revision_id", "warning_days", "expires_at", "emitted_at"]) ||
      typeof warning.id !== "string" ||
      typeof warning.schedule_revision_id !== "string" ||
      (warning.warning_days !== 1 && warning.warning_days !== 7) ||
      !iso(warning.expires_at) ||
      !iso(warning.emitted_at)
    )
      return null;
    warnings.push({
      code: warning.warning_days === 1 ? "expires_tomorrow" : "expires_soon",
      message: interpolate(phase4ScheduleCopy.draftExpires, {
        date: new Intl.DateTimeFormat("en-SG", { dateStyle: "long", timeZone: competition.time_zone as string }).format(
          new Date(warning.expires_at),
        ),
      }),
      daysRemaining: warning.warning_days,
    });
  }
  const canEdit = !competition.read_only && competition.permission === "write";
  return {
    state: competition.read_only ? "read-only" : "ready",
    competitionId: competition.id,
    competitionName: competition.name as string,
    timeZone: competition.time_zone as string,
    publicationRevision: String(publication.schedule_version),
    sourceRevision: generation.source_revision,
    capacityRevision: generation.capacity_revision,
    constraints: generation.constraints as Record<string, unknown>,
    canEdit,
    canPublish: canEdit && currentRevision?.status === "ready_for_review",
    activeJob,
    currentRevision,
    revisions: revisions as ScheduleRevision[],
    alternatives: activeJob?.currentBest ? [activeJob.currentBest] : [],
    areas,
    slots,
    matches,
    locks,
    warnings,
  };
}

export async function getScheduleRevisionDetail(
  document: ScheduleDocument,
  revisionId: string,
): Promise<ScheduleRevision | null> {
  if (demoFixturesEnabled()) return document.revisions.find((revision) => revision.id === revisionId) ?? null;
  const base = apiBaseUrl();
  if (!base) return null;
  const cookie = await sessionCookieHeader(base);
  if (!cookie) return null;
  try {
    const response = await fetch(new URL(`/api/v1/schedule-revisions/${encodeURIComponent(revisionId)}`, base), {
      cache: "no-store",
      headers: { accept: "application/json", cookie },
    });
    if (!response.ok) return null;
    return parseScheduleRevisionView(await response.json(), true);
  } catch {
    return null;
  }
}

export async function getScheduleRevisionComparison(
  document: ScheduleDocument,
  leftId: string,
  rightId: string,
): Promise<ScheduleRevisionComparison | null> {
  const local = () => {
    const left = document.revisions.find((revision) => revision.id === leftId) ?? null;
    const right = document.revisions.find((revision) => revision.id === rightId) ?? null;
    if (!left || !right) return null;
    const leftByMatch = new Map(left.assignments.map((assignment) => [assignment.matchId, assignment]));
    const rightByMatch = new Map(right.assignments.map((assignment) => [assignment.matchId, assignment]));
    const changedMatchIds = [...new Set([...leftByMatch.keys(), ...rightByMatch.keys()])].filter(
      (id) => JSON.stringify(leftByMatch.get(id) ?? null) !== JSON.stringify(rightByMatch.get(id) ?? null),
    );
    const movedMatchIds = changedMatchIds.filter((id) => leftByMatch.has(id) && rightByMatch.has(id));
    const finish = (revision: ScheduleRevision) =>
      revision.assignments.length
        ? Math.max(...revision.assignments.map((assignment) => Date.parse(assignment.endsAt)))
        : null;
    const beforeFinish = finish(left);
    const afterFinish = finish(right);
    const beforeRest = left.quality?.minimumRestMinutes ?? null;
    const afterRest = right.quality?.minimumRestMinutes ?? null;
    const beforeConflicts = left.quality?.requiredViolationCount ?? 0;
    const afterConflicts = right.quality?.requiredViolationCount ?? 0;
    return {
      left,
      right,
      changedMatchIds,
      movedMatchIds,
      scheduledMatchDelta: right.assignments.length - left.assignments.length,
      minimumRestMinutes: {
        before: beforeRest,
        after: afterRest,
        delta: beforeRest === null || afterRest === null ? null : afterRest - beforeRest,
      },
      completion: {
        beforeEpochMs: beforeFinish,
        afterEpochMs: afterFinish,
        deltaMinutes: beforeFinish === null || afterFinish === null ? null : (afterFinish - beforeFinish) / 60_000,
      },
      conflicts: { before: beforeConflicts, after: afterConflicts, delta: afterConflicts - beforeConflicts },
    } satisfies ScheduleRevisionComparison;
  };
  if (demoFixturesEnabled()) return local();
  const base = apiBaseUrl();
  if (!base) return null;
  const cookie = await sessionCookieHeader(base);
  if (!cookie) return null;
  try {
    const response = await fetch(
      new URL(`/api/v1/schedule-revisions/${encodeURIComponent(leftId)}/compare/${encodeURIComponent(rightId)}`, base),
      { cache: "no-store", headers: { accept: "application/json", cookie } },
    );
    if (!response.ok) return null;
    return parseScheduleRevisionComparison(await response.json());
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validFormatRevisions(values: readonly unknown[]): boolean {
  return values.every((value) => {
    const item = record(value);
    return Boolean(
      item &&
      exact(item, ["division_id", "format_revision_id", "definition_hash", "revision"]) &&
      typeof item.division_id === "string" &&
      typeof item.format_revision_id === "string" &&
      typeof item.definition_hash === "string" &&
      integer(item.revision, 1),
    );
  });
}

function validConstraints(value: unknown): value is Record<string, unknown> {
  const constraints = record(value);
  const names = [
    "minimum_rest",
    "maximum_matches_per_day",
    "preferred_final_time",
    "entry_unavailable",
    "official_availability",
    "featured_playing_area",
    "avoid_consecutive_matches",
    "balance_early_matches",
    "balance_late_matches",
    "keep_division_together",
    "preserve_existing_schedule",
  ];
  if (!constraints || !exact(constraints, names)) return false;
  return (
    validSetting(constraints.minimum_rest, (item) => exact(item, ["minutes"]) && integer(item.minutes)) &&
    validSetting(constraints.maximum_matches_per_day, (item) => exact(item, ["matches"]) && integer(item.matches, 1)) &&
    validSetting(
      constraints.preferred_final_time,
      (item) =>
        exact(item, ["target_start_epoch_ms", "tolerance_minutes"]) &&
        integer(item.target_start_epoch_ms) &&
        integer(item.tolerance_minutes),
    ) &&
    validSetting(constraints.entry_unavailable, validAvailabilityMap("by_entry_id")) &&
    validSetting(constraints.official_availability, validAvailabilityMap("by_official_id")) &&
    validSetting(
      constraints.featured_playing_area,
      (item) =>
        exact(item, ["area_id", "match_ids"]) &&
        typeof item.area_id === "string" &&
        Array.isArray(item.match_ids) &&
        item.match_ids.every((id) => typeof id === "string"),
    ) &&
    validSetting(constraints.avoid_consecutive_matches, (item) => exact(item, ["minutes"]) && integer(item.minutes)) &&
    validSetting(constraints.balance_early_matches, validLocalTime("before_local_time")) &&
    validSetting(constraints.balance_late_matches, validLocalTime("at_or_after_local_time")) &&
    validSetting(
      constraints.keep_division_together,
      (item) => exact(item, ["maximum_area_count"]) && integer(item.maximum_area_count, 1),
    ) &&
    validSetting(constraints.preserve_existing_schedule, validExistingSchedule)
  );
}

function validSetting(value: unknown, validateValue: (value: Record<string, unknown>) => boolean): boolean {
  const setting = record(value);
  if (
    !setting ||
    !exact(
      setting,
      Object.prototype.hasOwnProperty.call(setting, "weight") ? ["mode", "value", "weight"] : ["mode", "value"],
    ) ||
    !["required", "preferred", "ignored"].includes(String(setting.mode)) ||
    (setting.weight !== undefined && !integer(setting.weight, 1))
  )
    return false;
  const nested = record(setting.value);
  return Boolean(nested && validateValue(nested));
}

function validAvailabilityMap(key: string): (value: Record<string, unknown>) => boolean {
  return (value) => {
    if (!exact(value, [key])) return false;
    const byId = record(value[key]);
    return Boolean(
      byId &&
      Object.values(byId).every(
        (intervals) =>
          Array.isArray(intervals) &&
          intervals.every((interval) => {
            const item = record(interval);
            return Boolean(
              item &&
              exact(item, ["start_epoch_ms", "end_epoch_ms"]) &&
              integer(item.start_epoch_ms) &&
              integer(item.end_epoch_ms, 1) &&
              item.end_epoch_ms > item.start_epoch_ms,
            );
          }),
      ),
    );
  };
}

function validLocalTime(key: string): (value: Record<string, unknown>) => boolean {
  return (value) =>
    exact(value, [key]) && typeof value[key] === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value[key]);
}

function validExistingSchedule(value: Record<string, unknown>): boolean {
  if (!exact(value, ["maximum_shift_minutes", "by_match_id"]) || !integer(value.maximum_shift_minutes)) return false;
  const byMatch = record(value.by_match_id);
  return Boolean(
    byMatch &&
    Object.values(byMatch).every((assignment) => {
      const item = record(assignment);
      return Boolean(
        item &&
        exact(item, ["area_id", "start_epoch_ms"]) &&
        typeof item.area_id === "string" &&
        integer(item.start_epoch_ms),
      );
    }),
  );
}

function scheduleConstraints(): Readonly<Record<string, unknown>> {
  return {
    minimum_rest: { mode: "preferred", value: { minutes: 60 }, weight: 4 },
    maximum_matches_per_day: { mode: "required", value: { matches: 4 } },
    preferred_final_time: {
      mode: "preferred",
      value: { target_start_epoch_ms: Date.parse("2026-08-15T07:00:00.000Z"), tolerance_minutes: 30 },
      weight: 3,
    },
    entry_unavailable: { mode: "ignored", value: { by_entry_id: {} } },
    official_availability: { mode: "ignored", value: { by_official_id: {} } },
    featured_playing_area: {
      mode: "preferred",
      value: { area_id: "20000000-0000-4000-8000-000000000001", match_ids: [] },
      weight: 1,
    },
    avoid_consecutive_matches: { mode: "preferred", value: { minutes: 30 }, weight: 4 },
    balance_early_matches: { mode: "preferred", value: { before_local_time: "09:00" }, weight: 2 },
    balance_late_matches: { mode: "preferred", value: { at_or_after_local_time: "16:00" }, weight: 2 },
    keep_division_together: { mode: "preferred", value: { maximum_area_count: 2 }, weight: 2 },
    preserve_existing_schedule: { mode: "ignored", value: { maximum_shift_minutes: 0, by_match_id: {} } },
  };
}

function quality(
  objective: ScheduleObjective,
  duration: number,
  rest: number,
  score: number,
): ScheduleOption["quality"] {
  const components: QualityComponent[] = [
    {
      key: "completion",
      score: 100,
      weight: 5,
      measured: 100,
      unit: "percent",
      explanation: "Every match has an authoritative slot.",
    },
    {
      key: "rest",
      score: Math.min(100, rest),
      weight: objective === "rest_focused" ? 8 : 4,
      measured: rest,
      unit: "minutes",
      explanation: `${rest} minutes minimum rest between possible entry appearances.`,
    },
    {
      key: "daily_balance",
      score: 92,
      weight: 3,
      measured: 4,
      unit: "matches",
      explanation: "No entry exceeds four matches in one day.",
    },
    {
      key: "preferred_final",
      score: 88,
      weight: 3,
      measured: 15,
      unit: "minutes",
      explanation: "The final starts within the preferred window.",
    },
    {
      key: "featured_area",
      score: 100,
      weight: 1,
      measured: 100,
      unit: "percent",
      explanation: "Featured matches use Pool A.",
    },
    {
      key: "consecutive",
      score: 90,
      weight: 4,
      measured: 1,
      unit: "matches",
      explanation: "One unavoidable consecutive-match preference remains.",
    },
    {
      key: "time_balance",
      score: 87,
      weight: 3,
      measured: 87,
      unit: "percent",
      explanation: "Early and late starts are balanced across entries.",
    },
    {
      key: "division_cohesion",
      score: 100,
      weight: 2,
      measured: 2,
      unit: "areas",
      explanation: "Each division stays within two areas.",
    },
    {
      key: "schedule_preservation",
      score: 100,
      weight: 0,
      measured: 0,
      unit: "matches",
      explanation: "0 of 8 existing assignments move; total start-time shift is 0 minutes with 0 playing-area changes.",
    },
    {
      key: "entry_availability",
      score: 100,
      weight: 5,
      measured: 100,
      unit: "percent",
      explanation: "All entry availability is respected.",
    },
    {
      key: "official_availability",
      score: 100,
      weight: 0,
      measured: 100,
      unit: "percent",
      explanation: "Official availability is not configured for this draft.",
    },
  ];
  return {
    score,
    objective,
    valid: true,
    makespanMinutes: duration,
    minimumRestMinutes: rest,
    maximumMatchesPerEntryDay: 4,
    preferredFinalDeltaMinutes: 15,
    requiredViolationCount: 0,
    preferredPenalty: 5,
    components,
  };
}

function demoDocument(input: ScheduleInput, state: ScheduleSurfaceState): ScheduleDocument {
  if (!["ready", "read-only"].includes(state)) return scheduleUnavailableDocument(input, state);
  const areaA = "20000000-0000-4000-8000-000000000001";
  const areaB = "20000000-0000-4000-8000-000000000002";
  const intervalA = "21000000-0000-4000-8000-000000000001";
  const intervalB = "21000000-0000-4000-8000-000000000002";
  const base = Date.parse("2026-08-15T00:00:00.000Z");
  const ids = Array.from(
    { length: 10 },
    (_, index) => `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const slots = [areaA, areaB].flatMap((areaId, areaIndex) =>
    Array.from({ length: areaIndex === 0 ? 18 : 22 }, (_, index) => ({
      id: `${areaIndex ? intervalB : intervalA}:${index + 1}`,
      intervalId: areaIndex ? intervalB : intervalA,
      areaId,
      startsAt: new Date(
        base + (index < 18 ? index * 30 * 60_000 : 24 * 60 * 60_000 + (index - 18) * 30 * 60_000),
      ).toISOString(),
      endsAt: new Date(
        base + (index < 18 ? (index + 1) * 30 * 60_000 : 24 * 60 * 60_000 + (index - 17) * 30 * 60_000),
      ).toISOString(),
      available: index !== 11,
      disabledReason: index === 11 ? "Dependency conflict" : null,
    })),
  );
  const assignments = ids.slice(0, 8).map((matchId, index) => {
    const areaId = index % 2 ? areaB : areaA;
    const slotIndex = index + Math.floor(index / 2);
    const slot = slots.find((candidate) => candidate.areaId === areaId && candidate.id.endsWith(`:${slotIndex + 1}`))!;
    return {
      matchId,
      divisionId: "40000000-0000-4000-8000-000000000001",
      areaId,
      intervalId: slot.intervalId,
      slotId: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      fixed: index < 2,
    };
  });
  const option = (
    objective: ScheduleObjective,
    index: number,
    duration: number,
    rest: number,
    score: number,
  ): ScheduleOption => ({
    id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    jobId: "60000000-0000-4000-8000-000000000001",
    jobRevision: 5,
    resultRevision: index + 1,
    objective,
    quality: quality(objective, duration, rest, score),
    assignments,
    violations: [],
    assignmentHash: `${String(index + 1).repeat(64)}`,
    createdAt: "2026-07-20T04:22:00.000Z",
  });
  const alternatives = [
    option("fastest", 0, 510, 30, 82),
    option("balanced", 1, 600, 60, 91),
    option("rest_focused", 2, 690, 90, 88),
  ];
  const revision = {
    id: "70000000-0000-4000-8000-000000000004",
    revision: 4,
    parentRevisionId: "70000000-0000-4000-8000-000000000003",
    status: "ready_for_review" as const,
    editableUntil: "2026-08-19T04:22:00.000Z",
    publishedAt: null,
    expiredAt: null,
    createdAt: "2026-07-20T04:22:00.000Z",
    updatedAt: "2026-07-20T04:24:30.000Z",
    quality: alternatives[1]!.quality,
    assignments,
    violations: [],
  };
  const priorAssignments = assignments.map((assignment, index) =>
    index === assignments.length - 1
      ? {
          ...assignment,
          startsAt: new Date(Date.parse(assignment.startsAt) - 30 * 60_000).toISOString(),
          endsAt: new Date(Date.parse(assignment.endsAt) - 30 * 60_000).toISOString(),
        }
      : assignment,
  );
  return {
    state,
    competitionId: input.competitionId,
    competitionName: input.competitionName,
    timeZone: input.timeZone,
    publicationRevision: input.publicationRevision,
    sourceRevision: 4,
    capacityRevision: 2,
    constraints: scheduleConstraints(),
    canEdit: state === "ready",
    canPublish: state === "ready",
    activeJob: {
      id: alternatives[1]!.jobId,
      revision: 5,
      sourceRevision: 4,
      capacityRevision: 2,
      status: "completed",
      objective: "balanced",
      currentBest: alternatives[1]!,
      progressIteration: 12,
      exploredCandidates: 13,
      progressUpdatedAt: "2026-07-20T04:22:00.000Z",
      cancellationRequestedAt: null,
      failureClass: null,
      startedAt: "2026-07-20T04:20:00.000Z",
      completedAt: "2026-07-20T04:22:00.000Z",
      createdAt: "2026-07-20T04:20:00.000Z",
      updatedAt: "2026-07-20T04:22:00.000Z",
    },
    currentRevision: revision,
    revisions: [
      revision,
      {
        ...revision,
        id: "70000000-0000-4000-8000-000000000003",
        revision: 3,
        status: "published",
        editableUntil: null,
        publishedAt: "2026-07-18T06:00:00.000Z",
        parentRevisionId: null,
        quality: quality("balanced", 570, 45, 86),
        assignments: priorAssignments,
      },
    ],
    alternatives,
    areas: [
      { id: areaA, name: "Pool A", kind: "Standard pitch" },
      { id: areaB, name: "Pool B", kind: "Standard pitch" },
    ],
    slots,
    matches: ids.map((id, index) => ({
      id,
      divisionId: "40000000-0000-4000-8000-000000000001",
      divisionName: index < 8 ? "Open" : "Under 18",
      roundLabel: index < 6 ? `Group ${index % 2 ? "B" : "A"}` : index < 8 ? "Semi-final" : "Final",
      code: index < 6 ? `M${index + 1}` : index < 8 ? `SF${index - 5}` : `F${index - 7}`,
      homeLabel: ["Pasir Ris Rapids", "Punggol Current", "Marina Barracudas", "Telok Ayer Tide"][index % 4]!,
      awayLabel: ["Bedok Undertow", "Kallang Breakers", "Jurong Wake", "Seletar Paddlers"][(index + 1) % 4]!,
      durationMinutes: 30,
      dependencyMatchIds: index >= 6 ? ids.slice(Math.max(0, index - 2), index) : [],
      status: index === 6 ? "conflict" : index < 8 ? "scheduled" : "unscheduled",
    })),
    locks: assignments.slice(0, 2).map((assignment) => ({
      matchId: assignment.matchId,
      areaId: assignment.areaId,
      startsAt: assignment.startsAt,
      endsAt: assignment.endsAt,
    })),
    warnings: [
      {
        code: "expires_soon",
        message: "Draft 4 expires on 19 August 2026. Publish or create a fresh revision before then.",
        daysRemaining: 30,
      },
    ],
  };
}
