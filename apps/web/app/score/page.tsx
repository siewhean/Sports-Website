import { PrototypeShell } from "@/components/PrototypeShell";
import { ScorekeeperPrototype } from "@/components/ScorekeeperPrototype";
import { PhoneScoring } from "@/components/phase2/PhoneScoring";
import { isPhase2ScoringRouteEnabled } from "@/lib/feature-flags.server";
import { phase2Machine } from "@/lib/phase2";
import { translate as t } from "@matchday/ui";

export default async function ScorePage() {
  if (await isPhase2ScoringRouteEnabled()) {
    return (
      <PhoneScoring
        mode={
          process.env.MATCHDAY_PHASE2_DATA_MODE === phase2Machine.scoringDemoMode
            ? phase2Machine.scoringDemoMode
            : phase2Machine.scoringApiMode
        }
      />
    );
  }
  return (
    <PrototypeShell routeLabel={t("prototype.11b172ceab02")} scoring>
      <ScorekeeperPrototype />
    </PrototypeShell>
  );
}
