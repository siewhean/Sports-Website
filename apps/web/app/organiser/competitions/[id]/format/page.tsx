import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { FormatDesignerWorkspace } from "@/components/phase4/format/FormatDesignerWorkspace";
import { V1FormatPicker } from "@/components/phase4/format/V1FormatPicker";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { getAssistedSetupDocument } from "@/lib/phase4-assisted-setup.server";
import { formatDivisionOptions, selectFormatDivision } from "@/lib/phase4-format-division";
import { getFormatBuilderDocument } from "@/lib/phase4-format.server";
import { hasAppliedV1Format, hasMaterialisedV1Format } from "@/lib/phase4-v1-format-picker";
import { v1FormatReadiness } from "@/lib/v1-format-readiness";
import { opaqueId } from "@matchday/ui";

export default async function FormatDesignerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ state?: string | string[]; division?: string | string[]; advanced?: string | string[] }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase2Copy.errorBody);

  const competitionId = result.competition.id;
  const setup = await getAssistedSetupDocument(competitionId, result.competition.name);
  const readiness = v1FormatReadiness(setup.setup);
  const entriesHref = `/organiser/competitions/${encodeURIComponent(competitionId)}/entries`;
  const capacityHref = `/organiser/competitions/${encodeURIComponent(competitionId)}/capacity`;
  const scheduleHref = `/organiser/competitions/${encodeURIComponent(competitionId)}/schedule`;

  if (!readiness.ready) {
    return (
      <OrganiserWorkspace
        competition={result.competition}
        section={opaqueId("format")}
        layoutMode={opaqueId("format")}
        sectionAction={null}
        sectionContent={
          <V1FormatPicker
            competitionId={competitionId}
            readiness={readiness}
            entriesHref={entriesHref}
            capacityHref={capacityHref}
            scheduleHref={scheduleHref}
          />
        }
      />
    );
  }

  const divisions = formatDivisionOptions(result.competition.division, result.competition.divisions);
  const selectedDivision = selectFormatDivision(divisions, query.division);
  if (!selectedDivision) notFound();

  const formatDocuments = await Promise.all(
    divisions.map((division) =>
      getFormatBuilderDocument({
        competitionId,
        competitionName: result.competition.name,
        divisionId: division.id,
        divisionName: division.name,
        sportCode: result.competition.sportCode ?? "",
        ...(typeof query.state === "string" ? { previewState: query.state } : {}),
      }),
    ),
  );
  const format = formatDocuments.find((document) => document.divisionId === selectedDivision.id);
  if (!format) notFound();

  const hasAppliedFormat =
    hasAppliedV1Format(setup.setup) &&
    hasMaterialisedV1Format(
      setup.setup,
      formatDocuments.map((document) => ({
        divisionId: document.divisionId,
        revisions: [
          ...document.revisions.map((revision) => ({
            revisionId: revision.revisionId,
            materialised: revision.materialised,
          })),
          ...(document.draft
            ? [{ revisionId: document.draft.draft_id, materialised: document.draft.materialised === true }]
            : []),
        ],
      })),
    );
  const advancedRequested = query.advanced === "1";
  const advancedHref = `/organiser/competitions/${encodeURIComponent(competitionId)}/format?division=${encodeURIComponent(selectedDivision.id)}&advanced=1`;

  return (
    <OrganiserWorkspace
      competition={result.competition}
      section={opaqueId("format")}
      layoutMode={opaqueId("format")}
      sectionAction={null}
      sectionContent={
        advancedRequested ? (
          <FormatDesignerWorkspace key={format.divisionId} page={format} divisions={divisions} />
        ) : (
          <V1FormatPicker
            competitionId={competitionId}
            readiness={readiness}
            hasAppliedFormat={hasAppliedFormat}
            advancedHref={advancedHref}
            entriesHref={entriesHref}
            capacityHref={capacityHref}
            scheduleHref={scheduleHref}
          />
        )
      }
    />
  );
}
