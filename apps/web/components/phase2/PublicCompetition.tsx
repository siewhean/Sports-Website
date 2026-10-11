import { spectatorMessages } from "@matchday/ui";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import { PublicCompetitionApp } from "@/components/phase2/PublicCompetitionApp";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import type { CompetitionView } from "@/lib/phase2";
import styles from "./PublicCompetition.module.css";

/**
 * Server shell for the spectator page. All interactive state (tabs, filters, following, live updates) lives in
 * the client app; this only renders chrome and hands over the published snapshot.
 */
export function PublicCompetition({
  competition,
  viewer = null,
  liveUpdates = true,
}: {
  competition: CompetitionView;
  viewer?: { displayName: string } | null;
  liveUpdates?: boolean;
}) {
  return (
    <div className="p2-public">
      <a className="skip-link" href="#public-main">
        {spectatorMessages.skipToContent}
      </a>
      <SiteHeader viewer={viewer} />
      <main id="public-main" className={styles.main}>
        <PublicCompetitionApp
          competition={competition}
          liveUpdates={liveUpdates && !demoFixturesEnabled()}
          renderedAt={new Date().toISOString()}
        />
      </main>
      <SiteFooter />
    </div>
  );
}
