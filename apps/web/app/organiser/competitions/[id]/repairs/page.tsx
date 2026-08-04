import { notFound, redirect } from "next/navigation";
import { PendingRepairCases } from "@/components/gate-c/PendingRepairCases";
import { RepairWorkspace } from "@/components/gate-c/RepairWorkspace";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { gateCC4Copy } from "@/lib/gate-c-c4";
import { gateCC4UiMachine } from "@/lib/gate-c-c4-http";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import styles from "./RepairPage.module.css";

// Next.js route-segment configuration must remain a literal so the compiler can
// determine rendering mode before evaluating this module.
export const dynamic = "force-dynamic";

export default async function CompetitionRepairsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase2Copy.errorBody);

  const competition = result.competition;
  return (
    <OrganiserWorkspace
      competition={competition}
      section={gateCC4UiMachine.resultsSection}
      pageEyebrow={gateCC4Copy.eyebrow}
      pageTitle={gateCC4Copy.title}
      pageIntro={gateCC4Copy.intro}
      syncLabel={competition.publicationRevision}
      syncState={gateCC4UiMachine.savedSyncState}
      sectionAction={null}
      sectionContent={
        <div className={styles.stack}>
          <PendingRepairCases competitionId={competition.id} />
          <RepairWorkspace
            competitionId={competition.id}
            matches={competition.matches.map((match) => ({
              id: match.id,
              label: match.label,
              home: match.home,
              away: match.away,
            }))}
          />
        </div>
      }
    />
  );
}
