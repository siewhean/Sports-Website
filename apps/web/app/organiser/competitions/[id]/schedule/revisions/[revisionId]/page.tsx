import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { ScheduleRevisionDetail } from "@/components/phase4/schedule/ScheduleRevisionViews";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase4ScheduleCopy, phase4ScheduleMachine } from "@/lib/phase4-schedule";
import { getScheduleDocument, getScheduleRevisionDetail } from "@/lib/phase4-schedule.server";

export default async function ScheduleRevisionPage({ params }: { params: Promise<{ id: string; revisionId: string }> }) {
  const { id, revisionId } = await params;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase4ScheduleCopy.errorBody);
  const document = await getScheduleDocument({ competitionId: result.competition.id, competitionName: result.competition.name, timeZone: result.competition.timezone, publicationRevision: result.competition.publicationRevision });
  const revision = await getScheduleRevisionDetail(document, revisionId);
  if (!revision) notFound();
  return <OrganiserWorkspace competition={result.competition} section={phase4ScheduleMachine.section} sectionAction={null} pageTitle={`${phase4ScheduleCopy.draft} ${revision.revision}`} pageIntro={phase4ScheduleCopy.immutablePrivateHistory} pageEyebrow={phase4ScheduleCopy.scheduleRevision} syncLabel={revision.status.replaceAll("_", " ")} syncState={revision.status === phase4ScheduleMachine.expired ? phase4ScheduleMachine.readOnly : phase4ScheduleMachine.saved} sectionContent={<ScheduleRevisionDetail document={document} revision={revision} />} />;
}
