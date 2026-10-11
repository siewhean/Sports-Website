import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { CompetitionSummaryView } from "@/lib/phase2";

let currentFilter = "all";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (typeof initial === "string" && ["all", "live", "upcoming", "completed"].includes(initial)) {
        return [
          currentFilter,
          (val: string) => {
            currentFilter = val;
          },
        ];
      }
      return actual.useState(initial);
    },
  };
});

import { PublicCompetitionsList } from "../../components/phase2/PublicCompetitionsList";

describe("PublicCompetitionsList status filters", () => {
  const competitions: CompetitionSummaryView[] = [
    {
      id: "comp-live",
      name: "Championship Live",
      sport: "canoe_polo",
      status: "live",
      phase: "live",
      dateLabel: "Today",
      slug: "championship-live",
    },
    {
      id: "comp-active",
      name: "Championship Active",
      sport: "canoe_polo",
      status: "active",
      phase: "upcoming",
      dateLabel: "Tomorrow",
      slug: "championship-active",
    },
    {
      id: "comp-published",
      name: "Championship Published",
      sport: "canoe_polo",
      status: "published",
      phase: "upcoming",
      dateLabel: "Next Week",
      slug: "championship-published",
    },
    {
      id: "comp-completed",
      name: "Championship Completed",
      sport: "canoe_polo",
      status: "completed",
      phase: "completed",
      dateLabel: "Yesterday",
      slug: "championship-completed",
    },
    {
      id: "comp-archived",
      name: "Championship Archived",
      sport: "canoe_polo",
      status: "archived",
      phase: "completed",
      dateLabel: "Last Month",
      slug: "championship-archived",
    },
  ];

  it("includes all competitions when filter is 'all'", () => {
    currentFilter = "all";
    const html = renderToString(<PublicCompetitionsList competitions={competitions} />);
    expect(html).toContain("Championship Live");
    expect(html).toContain("Championship Active");
    expect(html).toContain("Championship Published");
    expect(html).toContain("Championship Completed");
    expect(html).toContain("Championship Archived");
  });

  it("classifies by shared phase: only live competitions under the Live filter", () => {
    currentFilter = "live";
    const html = renderToString(<PublicCompetitionsList competitions={competitions} />);
    expect(html).toContain("Championship Live");
    expect(html).not.toContain("Championship Active");
    expect(html).not.toContain("Championship Published");
    expect(html).not.toContain("Championship Completed");
    expect(html).not.toContain("Championship Archived");
  });

  it("classifies upcoming-phase competitions under the Upcoming filter", () => {
    currentFilter = "upcoming";
    const html = renderToString(<PublicCompetitionsList competitions={competitions} />);
    expect(html).not.toContain("Championship Live");
    expect(html).toContain("Championship Active");
    expect(html).toContain("Championship Published");
    expect(html).not.toContain("Championship Completed");
    expect(html).not.toContain("Championship Archived");
  });

  it("classifies completed-phase competitions under the Completed filter", () => {
    currentFilter = "completed";
    const html = renderToString(<PublicCompetitionsList competitions={competitions} />);
    expect(html).not.toContain("Championship Live");
    expect(html).not.toContain("Championship Active");
    expect(html).not.toContain("Championship Published");
    expect(html).toContain("Championship Completed");
    expect(html).toContain("Championship Archived");
  });
});
