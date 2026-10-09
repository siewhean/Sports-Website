import "server-only";

import { cache } from "react";
import type {
  PublicCompetitionProjection,
  PublicCompetitionSummary,
  PublicDivisionProjection,
  PublicMatchResult,
} from "@matchday/contracts";
import type { BracketResolution, ConfigurableStandingsRow, StandingsRow } from "@matchday/domain";
import { interpolate, messages } from "@matchday/ui";
import { apiFetch } from "@/lib/client-ip.server";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { publicCompetitionPhase } from "@/lib/phase2-public-phase";
import {
  isGateCC4PublicCompetitionProjection,
  isPublicCompetitionListing,
  publicSportName,
  type GateCC4PublicCompetitionProjection,
} from "@/lib/phase2-public";
import {
  demoCompetitionReadPort,
  type CompetitionReadPort,
  type CompetitionSummaryView,
  type CompetitionView,
  type MatchView,
  type PublicDivisionView,
  type StandingView,
} from "@/lib/phase2";

function apiBaseUrl(): string | null {
  const configured = (process.env.MATCHDAY_API_BASE_URL ?? process.env.RENDER_API_ORIGIN)?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Human stage label for a match. The projection only carries a machine code (for example "groups-G1-r2-m3");
 * that code must never reach the UI, so it is translated here into "Group G1 · Round 2" and similar.
 */
export function publicStageLabel(stage: string, code: string): string {
  const copy = messages.publicCompetition;
  const parsed = /^(.*?)-r(\d+)-m\d+$/u.exec(code);
  const prefix = (parsed?.[1] ?? code).toLowerCase();
  const round = parsed ? interpolate(copy.roundLabel, { round: Number(parsed[2]) }) : null;
  const withRound = (label: string) => (round ? interpolate(copy.stageWithRound, { stage: label, round }) : label);
  const group = /^groups?-(.+)$/u.exec(parsed?.[1] ?? "");
  if (group?.[1]) return withRound(interpolate(copy.groupLabel, { group: group[1] }));
  if (prefix.includes("reset")) return copy.grandFinalResetStage;
  if (prefix.includes("upper")) return withRound(copy.upperBracketStage);
  if (prefix.includes("lower")) return withRound(copy.lowerBracketStage);
  if (prefix.includes("grand")) return copy.grandFinalStage;
  if (stage === "group") return copy.groupStage;
  return titleCase(stage);
}

function dateTime(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat("en-SG", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function dateRange(startsOn: string, endsOn: string, timezone: string): string {
  const start = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${endsOn}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return `${startsOn}–${endsOn}`;
  const formatter = new Intl.DateTimeFormat("en-SG", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: timezone,
  });
  return startsOn === endsOn ? formatter.format(start) : `${formatter.format(start)}–${formatter.format(end)}`;
}

function matchTime(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat("en-SG", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(date);
  } catch {
    return value;
  }
}

function matchDay(value: string, timezone: string, options: Intl.DateTimeFormatOptions): string | undefined {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat("en-SG", { ...options, timeZone: timezone }).format(date);
  } catch {
    return undefined;
  }
}

class PublicProjectionContractError extends Error {}

/**
 * Reads a required numeric field from the first key present. A missing or non-numeric value is contract drift
 * between the API and this mapper; it must fail loudly rather than render as a believable 0.
 */
function requiredNumber(row: Readonly<Record<string, unknown>>, keys: readonly string[], context: string): number {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  throw new PublicProjectionContractError(`Public projection ${context} is missing numeric field ${keys.join(" | ")}`);
}

function publicMatchStatus(result: PublicMatchResult | undefined): MatchView["status"] {
  if (!result) return "scheduled";
  return result.state === "in_progress" ? "live" : "final";
}

/**
 * Wire shapes emitted into `PublicDivisionProjection.standings.standings`. The configurable engine
 * (`ConfigurableStandingsRow`) names the totals `tablePoints` / `scoreDifference`; the original canoe-polo engine
 * (`StandingsRow`) named them `points` / `goalDifference`. Both are accepted so neither leaks as 0.
 */
export type PublicStandingsWireRow =
  | Pick<
      ConfigurableStandingsRow,
      "rank" | "entryName" | "played" | "won" | "drawn" | "lost" | "tablePoints" | "scoreDifference"
    >
  | Pick<StandingsRow, "rank" | "entryName" | "played" | "won" | "drawn" | "lost" | "points" | "goalDifference">;

export function standingsView(value: Record<string, unknown> | null): StandingView[] {
  const rows = value && Array.isArray(value.standings) ? (value.standings as unknown[]) : [];
  return rows.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    if (typeof row.entryName !== "string") return [];
    return [
      {
        position: requiredNumber(row, ["rank"], "standings row"),
        team: row.entryName,
        played: requiredNumber(row, ["played"], "standings row"),
        won: requiredNumber(row, ["won"], "standings row"),
        drawn: requiredNumber(row, ["drawn"], "standings row"),
        lost: requiredNumber(row, ["lost"], "standings row"),
        difference: requiredNumber(row, ["scoreDifference", "goalDifference"], "standings row"),
        points: requiredNumber(row, ["tablePoints", "points"], "standings row"),
      } satisfies StandingView,
    ];
  });
}

