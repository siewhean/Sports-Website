import { interpolate, messages } from "@matchday/ui";
import { configuredPublicOrigin } from "@/lib/phase3-origin";

type PublicCompetitionJsonLdInput = {
  slug: string;
  name: string;
  sport: string;
  venue?: string;
  startsOn?: string;
  endsOn?: string;
  status?: string;
  teams?: readonly string[];
};

type PublicMatchJsonLdInput = {
  id: string;
  home: string;
  away: string;
  stage: string;
  area: string;
  startsAt?: string;
  status: "scheduled" | "live" | "final";
};

type SportsTeamJsonLd = { "@type": "SportsTeam"; name: string };
type PlaceJsonLd = { "@type": "Place"; name: string };

const SCHEMA_EVENT_SCHEDULED = "https://schema.org/EventScheduled";
const SCHEMA_EVENT_CANCELLED = "https://schema.org/EventCancelled";
const SCHEMA_OFFLINE_ATTENDANCE = "https://schema.org/OfflineEventAttendanceMode";
/** schema.org caps nothing, but huge competitor lists bloat every page; search engines only need the field set. */
const MAX_COMPETITORS = 64;

export type PublicCompetitionJsonLd = {
  "@context": "https://schema.org";
  "@type": "SportsEvent";
  name: string;
  description: string;
  url: string;
  sport: string;
  eventStatus: string;
  eventAttendanceMode: string;
  startDate?: string;
  endDate?: string;
  location?: PlaceJsonLd;
  competitor?: SportsTeamJsonLd[];
};

export type PublicMatchJsonLd = {
  "@context": "https://schema.org";
  "@type": "SportsEvent";
  name: string;
  description: string;
  url: string;
  sport: string;
  eventStatus: string;
  eventAttendanceMode: string;
  startDate?: string;
  location?: PlaceJsonLd;
  homeTeam: SportsTeamJsonLd;
  awayTeam: SportsTeamJsonLd;
  competitor: SportsTeamJsonLd[];
  superEvent: { "@type": "SportsEvent"; name: string; url: string };
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function isoDate(value: string | undefined): string | undefined {
  return value && ISO_DATE.test(value) ? value : undefined;
}

function isoInstant(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function eventStatus(status: string | undefined): string {
  return status === "cancelled" ? SCHEMA_EVENT_CANCELLED : SCHEMA_EVENT_SCHEDULED;
}

function team(name: string): SportsTeamJsonLd {
  return { "@type": "SportsTeam", name };
}

function place(name: string | undefined): PlaceJsonLd | undefined {
  const trimmed = name?.trim();
  return trimmed && trimmed !== "—" ? { "@type": "Place", name: trimmed } : undefined;
}

export function publicCompetitionUrl(origin: string, slug: string): string {
  return `${origin}/competitions/${encodeURIComponent(slug)}`;
}

export function publicMatchUrl(origin: string, slug: string, matchId: string): string {
  return `${publicCompetitionUrl(origin, slug)}/matches/${encodeURIComponent(matchId)}`;
}

/** `origin` must be an HTTPS (or loopback) origin; anything else yields null rather than a misleading URL. */
export function publicCompetitionJsonLd(
  competition: PublicCompetitionJsonLdInput,
  origin: string | null | undefined,
): PublicCompetitionJsonLd | null {
  const resolved = configuredPublicOrigin(origin ?? undefined);
  if (!resolved) return null;
  const startDate = isoDate(competition.startsOn);
  const endDate = isoDate(competition.endsOn);
  const location = place(competition.venue);
  const competitors = (competition.teams ?? []).filter((name) => name && name !== "TBD").slice(0, MAX_COMPETITORS);

  return {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: competition.name,
    description: interpolate(messages.seo.competitionJsonLdDescription, {
      competition: competition.name,
      sport: competition.sport,
    }),
    url: publicCompetitionUrl(resolved, competition.slug),
    sport: competition.sport,
    eventStatus: eventStatus(competition.status),
    eventAttendanceMode: SCHEMA_OFFLINE_ATTENDANCE,
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(location ? { location } : {}),
    ...(competitors.length ? { competitor: competitors.map(team) } : {}),
  };
}

export function publicMatchJsonLd(
  competition: PublicCompetitionJsonLdInput,
  match: PublicMatchJsonLdInput,
  origin: string | null | undefined,
): PublicMatchJsonLd | null {
  const resolved = configuredPublicOrigin(origin ?? undefined);
  if (!resolved) return null;
  const startDate = isoInstant(match.startsAt);
  const location = place(match.area) ?? place(competition.venue);
  const home = team(match.home);
  const away = team(match.away);
  return {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: interpolate(messages.publicCompetition.versus, { home: match.home, away: match.away }),
    description: interpolate(messages.seo.matchDescription, {
      home: match.home,
      away: match.away,
      stage: match.stage,
      competition: competition.name,
    }),
    url: publicMatchUrl(resolved, competition.slug, match.id),
    sport: competition.sport,
    eventStatus: eventStatus(competition.status),
    eventAttendanceMode: SCHEMA_OFFLINE_ATTENDANCE,
    ...(startDate ? { startDate } : {}),
    ...(location ? { location } : {}),
    homeTeam: home,
    awayTeam: away,
    competitor: [home, away],
    superEvent: {
      "@type": "SportsEvent",
      name: competition.name,
      url: publicCompetitionUrl(resolved, competition.slug),
    },
  };
}

/** JSON for a <script type="application/ld+json">; `<` is escaped so no value can close the script element. */
export function serializeJsonLd(value: PublicCompetitionJsonLd | PublicMatchJsonLd): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
