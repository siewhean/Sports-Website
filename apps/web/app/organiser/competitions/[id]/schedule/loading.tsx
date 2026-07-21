import { messages } from "@matchday/ui";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { ScheduleWorkspace } from "@/components/phase4/schedule/ScheduleWorkspace";
import { phase2Competition } from "@/lib/phase2";
import { phase4ScheduleMachine } from "@/lib/phase4-schedule";
import { scheduleUnavailableDocument } from "@/lib/phase4-schedule.server";

export default function ScheduleLoading() {
  const document = scheduleUnavailableDocument({
    competitionId: phase2Competition.id,
    competitionName: phase2Competition.name,
    timeZone: phase2Competition.timezone,
    publicationRevision: phase2Competition.publicationRevision,
  }, phase4ScheduleMachine.loading);
  return (
    <OrganiserWorkspace
      competition={phase2Competition}
      section={phase4ScheduleMachine.section}
      sectionAction={null}
      pageTitle={messages.phase4Schedule.title}
      pageIntro={messages.phase4Schedule.intro}
      pageEyebrow={messages.phase4Schedule.eyebrow}
      syncLabel={messages.phase4Schedule.loading}
      syncState={phase4ScheduleMachine.unavailable}
      sectionContent={<ScheduleWorkspace document={document} />}
    />
  );
}