type BracketWireMatch = Pick<BracketResolution["matches"][number], "matchId" | "stage">;

function bracketWireMatches(value: Record<string, unknown> | null): BracketWireMatch[] {
  const envelope = value?.bracket;
  const matches =
    envelope && typeof envelope === "object" ? (envelope as Partial<BracketResolution>).matches : undefined;
  if (!Array.isArray(matches)) return [];
  return matches.flatMap((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    return typeof row.matchId === "string" && typeof row.stage === "string"
      ? [{ matchId: row.matchId, stage: row.stage as BracketWireMatch["stage"] }]
      : [];
  });
}

type BracketStageKind = "upper" | "lower" | "grand_final" | "reset_final" | undefined;

function bracketStageKind(code: string, stage: string): BracketStageKind {
  const lowerCode = code.toLowerCase();
  if (lowerCode.includes("reset") || stage === "grand-final-reset") return "reset_final";
  if (lowerCode.includes("upper") || stage === "upper-bracket") return "upper";
  if (lowerCode.includes("lower") || stage === "lower-bracket") return "lower";
  if (lowerCode.includes("final") || stage === "grand-final") return "grand_final";
  return undefined;
}

function toDivisionView(
  projection: Pick<PublicCompetitionProjection, "competition">,
  divisionProjection: PublicDivisionProjection,
): PublicDivisionView {
  const { competition } = projection;
  const { division, schedule, results } = divisionProjection;
  const timezone = competition.timezone;
  const resultsById = new Map(results.map((result) => [result.id, result]));
  const scheduledIds = new Set(schedule.map((match) => match.id));
  const copy = messages.publicCompetition;
  // Chronological match numbers give spectators a stable, readable handle ("Match 3") in place of internal codes.
  const ordered = [...schedule].sort(
    (left, right) => left.starts_at.localeCompare(right.starts_at) || left.code.localeCompare(right.code),
  );
  const numberById = new Map<string, number>();
  for (const match of ordered) numberById.set(match.id, numberById.size + 1);
  for (const result of results) if (!numberById.has(result.id)) numberById.set(result.id, numberById.size + 1);
  const matchLabel = (id: string) => interpolate(copy.matchNumber, { number: numberById.get(id) ?? 0 });
  const rawStageById = new Map<string, string>();

  const resultFields = (result: PublicMatchResult) => ({
    homeScore: result.home_score,
    awayScore: result.away_score,
    currentSegment: result.current_segment,
    segments: result.segments,
    recordedTimeSeconds: result.recorded_time_seconds,
    updatedAt: result.updated_at,
    updatedLabel: dateTime(result.updated_at, timezone),
  });

  const matches: MatchView[] = [
    ...ordered.map((match) => {
      const result = resultsById.get(match.id);
      rawStageById.set(match.id, match.stage);
      const date = matchDay(match.starts_at, timezone, { day: "numeric", month: "long", year: "numeric" });
      const dayLabel = matchDay(match.starts_at, timezone, { weekday: "short", day: "numeric", month: "short" });
      return {
        id: match.id,
        label: matchLabel(match.id),
        code: match.code,
        stage: publicStageLabel(match.stage, match.code),
        time: matchTime(match.starts_at, timezone),
        ...(date ? { date } : {}),
        ...(dayLabel ? { dayLabel } : {}),
        area: match.area.name,
        home: result?.home.name ?? match.home.name,
        away: result?.away.name ?? match.away.name,
        ...(result ? resultFields(result) : {}),
        status: publicMatchStatus(result),
      };
    }),
    ...results
      .filter((result) => !scheduledIds.has(result.id))
      .map((result) => {
        rawStageById.set(result.id, result.stage);
        return {
          id: result.id,
          label: matchLabel(result.id),
          code: result.code,
          stage: publicStageLabel(result.stage, result.code),
          time: "—",
          area: "—",
          home: result.home.name,
          away: result.away.name,
          ...resultFields(result),
          status: publicMatchStatus(result),
        };
      }),
  ];
  const teams = [...new Set(matches.flatMap((match) => [match.home, match.away]).filter((name) => name !== "TBD"))];
  const areas = [...new Set(schedule.map((match) => match.area.name))];
  const bracketMatches = bracketWireMatches(divisionProjection.bracket);
  const matchesById = new Map(matches.map((match) => [match.id, match]));
  const bracketState = (match: MatchView | undefined) =>
    match ? (match.status === "final" ? "Final" : `${match.time} · ${match.area}`) : "TBD";
  const bracketScore = (match: MatchView | undefined) =>
    match?.homeScore !== undefined && match.awayScore !== undefined ? `${match.homeScore}–${match.awayScore}` : "–";

  return {
    division: { id: division.id, name: division.name, teamCount: teams.length, matchCount: matches.length },
    teams,
    areas,
    matches,
    standings: standingsView(divisionProjection.standings),
    bracket:
      bracketMatches.length > 0
        ? bracketMatches.map((row) => {
            const match = matchesById.get(row.matchId);
            return {
              id: row.matchId,
              round: match?.stage ?? titleCase(row.stage),
              fixture: match ? `${match.home} · ${match.away}` : "TBD · TBD",
              score: bracketScore(match),
              state: bracketState(match),
              stageKind: bracketStageKind(match?.code ?? "", row.stage),
            };
          })
        : matches
            .filter((match) => rawStageById.get(match.id) !== "group")
            .map((match) => ({
              id: match.id,
              round: match.stage,
              fixture: `${match.home} · ${match.away}`,
              score: bracketScore(match),
              state: bracketState(match),
              stageKind: bracketStageKind(match.code ?? "", rawStageById.get(match.id) ?? ""),
            })),
  };
}

