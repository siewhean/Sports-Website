import { messages } from "@matchday/ui";
import { phase2Machine } from "@/lib/phase2";
import { getCompetitionView } from "@/lib/phase2-public.server";
import { competitionOgImage, OG_IMAGE_SIZE } from "@/lib/public-og-image";

// This static route shadows /competitions/[slug], so it needs its own card (same renderer).
export const revalidate = 60;
// ISR on first request per slug (no build-time params); request headers are never needed here.
export const dynamic = "force-static";
export const alt = messages.seo.competitionImageAlt;
export const size = OG_IMAGE_SIZE;

export default async function SingaporeOpenOpenGraphImage() {
  const competition = await getCompetitionView(phase2Machine.singaporeOpenSlug).catch(() => null);
  return competitionOgImage(competition);
}
