import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { FormatDesignerWorkspace } from "@/components/phase4/format/FormatDesignerWorkspace";
import { V1FormatPicker } from "@/components/phase4/format/V1FormatPicker";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { formatDivisionOptions, selectFormatDivision } from "@/lib/phase4-format-division";
import { getFormatBuilderDocument } from "@/lib/phase4-format.server";
import { getAssistedSetupDocument } from "@/lib/phase4-assisted-setup.server";
import { hasAppliedV1Format, hasMaterialisedV1Format } from "@/lib/phase4-v1-format-picker";
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
  const divisions = formatDivisionOptions(result.competition.division, result.competition.divisions);
  const selectedDivision = selectFormatDivision(divisions, query.division);
  if (!selectedDivision) notFound();
  const formatDocuments = await Promise.all(
    divisions.map((division) =>
      getFormatBuilderDocument({
        competitionId: result.competition.id,
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
  const setup = await getAssistedSetupDocument(result.competition.id, result.competition.name);
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
  const advancedHref = `/organiser/competitions/${encodeURIComponent(result.competition.id)}/format?division=${encodeURIComponent(selectedDivision.id)}&advanced=1`;
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
            competitionId={result.competition.id}
            hasAppliedFormat={hasAppliedFormat}
            advancedHref={advancedHref}
          />
        )
      }
    />
  );
}
