import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { CapacityEditor } from "@/components/phase3/CapacityEditor";
import { ResultsWorkspace } from "@/components/phase3/ResultsWorkspace";
import { isOrganiserSection, phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase3CapacityCopy, phase3CapacityMachine } from "@/lib/phase3-capacity";
import { getCapacityDocument } from "@/lib/phase3-capacity.server";
import { phase3ResultsCopy, phase3ResultsMachine, resultVersionLabel } from "@/lib/phase3-results";
import { getResultsDocument } from "@/lib/phase3-results.server";

export default async function CompetitionSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; section: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { id, section } = await params;
  const query = await searchParams;
  if (!isOrganiserSection(section)) notFound();
  const result = await getOrganiserCompetitionView(id);
  if (result.state === "notFound") notFound();
  if (result.state === "permission") redirect("/forbidden");
  if (result.state === "error") throw new Error(phase2Copy.errorBody);
  if (section === phase3CapacityMachine.section) {
    const capacity = await getCapacityDocument(result.competition.id, result.competition.name, query.state);
    return (
      <OrganiserWorkspace
        competition={result.competition}
        section={phase3CapacityMachine.section}
        sectionAction={null}
        pageTitle={phase3CapacityCopy.title}
        pageIntro={phase3CapacityCopy.intro}
        pageEyebrow={phase3CapacityCopy.eyebrow}
        syncLabel={
          capacity.state === phase3CapacityMachine.ready ? phase3CapacityCopy.saved : phase3CapacityCopy.errorTitle
        }
        syncState={
          capacity.state === phase3CapacityMachine.ready
            ? phase3CapacityMachine.saved
            : capacity.state === phase3CapacityMachine.offline
              ? phase3CapacityMachine.offline
              : capacity.state === phase3CapacityMachine.readOnly
                ? phase3CapacityMachine.readOnly
                : phase3CapacityMachine.unavailable
        }
        sectionContent={<CapacityEditor document={capacity} />}
      />
    );
  }
  if (section === phase3ResultsMachine.section) {
    const resultVersionMatch = /(?:^|\s)res_(\d+)(?:$|\s)/.exec(result.competition.publicationRevision);
    const results = await getResultsDocument({
      competitionId: result.competition.id,
      competitionName: result.competition.name,
      divisionId: result.competition.division.id,
      divisionName: result.competition.division.name,
      timeZone: result.competition.timezone,
      currentResultVersion: resultVersionMatch ? Number(resultVersionMatch[1]) : 0,
      ...(query.state ? { previewState: query.state } : {}),
    });
    return (
      <OrganiserWorkspace
        competition={result.competition}
        section={phase3ResultsMachine.section}
        sectionAction={null}
        pageTitle={phase3ResultsCopy.title}
        pageIntro={phase3ResultsCopy.intro}
        pageEyebrow={phase3ResultsCopy.eyebrow}
        syncLabel={
          results.snapshot
            ? `${phase3ResultsCopy.service} ${resultVersionLabel(results.snapshot.resultVersion)}`
            : results.state === phase3ResultsMachine.offline
              ? phase3ResultsCopy.offline
              : phase3ResultsCopy.noStandings
        }
        syncState={
          results.state === phase3ResultsMachine.offline
            ? phase3ResultsMachine.offline
            : results.state === phase3ResultsMachine.readOnly
              ? phase3ResultsMachine.readOnly
              : results.snapshot && results.currentResultVersion > results.snapshot.resultVersion
                ? phase3ResultsMachine.conflict
                : results.snapshot
                  ? phase3ResultsMachine.saved
                  : phase3ResultsMachine.unavailable
        }
        sectionContent={<ResultsWorkspace document={results} />}
      />
    );
  }
  return <OrganiserWorkspace competition={result.competition} section={section} />;
}
