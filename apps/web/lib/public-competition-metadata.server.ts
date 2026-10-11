import "server-only";
import type { Metadata } from "next";
import { interpolate, messages } from "@matchday/ui";
import type { CompetitionView, MatchView } from "@/lib/phase2";

/** Page metadata for a public competition (canonical, OG and Twitter; OG image comes from opengraph-image.tsx). */
export function publicCompetitionMetadata(competition: CompetitionView): Metadata {
  const path = `/competitions/${encodeURIComponent(competition.slug)}`;
  const description = interpolate(messages.seo.competitionDescription, {
    sport: competition.sport,
    dates: competition.dateLabel,
    competition: competition.name,
  });
  return {
    title: competition.name,
    description,
    alternates: { canonical: path },
    openGraph: { title: competition.name, description, url: path, type: "website" },
    twitter: { card: "summary_large_image", title: competition.name, description },
  };
}

export function findPublicMatch(
  competition: CompetitionView,
  matchId: string,
): { match: MatchView; divisionName: string } | null {
  for (const division of competition.publicDivisions ?? []) {
    const match = division.matches.find((candidate) => candidate.id === matchId);
    if (match) return { match, divisionName: division.division.name };
  }
  // Mirrors the match page, which only resolves matches from publicDivisions.
  return null;
}

export function publicMatchMetadata(competition: CompetitionView, match: MatchView): Metadata {
  const path = `/competitions/${encodeURIComponent(competition.slug)}/matches/${encodeURIComponent(match.id)}`;
  const title = interpolate(messages.publicCompetition.matchPageTitle, {
    home: match.home,
    away: match.away,
    competition: competition.name,
  });
  const hasScore = match.homeScore !== undefined && match.awayScore !== undefined && match.status !== "scheduled";
  const description = hasScore
    ? interpolate(messages.seo.matchScoreDescription, {
        home: match.home,
        away: match.away,
        homeScore: match.homeScore ?? 0,
        awayScore: match.awayScore ?? 0,
        stage: match.stage,
        competition: competition.name,
      })
    : interpolate(messages.seo.matchDescription, {
        home: match.home,
        away: match.away,
        stage: match.stage,
        competition: competition.name,
      });
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}
