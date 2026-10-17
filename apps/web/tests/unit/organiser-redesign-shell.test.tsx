import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { OrganiserWorkspace } from "../../components/phase2/OrganiserWorkspace";
import { competitionIsRunning, setupSteps, SetupOverview } from "../../components/phase2/SetupOverview";
import { initialsOf } from "../../components/foundation/AccountMenu";
import { phase2Competition, type CompetitionView } from "../../lib/phase2";

async function render(element: Promise<React.ReactElement>): Promise<string> {
  return renderToString(await element);
}

const draft: CompetitionView = {
  ...phase2Competition,
  status: "draft",
  matches: phase2Competition.matches.map((match) => ({ ...match, status: "scheduled" as const })),
  publicationState: "draft",
};

/** Live-only widgets from the control room; Setup pages must never render them. */
const liveWidgets = ["p2-live-result", "p2-next", "p2-control-grid"];

describe("redesign Phase 2 shell", () => {
  it("renders the Setup / Live switch, the Setup tabs and the account menu", async () => {
    const html = await render(
      OrganiserWorkspace({ competition: draft, shell: "redesign", tab: "overview", sectionContent: <p>body</p> }),
    );
    expect(html).toContain('aria-label="Setup or Live"');
    expect(html).toContain('aria-label="Setup sections"');
    expect(html).toContain('data-organiser-mode="setup"');
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Overview<\/a>/u);
    expect(html).toContain('aria-label="Your account and appearance"');
    expect(html).not.toContain("Live mode");
  });

  it("marks Live with a text label, not colour alone", async () => {
    const html = await render(
      OrganiserWorkspace({ competition: phase2Competition, shell: "redesign", section: "control-room", tab: "courts" }),
    );
    expect(html).toContain('data-organiser-mode="live"');
    expect(html).toContain("Live mode");
    expect(html).toContain('aria-label="Live sections"');
    expect(html).toMatch(/<a[^>]*aria-current="true"[^>]*>.*Live<\/a>/u);
  });

  it("never shows live widgets on Setup pages", async () => {
    const running: CompetitionView = { ...phase2Competition, status: "live" };
    const html = await render(
      OrganiserWorkspace({
        competition: running,
        shell: "redesign",
        tab: "overview",
        sectionContent: <SetupOverview competition={running} />,
      }),
    );
    for (const widget of liveWidgets) expect(html).not.toContain(widget);
    // While running, Overview offers exactly one way into Live.
    expect(html).toContain('data-testid="setup-go-to-live"');
  });

  it("keeps help to the one heading tip; the shell adds none", async () => {
    const html = await render(
      OrganiserWorkspace({ competition: draft, shell: "redesign", tab: "overview", pageIntro: "One line." }),
    );
    expect(html.match(/class="md-infotip"/gu) ?? []).toHaveLength(1);
  });

  it("keeps the classic shell when asked", async () => {
    const html = await render(OrganiserWorkspace({ competition: draft, shell: "classic" }));
    expect(html).toContain('aria-label="Competition workspace"');
    expect(html).not.toContain('aria-label="Setup or Live"');
  });
});

describe("setup overview", () => {
  it("works out the checklist from the competition", () => {
    const empty: CompetitionView = {
      ...draft,
      division: { ...draft.division, teamCount: 0, matchCount: 0 },
      availableCapacity: null,
      scheduleRows: [],
      publishedVersionLabel: undefined,
    };
    expect(setupSteps(empty).map((step) => [step.id, step.done])).toEqual([
      ["teams", false],
      ["venue", false],
      ["format", false],
      ["schedule", false],
      ["publish", false],
    ]);
    const ready: CompetitionView = { ...phase2Competition, publicationState: "published", availableCapacity: 40 };
    expect(setupSteps(ready).every((step) => step.done)).toBe(true);
  });

  it("treats a competition as running only while it is live", () => {
    expect(competitionIsRunning(draft)).toBe(false);
    expect(competitionIsRunning({ ...draft, status: "live" })).toBe(true);
  });
});

describe("account menu", () => {
  it("shows up to two initials", () => {
    expect(initialsOf("Siew Hean")).toBe("SH");
    expect(initialsOf("Nur Aisyah binti Ali")).toBe("NA");
    expect(initialsOf("madonna")).toBe("M");
    expect(initialsOf(null)).toBe("");
  });
});