export function toCompetitionView(projection: PublicCompetitionProjection): CompetitionView {
  const { competition, publication } = projection;
  const publicDivisions = projection.divisions.map((division) => toDivisionView(projection, division));
  const primary = publicDivisions[0];
  if (!primary) throw new Error("Public competition projection requires at least one division");
  return {
    id: competition.id,
    sportCode: competition.sport_code,
    slug: competition.slug,
    name: competition.name,
    sport: publicSportName(competition.sport_code),
    venue: [...new Set(publicDivisions.flatMap((division) => division.areas))].join(" · ") || primary.division.name,
    timezone: competition.timezone,
    dateLabel: dateRange(competition.starts_on, competition.ends_on, competition.timezone),
    status: competition.status,
    startsOn: competition.starts_on,
    endsOn: competition.ends_on,
    publicationRevision: `sch_${publication.schedule_version} · res_${publication.result_version}`,
    publishedAt: dateTime(projection.last_updated_at, competition.timezone),
    lastUpdated: dateTime(projection.last_updated_at, competition.timezone),
    ...primary,
    publicDivisions,
    audit: [],
  };
}

export function toCompetitionSummaryView(
  entry: PublicCompetitionSummary,
  now: Date = new Date(),
): CompetitionSummaryView {
  return {
    id: entry.id,
    slug: entry.slug,
    name: entry.name,
    sport: publicSportName(entry.sport_code),
    dateLabel: dateRange(entry.starts_on, entry.ends_on, entry.timezone),
    status: entry.status,
    startsOn: entry.starts_on,
    endsOn: entry.ends_on,
    timezone: entry.timezone,
    phase: publicCompetitionPhase(
      { status: entry.status, startsOn: entry.starts_on, endsOn: entry.ends_on, timezone: entry.timezone },
      now,
    ),
  };
}

