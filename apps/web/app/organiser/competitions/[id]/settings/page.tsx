import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { SportSettingsEditor } from "@/components/phase3/SportSettingsEditor";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { getSportSettingsDocument } from "@/lib/phase3-sport-settings.server";
import { phase3SettingsCopy, phase3SettingsMachine, settingsSyncPresentation } from "@/lib/phase3-sport-settings";

export default async function CompetitionSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const competitionResult = await getOrganiserCompetitionView(id);
  if (competitionResult.state === "notFound") notFound();
  if (competitionResult.state === "permission") redirect("/forbidden");
  if (competitionResult.state === "error") throw new Error(phase2Copy.errorBody);
  const document = await getSportSettingsDocument({
    competitionId: competitionResult.competition.id,
    competitionName: competitionResult.competition.name,
    previewState: query.state,
  });
  const divisionHref = `/organiser/competitions/${encodeURIComponent(id)}/settings/divisions/${encodeURIComponent(competitionResult.competition.division.id)}`;
  const sync = settingsSyncPresentation(document);
  return (
    <OrganiserWorkspace
      competition={competitionResult.competition}
      section={phase3SettingsMachine.section}
      sectionAction={null}
      pageTitle={phase3SettingsCopy.pageTitle}
      pageIntro={phase3SettingsCopy.pageIntro}
      pageEyebrow={phase3SettingsCopy.competition}
      syncLabel={sync.label}
      syncState={sync.state}
      sectionContent={
        <SportSettingsEditor
          document={document}
          divisionHref={divisionHref}
          competitionHref={`/organiser/competitions/${encodeURIComponent(id)}/settings`}
        />
      }
    />
  );
}
