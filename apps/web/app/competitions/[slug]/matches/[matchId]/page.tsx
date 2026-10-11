import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { spectatorMessages } from "@matchday/ui";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { PublicMatchLive } from "@/components/phase2/PublicMatchLive";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { getCompetitionView, publicReadFreshness } from "@/lib/phase2-public.server";
import { findPublicMatch, publicMatchMetadata } from "@/lib/public-competition-metadata.server";
import { publicMatchJsonLd, serializeJsonLd } from "@/lib/public-competition-json-ld";
import { seoOrigin } from "@/lib/public-origin.server";
import styles from "./page.module.css";

type Params = Promise<{ slug: string; matchId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, matchId } = await params;
  const competition = await getCompetitionView(slug, await publicReadFreshness()).catch(() => null);
  const found = competition ? findPublicMatch(competition, matchId) : null;
  return competition && found ? publicMatchMetadata(competition, found.match) : {};
}

export default async function PublicMatchPage({ params }: { params: Params }) {
  const { slug, matchId } = await params;
  const [competition, origin] = await Promise.all([getCompetitionView(slug, await publicReadFreshness()), seoOrigin()]);
  if (!competition) notFound();
  const found = findPublicMatch(competition, matchId);
  if (!found) notFound();
  const jsonLd = publicMatchJsonLd(competition, found.match, origin);
  return (
    <div className={styles.page}>
      {jsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      ) : null}
      <a className="skip-link" href="#match-main">
        {spectatorMessages.skipToContent}
      </a>
      <SiteHeader />
      <main className={styles.main} id="match-main">
        <PublicMatchLive
          competition={competition}
          matchId={matchId}
          liveUpdates={!demoFixturesEnabled()}
          renderedAt={new Date().toISOString()}
        />
      </main>
      <SiteFooter />
    </div>
  );
}
