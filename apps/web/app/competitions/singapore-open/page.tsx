import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicCompetition } from "@/components/phase2/PublicCompetition";
import { phase2Machine } from "@/lib/phase2";
import { getCompetitionView, publicReadFreshness } from "@/lib/phase2-public.server";
import { publicCompetitionMetadata } from "@/lib/public-competition-metadata.server";
import { publicCompetitionJsonLd, serializeJsonLd } from "@/lib/public-competition-json-ld";
import { seoOrigin } from "@/lib/public-origin.server";

export async function generateMetadata(): Promise<Metadata> {
  const competition = await getCompetitionView(phase2Machine.singaporeOpenSlug, await publicReadFreshness()).catch(
    () => null,
  );
  return competition ? publicCompetitionMetadata(competition) : {};
}

export default async function PublicCompetitionPage() {
  const [competition, origin] = await Promise.all([
    getCompetitionView(phase2Machine.singaporeOpenSlug, await publicReadFreshness()),
    seoOrigin(),
  ]);
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
