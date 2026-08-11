import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { PrototypeShell } from "@/components/PrototypeShell";
import { ScorekeeperPrototype } from "@/components/ScorekeeperPrototype";
import { PhoneScoring } from "@/components/phase2/PhoneScoring";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { isPhase2ScoringRouteEnabled } from "@/lib/feature-flags.server";
import { phase2Machine } from "@/lib/phase2";
import { scoringSessionCookieName } from "@/lib/scoring-session.server";
import { translate as t } from "@matchday/ui";
import { SPORT_PACKS, type SportId } from "@matchday/domain";

const DEMO_SPORTS = new Set<SportId>(Object.keys(SPORT_PACKS) as SportId[]);

export default async function ScorePage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string; advanced?: string }>;
}) {
  if (await isPhase2ScoringRouteEnabled()) {
    const demo = demoFixturesEnabled();
    const requestedSearchParams = await searchParams;
    const requestedSport = requestedSearchParams.sport;
    const demoSportId =
      demo && DEMO_SPORTS.has(requestedSport as SportId) ? (requestedSport as SportId) : phase2Machine.canoePolo;
    const hasScoringSession = (await cookies()).has(scoringSessionCookieName);
    return (
      <PhoneScoring
        mode={demo ? phase2Machine.scoringDemoMode : phase2Machine.scoringApiMode}
        recoverOnLoad={hasScoringSession}
        demoSportId={demoSportId}
        advancedMode={requestedSearchParams.advanced === "1"}
      />
    );
  }
  if (!demoFixturesEnabled()) notFound();
  return (
    <PrototypeShell routeLabel={t("prototype.11b172ceab02")} scoring>
      <ScorekeeperPrototype />
    </PrototypeShell>
  );
}
