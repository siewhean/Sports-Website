import { notFound, redirect } from "next/navigation";
import { messages, opaqueId } from "@matchday/ui";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { SetupOverview } from "@/components/phase2/SetupOverview";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { organiserRedesignShellEnabled } from "@/lib/organiser-shell.server";

export default async function CompetitionControlRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase2Copy.errorBody);
  if (!(await organiserRedesignShellEnabled())) return <OrganiserWorkspace competition={result.competition} />;
  // Redesign shell: the competition home is the Setup overview; live widgets moved to /live.
  return (
    <OrganiserWorkspace
      competition={result.competition}
      shell={opaqueId("redesign")}
      tab={opaqueId("overview")}
      pageTitle={messages.organiserShell.overviewTitle}
      pageIntro={messages.organiserShell.overviewIntro}
      sectionContent={<SetupOverview competition={result.competition} />}
    />
  );
}
