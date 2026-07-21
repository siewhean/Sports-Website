import { Phase3RouteLoading } from "@/components/phase3/Phase3RouteLoading";
import { phase3CapacityCopy } from "@/lib/phase3-capacity";
import { phase3VisualMachine } from "@/lib/phase3-sport-settings";

export default function CompetitionSectionLoading() {
  return <Phase3RouteLoading label={phase3CapacityCopy.loadingSection} variant={phase3VisualMachine.settings} />;
}
