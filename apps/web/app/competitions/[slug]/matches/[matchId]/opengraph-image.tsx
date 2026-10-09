import { messages } from "@matchday/ui";
import { getCompetitionView } from "@/lib/phase2-public.server";
import { findPublicMatch } from "@/lib/public-competition-metadata.server";
import { matchOgImage, OG_IMAGE_SIZE } from "@/lib/public-og-image";

// Live scores move quickly; social crawlers cache aggressively anyway, so a short window is enough.
export const revalidate = 30;
// ISR on first request per slug (no build-time params); request headers are never needed here.
export const dynamic = "force-static";
export const alt = messages.seo.matchImageAlt;
export const size = OG_IMAGE_SIZE;

export default async function MatchOpenGraphImage({ params }: { params: Promise<{ slug: string; matchId: string }> }) {
  const { slug, matchId } = await params;
  const competition = await getCompetitionView(slug).catch(() => null);
  const found = competition ? findPublicMatch(competition, matchId) : null;
  return matchOgImage(competition, found?.match ?? null);
}
