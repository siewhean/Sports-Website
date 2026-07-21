import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { ScheduleRevisionHistory } from "@/components/phase4/schedule/ScheduleRevisionViews";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase4ScheduleCopy, phase4ScheduleMachine } from "@/lib/phase4-schedule";
import { getScheduleDocument } from "@/lib/phase4-schedule.server";

export default async function ScheduleRevisionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase4ScheduleCopy.errorBody);
  const document = await getScheduleDocument({ competitionId: result.competition.id, competitionName: result.competition.name, timeZone: result.competition.timezone, publicationRevision: result.competition.publicationRevision });
  return <OrganiserWorkspace competition={result.competition} section={phase4ScheduleMachine.section} sectionAction={null} pageTitle={phase4ScheduleCopy.revisionHistory} pageIntro={phase4ScheduleCopy.immutablePrivateHistory} pageEyebrow={phase4ScheduleCopy.eyebrow} syncLabel={phase4ScheduleCopy.saved} syncState={document.state === phase4ScheduleMachine.ready ? phase4ScheduleMachine.saved : phase4ScheduleMachine.unavailable} sectionContent={<ScheduleRevisionHistory document={document} />} />;
}
