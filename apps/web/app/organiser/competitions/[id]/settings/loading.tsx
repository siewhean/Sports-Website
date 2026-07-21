import { Phase3RouteLoading } from "@/components/phase3/Phase3RouteLoading";
import { phase3SettingsCopy, phase3VisualMachine } from "@/lib/phase3-sport-settings";

export default function CompetitionSettingsLoading() {
  return <Phase3RouteLoading label={phase3SettingsCopy.loadingCompetition} variant={phase3VisualMachine.settings} />;
}
