import type { MetadataRoute } from "next";
import { getCompetitionListing, getCompetitionView } from "@/lib/phase2-public.server";
import type { CompetitionView } from "@/lib/phase2";
import { publicCompetitionUrl, publicMatchUrl } from "@/lib/public-competition-json-ld";
import { seoOrigin } from "@/lib/public-origin.server";

// Regenerated in the background at most every 5 minutes; upstream reads use the public Data Cache.
export const revalidate = 300;

/** Bounds the fan-out of per-competition reads (one projection each) and the sitemap size. */
const MAX_COMPETITIONS = 200;
const MAX_URLS = 45_000;

function validDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function competitionEntries(origin: string, competition: CompetitionView): MetadataRoute.Sitemap {
  const lastModified = validDate(competition.lastUpdatedAt);
  // Same lookup as the match page (publicDivisions only), so every listed match URL resolves.
  const matches = competition.publicDivisions?.flatMap((division) => division.matches) ?? [];
  return [
    {
      url: publicCompetitionUrl(origin, competition.slug),
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: competition.status === "completed" || competition.status === "archived" ? "monthly" : "hourly",
      priority: 0.8,
    },
    ...matches.map((match) => {
      const matchModified = validDate(match.updatedAt) ?? lastModified;
      return {
        url: publicMatchUrl(origin, competition.slug, match.id),
        ...(matchModified ? { lastModified: matchModified } : {}),
        changeFrequency: match.status === "final" ? ("monthly" as const) : ("hourly" as const),
        priority: 0.5,
      };
    }),
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await seoOrigin();
  if (!origin) return [];

  const staticEntries: MetadataRoute.Sitemap = [
    { url: origin, changeFrequency: "daily", priority: 1.0 },
    { url: `${origin}/competitions`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${origin}/pricing`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${origin}/support`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${origin}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${origin}/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${origin}/cookies`, changeFrequency: "yearly", priority: 0.3 },
  ];

  // A results outage must never break the sitemap: fall back to the static entries.
  const listing = await getCompetitionListing().catch(() => []);
  const reads = await Promise.allSettled(
    listing.slice(0, MAX_COMPETITIONS).map((summary) => getCompetitionView(summary.slug)),
  );
  const competitionUrls = reads.flatMap((read, index) => {
    if (read.status === "fulfilled" && read.value) return competitionEntries(origin, read.value);
    const summary = listing[index];
    // The listing proves the competition is public even if its projection read failed this time.
    return summary
      ? [{ url: publicCompetitionUrl(origin, summary.slug), changeFrequency: "hourly" as const, priority: 0.8 }]
      : [];
  });

  return [...staticEntries, ...competitionUrls].slice(0, MAX_URLS);
}
