import { PendingRepairCases } from "@/components/gate-c/PendingRepairCases";
import { RepairWorkspace } from "@/components/gate-c/RepairWorkspace";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { gateCC4Copy, gateCC4Machine } from "@/lib/gate-c-c4";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase2Copy } from "@/lib/phase2";
import { notFound, redirect } from "next/navigation";
import styles from "./page.module.css";

// Next.js statically evaluates segment configuration exports; this must remain a literal.
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
      section={gateCC4Machine.results}
      pageEyebrow={gateCC4Copy.eyebrow}
      pageTitle={gateCC4Copy.title}
      pageIntro={gateCC4Copy.intro}
      sectionAction={null}
      syncLabel={competition.publishedVersionLabel ?? competition.publicationRevision}
      syncState={competition.canEdit ? gateCC4Machine.saved : gateCC4Machine.readOnly}
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
