import { notFound, redirect } from "next/navigation";
import { opaqueId } from "@matchday/ui";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { OfficialsRosterView } from "@/components/phase4/officials/OfficialsRosterView";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { getOfficialWorkspace } from "@/lib/phase4-officials.server";
import { getScheduleDocument } from "@/lib/phase4-schedule.server";
import { phase2Copy } from "@/lib/phase2";

export default async function OfficialsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ state?: string; match?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase2Copy.errorBody);

  const [workspace, scheduleDoc] = await Promise.all([
    getOfficialWorkspace(result.competition.id, result.competition.canEdit ?? false),
    getScheduleDocument({
      competitionId: result.competition.id,
      competitionName: result.competition.name,
      timeZone: result.competition.timezone,
      publicationRevision: result.competition.publicationRevision,
      ...(query.state ? { previewState: query.state } : {}),
    }),
  ]);

  return (
    <OrganiserWorkspace
      competition={result.competition}
      section={opaqueId("officials")}
      sectionAction={null}
      pageTitle={phase2Copy.officialsTitle}
      pageIntro={phase2Copy.officialsIntro}
      pageEyebrow={result.competition.division?.name ?? result.competition.name}
      syncState={opaqueId("saved")}
      sectionContent={
        <OfficialsRosterView
          document={workspace}
          scheduleDocument={scheduleDoc}
          timeZone={result.competition.timezone}
          initialMatchId={query.match}
        />
      }
    />
  );
}
