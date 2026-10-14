import { notFound } from "next/navigation";
import { PhoneScoring } from "@/components/phase2/PhoneScoring";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { isPhase2ScoringRouteEnabled } from "@/lib/feature-flags.server";
import { phase2Machine } from "@/lib/phase2";
import { SPORT_PACKS, type SportId } from "@matchday/domain";

const DEMO_SPORTS = new Set<SportId>(Object.keys(SPORT_PACKS) as SportId[]);

export default async function ScorePage({ searchParams }: { searchParams: Promise<{ sport?: string }> }) {
  if (!(await isPhase2ScoringRouteEnabled())) {
    notFound();
  }
  const demo = demoFixturesEnabled();
  const requestedSport = (await searchParams).sport;
  const demoSportId =
    demo && DEMO_SPORTS.has(requestedSport as SportId) ? (requestedSport as SportId) : phase2Machine.canoePolo;
  return (
    <div data-offline-scoring-shell="v1">
      <PhoneScoring
        mode={demo ? phase2Machine.scoringDemoMode : phase2Machine.scoringApiMode}
        recoverOnLoad={!demo}
        demoSportId={demoSportId}
      />
    </div>
  );
}
