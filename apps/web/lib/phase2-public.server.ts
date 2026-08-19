import "server-only";

import { cache } from "react";
import type {
  PublicCompetitionProjection,
  PublicCompetitionSummary,
  PublicDivisionProjection,
} from "@matchday/contracts";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { isPublicCompetitionListing, isPublicCompetitionProjection, publicSportName } from "@/lib/phase2-public";
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
  const configured = process.env.MATCHDAY_API_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function standingsView(value: Record<string, unknown> | null): StandingView[] {
  const rows = value && Array.isArray(value.standings) ? value.standings : [];
  return rows.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    if (typeof row.entryName !== "string") return [];
    return [
      {
        position: number(row.rank),
        team: row.entryName,
        played: number(row.played),
        won: number(row.won),
        drawn: number(row.drawn),
        lost: number(row.lost),
        difference: number(row.goalDifference),
        points: number(row.points),
      },
    ];
  });
}

function toDivisionView(
  projection: Pick<PublicCompetitionProjection, "competition">,
  divisionProjection: PublicDivisionProjection,
): PublicDivisionView {
  const { competition } = projection;
  const { division, schedule, results } = divisionProjection;
  const resultsById = new Map(results.map((result) => [result.id, result]));
  const scheduledIds = new Set(schedule.map((match) => match.id));
  const matches: MatchView[] = [
    ...schedule.map((match) => {
      const result = resultsById.get(match.id);
      return {
        id: match.id,
        label: match.code,
        stage: titleCase(match.stage),
        time: matchTime(match.starts_at, competition.timezone),
        area: match.area.name,
        home: result?.home.name ?? match.home.name,
        away: result?.away.name ?? match.away.name,
        ...(result ? { homeScore: result.home_score, awayScore: result.away_score } : {}),
        status: result ? ("final" as const) : ("scheduled" as const),
      };
    }),
    ...results
      .filter((result) => !scheduledIds.has(result.id))
      .map((result) => ({
        id: result.id,
        label: result.code,
        stage: titleCase(result.stage),
        time: "—",
        area: "—",
        home: result.home.name,
        away: result.away.name,
        homeScore: result.home_score,
        awayScore: result.away_score,
        status: "final" as const,
      })),
  ];
  const teams = [...new Set(matches.flatMap((match) => [match.home, match.away]).filter((name) => name !== "TBD"))];
  const areas = [...new Set(schedule.map((match) => match.area.name))];
  const bracketEnvelope = divisionProjection.bracket?.bracket;
  const bracketMatches =
    bracketEnvelope &&
    typeof bracketEnvelope === "object" &&
    Array.isArray((bracketEnvelope as Record<string, unknown>).matches)
      ? ((bracketEnvelope as Record<string, unknown>).matches as Array<Record<string, unknown>>)
      : [];
  const matchesById = new Map(matches.map((match) => [match.id, match]));

  return {
    division: { id: division.id, name: division.name, teamCount: teams.length, matchCount: matches.length },
    teams,
    areas,
    matches,
    standings: standingsView(divisionProjection.standings),
    bracket: bracketMatches.map((row) => {
      const matchId = typeof row.matchId === "string" ? row.matchId : undefined;
      const match = matchId ? matchesById.get(matchId) : undefined;
      return {
        ...(matchId ? { id: matchId } : {}),
        round: typeof row.stage === "string" ? titleCase(row.stage) : (match?.stage ?? "Knockout"),
        fixture: match ? `${match.home} · ${match.away}` : "TBD · TBD",
        score:
          match?.homeScore !== undefined && match.awayScore !== undefined
            ? `${match.homeScore}–${match.awayScore}`
            : "–",
        state: match ? (match.status === "final" ? "Final" : `${match.time} · ${match.area}`) : "TBD",
      };
    }),
  };
}

export function toCompetitionView(projection: PublicCompetitionProjection): CompetitionView {
  const { competition, publication } = projection;
  const publicDivisions = projection.divisions.map((division) => toDivisionView(projection, division));
  const primary = publicDivisions[0];
  if (!primary) throw new Error("Public competition projection requires at least one division");
  return {
    id: competition.id,
    slug: competition.slug,
    name: competition.name,
    sport: publicSportName(competition.sport_code),
    venue: [...new Set(publicDivisions.flatMap((division) => division.areas))].join(" · ") || primary.division.name,
    timezone: competition.timezone,
    dateLabel: dateRange(competition.starts_on, competition.ends_on, competition.timezone),
    publicationRevision: `sch_${publication.schedule_version} · res_${publication.result_version}`,
    publishedAt: dateTime(projection.last_updated_at, competition.timezone),
    lastUpdated: dateTime(projection.last_updated_at, competition.timezone),
    ...primary,
    publicDivisions,
    audit: [],
  };
}

export function toCompetitionSummaryView(entry: PublicCompetitionSummary): CompetitionSummaryView {
  return {
    id: entry.id,
    slug: entry.slug,
    name: entry.name,
    sport: publicSportName(entry.sport_code),
    dateLabel: dateRange(entry.starts_on, entry.ends_on, entry.timezone),
    status: entry.status,
  };
}

const apiCompetitionReadPort: CompetitionReadPort = {
  async getBySlug(slug) {
    const baseUrl = apiBaseUrl();
    if (!baseUrl || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
    try {
      const response = await fetch(`${baseUrl}/api/v1/public/competitions/${encodeURIComponent(slug)}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      return isPublicCompetitionProjection(payload) ? toCompetitionView(payload) : null;
    } catch {
      return null;
    }
  },
  async list() {
    const baseUrl = apiBaseUrl();
    if (!baseUrl) return [];
    try {
      const response = await fetch(`${baseUrl}/api/v1/public/competitions`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return [];
      const payload: unknown = await response.json();
      if (!isPublicCompetitionListing(payload)) return [];
      return payload.competitions.map(toCompetitionSummaryView);
    } catch {
      return [];
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
