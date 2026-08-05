import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { ScheduleRevisionComparison } from "@/components/phase4/schedule/ScheduleRevisionViews";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase4ScheduleCopy, phase4ScheduleMachine } from "@/lib/phase4-schedule";
import { getScheduleDocument, getScheduleRevisionComparison } from "@/lib/phase4-schedule.server";

export default async function ScheduleComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ left?: string; right?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "unauthenticated") redirect("/api/v1/identity/authorize");
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase4ScheduleCopy.errorBody);
  const document = await getScheduleDocument({
    competitionRouteId: id,
    competitionId: result.competition.id,
    competitionName: result.competition.name,
    timeZone: result.competition.timezone,
    publicationRevision: result.competition.publicationRevision,
  });
  const leftId = query.left ?? document.revisions[1]?.id;
  const rightId = query.right ?? document.revisions[0]?.id;
  const comparison = leftId && rightId ? await getScheduleRevisionComparison(document, leftId, rightId) : null;
  return (
    <OrganiserWorkspace
      competition={result.competition}
      section={phase4ScheduleMachine.section}
      sectionAction={null}
      pageTitle={phase4ScheduleCopy.compare}
      pageIntro={phase4ScheduleCopy.selectTwoBody}
      pageEyebrow={phase4ScheduleCopy.immutableDiff}
      syncLabel={phase4ScheduleCopy.saved}
      syncState={phase4ScheduleMachine.saved}
      sectionContent={<ScheduleRevisionComparison document={document} comparison={comparison} />}
    />
  );
}
