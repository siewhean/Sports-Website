import { notFound, redirect } from "next/navigation";
import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { CapacityEditor } from "@/components/phase3/CapacityEditor";
import { EntriesEditor } from "@/components/phase3/EntriesEditor";
import { ResultsWorkspace } from "@/components/phase3/ResultsWorkspace";
import { V1PublishWorkspace } from "@/components/phase3/V1PublishWorkspace";
import { V1ResultsWorkspace } from "@/components/phase3/V1ResultsWorkspace";
import { isOrganiserSection, phase2Copy } from "@/lib/phase2";
import { getOrganiserCompetitionView } from "@/lib/phase2-organiser.server";
import { phase3CapacityCopy, phase3CapacityMachine } from "@/lib/phase3-capacity";
import { getCapacityDocument } from "@/lib/phase3-capacity.server";
import { phase3EntriesCopy, phase3EntriesMachine, totalActiveEntries } from "@/lib/phase3-entries";
import { phase3ResultsCopy, phase3ResultsMachine, resultVersionLabel } from "@/lib/phase3-results";
import { getResultsDocument } from "@/lib/phase3-results.server";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";

export default async function CompetitionSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; section: string }>;
  searchParams: Promise<{ state?: string; match?: string }>;
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
  if (section === phase3EntriesMachine.section) {
    const divisions = (result.competition.divisions ?? []).map((division) => ({
      id: division.id,
      name: division.name,
      entryLimit: division.entryLimit ?? 16,
      entries: division.entries ?? [],
    }));
    return (
      <OrganiserWorkspace
        competition={result.competition}
        section={phase3EntriesMachine.section}
        sectionAction={null}
        pageTitle={phase3EntriesCopy.title}
        pageIntro={phase3EntriesCopy.intro}
        pageEyebrow={phase3EntriesCopy.eyebrow}
        syncLabel={`${totalActiveEntries(divisions)} / 16`}
        syncState={phase3CapacityMachine.saved}
        sectionContent={
          <EntriesEditor
            competitionId={result.competition.id}
            initialDivisions={divisions}
            canEdit={result.competition.canEdit ?? false}
          />
        }
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
        sectionContent={
          <V1ResultsWorkspace competition={result.competition}>
            <ResultsWorkspace
              document={results}
              matches={result.competition.matches}
              initialMatchId={query.match}
              enableRemoteOperations={!demoFixturesEnabled()}
            />
          </V1ResultsWorkspace>
        }
      />
    );
  }
  if (section === "publish") {
    return (
      <OrganiserWorkspace
        competition={result.competition}
        section="publish"
        sectionAction={null}
        pageTitle={phase2Copy.publishTitle}
        pageIntro={phase2Copy.publishIntro}
        syncLabel={result.competition.publishedVersionLabel ?? phase2Copy.notPublished}
        syncState={result.competition.publicationState === "published" ? "saved" : "unavailable"}
        sectionContent={<V1PublishWorkspace competition={result.competition} />}
      />
    );
  }
  return (
    <OrganiserWorkspace competition={result.competition} section={section} accessApiEnabled={!demoFixturesEnabled()} />
  );
}
