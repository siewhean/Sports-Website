import { messages } from "@matchday/ui";
import { getCompetitionView } from "@/lib/phase2-public.server";
import { competitionOgImage, OG_IMAGE_SIZE } from "@/lib/public-og-image";

// Regenerated at most once a minute; the projection read itself goes through the public Data Cache.
export const revalidate = 60;
// ISR on first request per slug (no build-time params); request headers are never needed here.
export const dynamic = "force-static";
export const alt = messages.seo.competitionImageAlt;
export const size = OG_IMAGE_SIZE;

export default async function CompetitionOpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // An outage or unknown slug still yields a branded card rather than a broken image.
  const competition = await getCompetitionView(slug).catch(() => null);
  return competitionOgImage(competition);
}