/**
 * Thrown when the public API cannot give a trustworthy answer (network error, 429, 5xx, malformed or
 * inconsistent projection). Pages let it propagate to the segment error boundary instead of pretending the
 * competition does not exist; only a genuine 404 becomes `null` / notFound().
 */
export class PublicDataUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "PublicDataUnavailableError";
  }
}

/** Maps a non-OK API response: 404 means "no such competition", everything else is an outage. */
export function classifyPublicResponse(status: number): "not_found" | "unavailable" {
  return status === 404 ? "not_found" : "unavailable";
}

export function normalizeEtag(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/^W\//, "")
    .replace(/^"|"$/g, "")
    .replace(/-(?:gzip|br|zstd)$/, "");
}

function publicHeadersMatchProjection(response: Response, projection: GateCC4PublicCompetitionProjection): boolean {
  const responseEtag = normalizeEtag(response.headers.get("etag"));
  const projectionEtag = normalizeEtag(projection.freshness.etag);
  if (!responseEtag || responseEtag !== projectionEtag) return false;
  const expectedHeaders = {
    "x-matchday-schedule-version": String(projection.freshness.schedule_version),
    "x-matchday-result-version": String(projection.freshness.result_version),
    "x-matchday-projection-version": String(projection.freshness.projection_version),
  } as const;
  return Object.entries(expectedHeaders).every(([name, expected]) => {
    const actual = response.headers.get(name);
    return actual === null || actual === expected;
  });
}

function canonicalProjection(value: unknown): GateCC4PublicCompetitionProjection | null {
  return isGateCC4PublicCompetitionProjection(value) ? value : null;
}

const apiCompetitionReadPort: CompetitionReadPort = {
  async getBySlug(slug) {
    const baseUrl = apiBaseUrl();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
    if (!baseUrl) throw new PublicDataUnavailableError("Public API origin is not configured");
    try {
      const response = await apiFetch(`${baseUrl}/api/v1/public/competitions/${encodeURIComponent(slug)}/current`, {
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
        },
        cache: "no-store",
      });
      if (!response.ok) {
        if (classifyPublicResponse(response.status) === "not_found") return null;
        throw new PublicDataUnavailableError(`Public API responded ${response.status}`, response.status);
      }
      const projection = canonicalProjection(await response.json());
      if (!projection || !publicHeadersMatchProjection(response, projection)) {
        throw new PublicDataUnavailableError("Public API returned an inconsistent projection");
      }
      return toCompetitionView(projection);
    } catch (error) {
      if (error instanceof PublicDataUnavailableError) throw error;
      throw new PublicDataUnavailableError(error instanceof Error ? error.message : "Public API request failed");
    }
  },
  async list() {
    const baseUrl = apiBaseUrl();
    if (!baseUrl) throw new PublicDataUnavailableError("Public API origin is not configured");
    try {
      const response = await apiFetch(`${baseUrl}/api/v1/public/competitions`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok)
        throw new PublicDataUnavailableError(`Public API responded ${response.status}`, response.status);
      const payload: unknown = await response.json();
      if (!isPublicCompetitionListing(payload)) {
        throw new PublicDataUnavailableError("Public API returned a malformed competition listing");
      }
      const now = new Date();
      return payload.competitions.map((entry) => toCompetitionSummaryView(entry, now));
    } catch (error) {
      if (error instanceof PublicDataUnavailableError) throw error;
      throw new PublicDataUnavailableError(error instanceof Error ? error.message : "Public API request failed");
    }
  },
};

export const getCompetitionView = cache(async (slug: string): Promise<CompetitionView | null> => {
  const reader = demoFixturesEnabled() ? demoCompetitionReadPort : apiCompetitionReadPort;
  return reader.getBySlug(slug);
});

export const getCompetitionListing = cache(async (): Promise<CompetitionSummaryView[]> => {
  const reader = demoFixturesEnabled() ? demoCompetitionReadPort : apiCompetitionReadPort;
  return reader.list();
});
