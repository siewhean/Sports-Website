import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { AssistedSetupWorkspaceV2 } from "@/components/phase4/setup/AssistedSetupWorkspaceV2";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase4SetupCopy } from "@/lib/phase4-assisted-setup";
import { getAssistedSetupDocument } from "@/lib/phase4-assisted-setup.server";
import { opaqueId } from "@matchday/ui";

export default async function AssistedSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ state?: string; step?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase2Copy.errorBody);
  const setup = await getAssistedSetupDocument(result.competition.id, result.competition.name, query.state, query.step);
  return (
    <OrganiserWorkspace
      competition={result.competition}
      section={opaqueId("setup")}
      layoutMode={opaqueId("setup")}
      sectionAction={null}
      pageTitle={phase4SetupCopy.title}
      pageIntro={phase4SetupCopy.intro}
      syncLabel={
        setup.setup?.autosave.status === "saving"
          ? phase4SetupCopy.saving
          : setup.state === "offline"
            ? phase4SetupCopy.offline
            : setup.state === "conflict"
              ? phase4SetupCopy.conflict
              : setup.state === "read-only"
                ? phase4SetupCopy.readOnly
                : phase4SetupCopy.saved
      }
      syncState={
        setup.state === "offline"
          ? opaqueId("offline")
          : setup.state === "conflict"
            ? opaqueId("conflict")
            : setup.state === "read-only"
              ? opaqueId("read-only")
              : setup.state === "ready"
                ? opaqueId("saved")
                : opaqueId("unavailable")
      }
      sectionContent={<AssistedSetupWorkspaceV2 document={setup} />}
    />
  );
}
