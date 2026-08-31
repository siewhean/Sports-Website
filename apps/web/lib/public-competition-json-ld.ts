import { configuredPublicOrigin } from "@/lib/phase3-origin";

type PublicCompetitionJsonLdInput = {
  slug: string;
  name: string;
  sport: string;
};

export type PublicCompetitionJsonLd = {
  "@context": "https://schema.org";
  "@type": "SportsEvent";
  name: string;
  description: string;
  url: string;
  sport: string;
};

export function publicCompetitionJsonLd(
  competition: PublicCompetitionJsonLdInput,
  configuredOrigin: string | undefined,
): PublicCompetitionJsonLd | null {
  const origin = configuredPublicOrigin(configuredOrigin);
  if (!origin) return null;

  return {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: competition.name,
    description: `${competition.name} — ${competition.sport} competition.`,
    url: `${origin}/competitions/${encodeURIComponent(competition.slug)}`,
    sport: competition.sport,
  };
}

export function serializeJsonLd(value: PublicCompetitionJsonLd): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
