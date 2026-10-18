import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { FormatDesignerWorkspace } from "@/components/phase4/format/FormatDesignerWorkspace";
import { V1FormatPicker } from "@/components/phase4/format/V1FormatPicker";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { getCapacityDocument } from "@/lib/phase3-capacity.server";
import { getAssistedSetupDocument } from "@/lib/phase4-assisted-setup.server";
import { formatDivisionOptions, selectFormatDivision } from "@/lib/phase4-format-division";
import { getFormatBuilderDocument } from "@/lib/phase4-format.server";
import { redesignFormatCardsEnabled } from "@/lib/redesign-format-cards.server";
import { v1CanonicalFormatReadiness } from "@/lib/v1-format-readiness";
import { opaqueId } from "@matchday/ui";

export default async function FormatDesignerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    state?: string | string[];
    division?: string | string[];
    mode?: string | string[];
    advanced?: string | string[];
  }>;
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

  const isCardsEnabled = await redesignFormatCardsEnabled();
  const isEditorMode = query.mode === "editor" || query.advanced === "1";

  if (isCardsEnabled && !isEditorMode) {
    const [setup, capacity] = await Promise.all([
      getAssistedSetupDocument(result.competition.id, result.competition.name),
      getCapacityDocument(result.competition.id, result.competition.name),
    ]);
    const readiness = v1CanonicalFormatReadiness({
      divisions: result.competition.divisions ?? [],
      capacity: {
        areaCount: capacity.areas.length,
        availableMatchSlots: capacity.summary?.availableMatchSlots ?? 0,
      },
    });

    const entriesHref = `/organiser/competitions/${encodeURIComponent(result.competition.id)}/entries`;
    const capacityHref = `/organiser/competitions/${encodeURIComponent(result.competition.id)}/capacity`;
    const scheduleHref = `/organiser/competitions/${encodeURIComponent(result.competition.id)}/schedule`;
    const advancedHref = `/organiser/competitions/${encodeURIComponent(result.competition.id)}/format?division=${encodeURIComponent(selectedDivision.id)}&mode=editor`;

    const pickerDivisions = divisions.map((division) => {
      const setupDivision = setup.setup?.values?.entries?.divisions?.find((d) => d.division_id === division.id);
      const entryCount = setupDivision
        ? setupDivision.entry_ids.length || setupDivision.confirmed_count + setupDivision.placeholder_count
        : 12;
      return {
        id: division.id,
        name: division.name,
        entryCount,
      };
    });

    return (
      <OrganiserWorkspace
        competition={result.competition}
        section={opaqueId("format")}
        layoutMode={opaqueId("format")}
        sectionAction={null}
        sectionContent={
          <V1FormatPicker
            competitionId={result.competition.id}
            readiness={readiness}
            initialDocument={setup.setup}
            initialDivisionId={selectedDivision.id}
            divisions={pickerDivisions}
            entriesHref={entriesHref}
            capacityHref={capacityHref}
            scheduleHref={scheduleHref}
            advancedHref={advancedHref}
            isRedesignP5CardsEnabled={true}
          />
        }
      />
    );
  }

  const format = await getFormatBuilderDocument({
    competitionId: result.competition.id,
    competitionName: result.competition.name,
    divisionId: selectedDivision.id,
    divisionName: selectedDivision.name,
    sportCode: result.competition.sportCode ?? "",
    ...(typeof query.state === "string" ? { previewState: query.state } : {}),
  });
  return (
    <OrganiserWorkspace
      competition={result.competition}
      section={opaqueId("format")}
      layoutMode={opaqueId("format")}
      sectionAction={null}
      sectionContent={<FormatDesignerWorkspace key={format.divisionId} page={format} divisions={divisions} />}
    />
  );
}
