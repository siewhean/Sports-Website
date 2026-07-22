import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { ScheduleWorkspace } from "@/components/phase4/schedule/ScheduleWorkspace";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase4ScheduleCopy, phase4ScheduleMachine } from "@/lib/phase4-schedule";
import { getScheduleDocument } from "@/lib/phase4-schedule.server";

export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase4ScheduleCopy.errorBody);
  const document = await getScheduleDocument({
    competitionId: result.competition.id,
    competitionName: result.competition.name,
    timeZone: result.competition.timezone,
    publicationRevision: result.competition.publicationRevision,
    ...(query.state ? { previewState: query.state } : {}),
  });
  return (
    <OrganiserWorkspace
      competition={result.competition}
      section={phase4ScheduleMachine.section}
      sectionAction={null}
      pageTitle={phase4ScheduleCopy.title}
      pageIntro={phase4ScheduleCopy.intro}
      pageEyebrow={phase4ScheduleCopy.eyebrow}
      syncLabel={
        document.currentRevision
          ? `${phase4ScheduleCopy.draft} ${document.currentRevision.revision}`
          : phase4ScheduleCopy.saved
      }
      syncState={
        document.state === phase4ScheduleMachine.offline
          ? phase4ScheduleMachine.offline
          : document.state === phase4ScheduleMachine.readOnly
            ? phase4ScheduleMachine.readOnly
            : document.state === phase4ScheduleMachine.ready
              ? phase4ScheduleMachine.saved
              : phase4ScheduleMachine.unavailable
      }
      sectionContent={<ScheduleWorkspace document={document} />}
    />
  );
}
