import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { RulesPage } from "@/components/phase3/RulesPage";
import { SportSettingsEditor } from "@/components/phase3/SportSettingsEditor";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { getRulesHistory, getSportSettingsDocument } from "@/lib/phase3-sport-settings.server";
import { redesignRulesEnabled } from "@/lib/redesign-rules.server";
import { phase3SettingsCopy, phase3SettingsMachine, settingsSyncPresentation } from "@/lib/phase3-sport-settings";

export default async function DivisionSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; divisionId: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const [{ id, divisionId }, query] = await Promise.all([params, searchParams]);
  const competitionResult = await getOrganiserCompetitionView(id);
  if (competitionResult.state === "notFound") notFound();
  if (competitionResult.state === "permission") redirect("/forbidden");
  if (competitionResult.state === "error") throw new Error(phase2Copy.errorBody);
  const division = competitionResult.competition.divisions?.find((item) => item.id === divisionId);
  if (competitionResult.competition.divisions && !division) notFound();
  const document = await getSportSettingsDocument({
    competitionId: competitionResult.competition.id,
    competitionName: competitionResult.competition.name,
    divisionId,
    divisionName: division?.name ?? competitionResult.competition.division.name,
    previewState: query.state,
  });
  const sync = settingsSyncPresentation(document);
  // Redesign Phase 4 (flag redesign_p4_rules): the grouped Rules page replaces the settings editor.
  const rulesHistory = (await redesignRulesEnabled()) ? await getRulesHistory(competitionResult.competition.id) : null;
  return (
    <OrganiserWorkspace
      competition={competitionResult.competition}
      section={phase3SettingsMachine.section}
      sectionAction={null}
      pageTitle={phase3SettingsCopy.pageTitle}
      pageIntro={phase3SettingsCopy.pageIntro}
      pageEyebrow={document.context.divisionName ?? phase3SettingsCopy.division}
      syncLabel={sync.label}
      syncState={sync.state}
      sectionContent={
        rulesHistory ? (
          <RulesPage
            history={rulesHistory}
            document={document}
            competitionHref={`/organiser/competitions/${encodeURIComponent(id)}/settings`}
            divisionHref={`/organiser/competitions/${encodeURIComponent(id)}/settings/divisions/${encodeURIComponent(divisionId)}`}
          />
        ) : (
          <SportSettingsEditor
            document={document}
            competitionHref={`/organiser/competitions/${encodeURIComponent(id)}/settings`}
            divisionHref={`/organiser/competitions/${encodeURIComponent(id)}/settings/divisions/${encodeURIComponent(divisionId)}`}
          />
        )
      }
    />
  );
}
