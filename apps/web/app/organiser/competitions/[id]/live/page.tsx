import { notFound, redirect } from "next/navigation";
import { messages, opaqueId } from "@matchday/ui";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { organiserBasePath, playingAreasLabel } from "@/lib/organiser-navigation";
import { organiserRedesignShellEnabled } from "@/lib/organiser-shell.server";

/** Live landing (redesign Phase 2): today's matches by playing area. The full Live redesign is Phase 8. */
export default async function CompetitionLivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Without the redesign shell the competition home already shows the live view.
  if (!(await organiserRedesignShellEnabled())) redirect(organiserBasePath(id));
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase2Copy.errorBody);
  return (
    <OrganiserWorkspace
      competition={result.competition}
      shell={opaqueId("redesign")}
      section={opaqueId("control-room")}
      tab={opaqueId("courts")}
      pageEyebrow={messages.organiserShell.liveTitle}
      pageTitle={playingAreasLabel(result.competition.sportCode)}
      pageIntro={messages.organiserShell.liveIntro}
    />
  );
}
