import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { AssistedSetupJourney } from "@/components/phase4/setup/AssistedSetupJourney";
import { SyncCompetitionSetupResume } from "@/components/phase4/setup/CompetitionSetupResume";
import { demoCompetitionDraftOwnerId, demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { readCurrentIdentitySession } from "@/lib/identity-session.server";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase4SetupCopy } from "@/lib/phase4-assisted-setup";
import { getAssistedSetupDocument } from "@/lib/phase4-assisted-setup.server";
import { opaqueId, translate as t } from "@matchday/ui";

export default async function AssistedSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ state?: string; step?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const demo = demoFixturesEnabled();
  const [session, result] = await Promise.all([
    demo ? Promise.resolve(null) : readCurrentIdentitySession(),
    getOrganiserCompetitionView(id),
  ]);

  if (!demo) {
    if (session?.status === "step_up_required") redirect("/sign-in?reason=step-up");
    if (session?.status !== "authenticated") redirect("/sign-in");
  }
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase2Copy.errorBody);

  const viewer = session?.status === "authenticated" ? session.identity : null;
  const resumeOwnerId = viewer?.accountId ?? demoCompetitionDraftOwnerId;
  const setup = await getAssistedSetupDocument(result.competition.id, result.competition.name, query.state, query.step);
  const setupSyncLabel =
    setup.setup?.autosave.status === "saving"
      ? phase4SetupCopy.saving
      : setup.state === "offline"
        ? phase4SetupCopy.offline
        : setup.state === "conflict"
          ? phase4SetupCopy.conflict
          : setup.state === "expired"
            ? t("prototype.5fa07d1f9ee4")
            : setup.state === "read-only"
              ? phase4SetupCopy.readOnly
              : phase4SetupCopy.saved;

  return (
    <OrganiserWorkspace
      competition={result.competition}
      section={opaqueId("setup")}
      layoutMode={opaqueId("setup")}
      sectionAction={null}
      pageTitle={phase4SetupCopy.title}
      pageIntro={phase4SetupCopy.intro}
      syncLabel={viewer ? `${viewer.displayName} · ${setupSyncLabel}` : setupSyncLabel}
      syncState={
        setup.state === "offline"
          ? opaqueId("offline")
          : setup.state === "conflict"
            ? opaqueId("conflict")
            : setup.state === "expired"
              ? opaqueId("read-only")
              : setup.state === "read-only"
                ? opaqueId("read-only")
                : setup.state === "ready"
                  ? opaqueId("saved")
                  : opaqueId("unavailable")
      }
      sectionContent={
        <>
          {setup.setup ? (
            <SyncCompetitionSetupResume
              accountId={resumeOwnerId}
              competitionId={result.competition.id}
              competitionName={result.competition.name}
              active={
                setup.setup.status === "active" &&
                setup.setup.competition_status === "draft" &&
                !setup.setup.read_only &&
                setup.setup.permission === "write"
              }
            />
          ) : null}
          <AssistedSetupJourney
            key={`${setup.state}:${setup.setup?.id ?? opaqueId("no-document")}:${setup.setup?.revision ?? 0}`}
            document={setup}
          />
        </>
      }
    />
  );
}
