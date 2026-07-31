import { RepairWorkspace } from "@/components/gate-c/RepairWorkspace";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { OrganiserState } from "@/components/phase2/OrganiserState";
import { gateCC4Copy } from "@/lib/gate-c-c4";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase2Copy } from "@/lib/phase2";

export const dynamic = "force-dynamic";

export default async function CompetitionRepairsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "permission") {
    return <OrganiserState state="permission" title={phase2Copy.permissionTitle} body={phase2Copy.permissionBody} />;
  }
  if (result.state === "notFound") {
    return <OrganiserState state="empty" title={phase2Copy.emptyTitle} body={phase2Copy.emptyBody} />;
  }
  if (result.state === "error") {
    return <OrganiserState state="error" title={phase2Copy.errorTitle} body={phase2Copy.errorBody} />;
  }

  const competition = result.competition;
  return (
    <OrganiserWorkspace
      competition={competition}
      section="results"
      pageEyebrow={gateCC4Copy.eyebrow}
      pageTitle={gateCC4Copy.title}
      pageIntro={gateCC4Copy.intro}
      pageMeta={competition.publishedVersionLabel ?? competition.publicationRevision}
      sectionAction={null}
      enableRemoteOperations={competition.canEdit === true}
      sectionContent={
        <RepairWorkspace
          competitionId={competition.id}
          matches={competition.matches.map((match) => ({
            id: match.id,
            label: match.label,
            home: match.home,
            away: match.away,
          }))}
        />
      }
    />
  );
}
