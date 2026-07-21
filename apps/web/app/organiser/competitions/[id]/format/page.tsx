import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { FormatDesignerWorkspace } from "@/components/phase4/format/FormatDesignerWorkspace";
import { phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { getFormatBuilderDocument } from "@/lib/phase4-format.server";
import { opaqueId } from "@matchday/ui";

export default async function FormatDesignerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ state?: string; division?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase2Copy.errorBody);
  const selectedDivision =
    result.competition.divisions?.find((division) => division.id === query.division) ?? result.competition.division;
  const format = await getFormatBuilderDocument({
    competitionId: result.competition.id,
    competitionName: result.competition.name,
    divisionId: selectedDivision.id,
    divisionName: selectedDivision.name,
    sportCode: result.competition.sportCode ?? "",
    ...(query.state ? { previewState: query.state } : {}),
  });
  return (
    <OrganiserWorkspace
      competition={result.competition}
      section={opaqueId("format")}
      layoutMode={opaqueId("format")}
      sectionAction={null}
      sectionContent={<FormatDesignerWorkspace page={format} />}
    />
  );
}
