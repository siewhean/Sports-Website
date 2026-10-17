import Link from "next/link";
import { messages } from "@matchday/ui";
import { ArrowRight, Check } from "@phosphor-icons/react/dist/ssr";
import type { CompetitionView } from "@/lib/phase2";
import { publicCompetitionPhase } from "@/lib/phase2-public-phase";
import { modeHref, organiserBasePath } from "@/lib/organiser-navigation";

const copy = messages.organiserShell;

export type SetupStep = Readonly<{ id: keyof typeof copy.steps; done: boolean; href: string }>;

/** The "Before you publish" checklist, worked out from what the competition already has. */
export function setupSteps(competition: CompetitionView): SetupStep[] {
  const base = organiserBasePath(competition.id);
  return [
    { id: "teams", done: competition.division.teamCount > 0, href: `${base}/entries` },
    { id: "venue", done: (competition.availableCapacity ?? 0) > 0, href: `${base}/capacity` },
    { id: "format", done: competition.division.matchCount > 0, href: `${base}/format` },
    {
      id: "schedule",
      done: (competition.scheduleRows?.length ?? 0) > 0 || competition.publishedVersionLabel !== undefined,
      href: `${base}/schedule`,
    },
    { id: "publish", done: competition.publicationState === "published", href: `${base}/publish` },
  ];
}

export function competitionIsRunning(competition: CompetitionView, now = new Date()): boolean {
  return (
    publicCompetitionPhase(
      {
        status: competition.status ?? "",
        startsOn: competition.startsOn,
        endsOn: competition.endsOn,
        timezone: competition.timezone,
        hasLiveMatch: competition.matches.some((match) => match.status === "live"),
      },
      now,
    ) === "live"
  );
}

/**
 * Setup overview (redesign Phase 2). Setup pages never show live scores; while the competition is running this
 * page only offers one link to Live.
 */
export function SetupOverview({ competition }: { competition: CompetitionView }) {
  const steps = setupSteps(competition);
  const done = steps.filter((step) => step.done).length;
  return (
    <div className="p2-overview">
      {competitionIsRunning(competition) ? (
        <p className="p2-overview__live" data-testid="setup-go-to-live">
          <span>{copy.liveRunning}</span>
          <Link className="p2-button p2-button--signal" href={modeHref(competition.id, "live")}>
            {copy.goToLive}
            <ArrowRight aria-hidden="true" />
          </Link>
        </p>
      ) : null}
      <section className="p2-checklist" aria-labelledby="p2-checklist-title">
        <header>
          <h2 id="p2-checklist-title">{copy.checklistTitle}</h2>
          <span>
            {done} / {steps.length}
          </span>
        </header>
        <ol>
          {steps.map((step, index) => (
            <li key={step.id} data-done={step.done}>
              <span className="p2-checklist__mark" aria-hidden="true">
                {step.done ? <Check weight="bold" /> : index + 1}
              </span>
              <span className="p2-checklist__text">
                <strong>{copy.steps[step.id]}</strong>
                <small>{step.done ? copy.stepDone : copy.stepToDo}</small>
              </span>
              <Link href={step.href} aria-label={`${copy.open}: ${copy.steps[step.id]}`}>
                {copy.open}
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
