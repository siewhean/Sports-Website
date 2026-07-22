import { notFound, redirect } from "next/navigation";
import { ScheduleMoveFlow } from "@/components/phase4/schedule/ScheduleMoveFlow";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase4ScheduleCopy, phase4ScheduleMachine } from "@/lib/phase4-schedule";
import { getScheduleDocument, getScheduleRevisionDetail } from "@/lib/phase4-schedule.server";

export default async function ScheduleMovePage({
  params,
}: {
  params: Promise<{ id: string; revisionId: string; matchId: string }>;
}) {
  const { id, revisionId, matchId } = await params;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase4ScheduleCopy.errorBody);
  const document = await getScheduleDocument({
    competitionId: result.competition.id,
    competitionName: result.competition.name,
    timeZone: result.competition.timezone,
    publicationRevision: result.competition.publicationRevision,
  });
  const requested = await getScheduleRevisionDetail(document, revisionId);
  if (
    !requested ||
    (requested.status !== phase4ScheduleMachine.draft && requested.status !== phase4ScheduleMachine.readyForReview)
  )
    notFound();
  const selectedDocument =
    requested.id === document.currentRevision?.id
      ? document
      : { ...document, currentRevision: requested, canPublish: false };
  const match = document.matches.find((item) => item.id === matchId);
  if (!match) notFound();
  return <ScheduleMoveFlow document={selectedDocument} match={match} />;
}
