import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicCompetition } from "@/components/phase2/PublicCompetition";
import { getCompetitionView, publicReadFreshness } from "@/lib/phase2-public.server";
import { publicCompetitionMetadata } from "@/lib/public-competition-metadata.server";
import { publicCompetitionJsonLd, serializeJsonLd } from "@/lib/public-competition-json-ld";
import { seoOrigin } from "@/lib/public-origin.server";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  // Metadata is best effort: an outage must surface through the page's error boundary, not here.
  const competition = await getCompetitionView(slug, await publicReadFreshness()).catch(() => null);
  return competition ? publicCompetitionMetadata(competition) : {};
}

export default async function CompetitionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // No cookie / identity read: the page is identical for every spectator (IdentityStatus loads the viewer
  // client-side), which keeps the render cheap and lets the service worker keep a copy for venue Wi-Fi drop-outs.
  const [competition, origin] = await Promise.all([getCompetitionView(slug, await publicReadFreshness()), seoOrigin()]);
  if (!competition) notFound();
  const jsonLd = publicCompetitionJsonLd(competition, origin);

  return (
    <>
      {jsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      ) : null}
      <PublicCompetition competition={competition} viewer={null} />
    </>
  );
}
