import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  NoSolutionOfficialDiagnostics,
  formatOverlapMatchLabels,
  matchCode,
  matchLabel,
} from "../../components/phase4/schedule/NoSolutionOfficialDiagnostics";
import { phase4ScheduleCopy, type ScheduleMatch, type ScheduleOfficialDiagnostic } from "../../lib/phase4-schedule";

const competitionId = "10000000-0000-4000-8000-000000000001";
const match1Id = "30000000-0000-4000-8000-000000000001";
const match2Id = "30000000-0000-4000-8000-000000000002";
const unknownMatchId1 = "98765432-0000-4000-8000-000000000001";
const unknownMatchId2 = "87654321-0000-4000-8000-000000000002";

const mockMatches: readonly ScheduleMatch[] = [
  {
    id: match1Id,
    divisionId: "div-1",
    divisionName: "Division 1",
    roundLabel: "Round 1",
    code: "M1",
    homeLabel: "Team Alpha",
    awayLabel: "Team Beta",
    durationMinutes: 40,
    dependencyMatchIds: [],
    status: "unscheduled",
  },
  {
    id: match2Id,
    divisionId: "div-1",
    divisionName: "Division 1",
    roundLabel: "Round 2",
    code: "M2",
    homeLabel: "Team Gamma",
    awayLabel: "Team Delta",
    durationMinutes: 40,
    dependencyMatchIds: [],
    status: "unscheduled",
  },
];

describe("NoSolutionOfficialDiagnostics helper functions", () => {
  it("matchLabel returns code and roundLabel when match resolves", () => {
    expect(matchLabel(match1Id, mockMatches)).toBe("M1 (Round 1)");
  });

  it("matchLabel returns generic copy without UUID or fragment when match is unresolved", () => {
    const label = matchLabel(unknownMatchId1, mockMatches);
    expect(label).toBe(phase4ScheduleCopy.anAffectedMatch);
    expect(label).not.toContain(unknownMatchId1);
    expect(label).not.toContain(unknownMatchId1.slice(0, 8));
  });

  it("matchCode returns code when match resolves", () => {
    expect(matchCode(match1Id, mockMatches)).toBe("M1");
  });

  it("matchCode returns generic copy without UUID or fragment when match is unresolved", () => {
    const code = matchCode(unknownMatchId1, mockMatches);
    expect(code).toBe(phase4ScheduleCopy.anAffectedMatch);
    expect(code).not.toContain(unknownMatchId1);
    expect(code).not.toContain(unknownMatchId1.slice(0, 8));
  });

  it("formatOverlapMatchLabels formats all known matches with comma separation", () => {
    expect(formatOverlapMatchLabels([match1Id, match2Id], mockMatches)).toBe("M1, M2");
  });

  it("formatOverlapMatchLabels formats one known and one unknown with another affected match copy", () => {
    const result = formatOverlapMatchLabels([match1Id, unknownMatchId1], mockMatches);
    expect(result).toBe("M1 and another affected match");
    expect(result).not.toContain(unknownMatchId1);
    expect(result).not.toContain(unknownMatchId1.slice(0, 8));
  });

  it("formatOverlapMatchLabels formats multiple known and one unknown", () => {
    const result = formatOverlapMatchLabels([match1Id, match2Id, unknownMatchId1], mockMatches);
    expect(result).toBe("M1, M2 and another affected match");
    expect(result).not.toContain(unknownMatchId1);
  });

  it("formatOverlapMatchLabels formats one known and multiple unknowns with one or more affected matches copy", () => {
    const result = formatOverlapMatchLabels([match1Id, unknownMatchId1, unknownMatchId2], mockMatches);
    expect(result).toBe("M1 and one or more affected matches");
    expect(result).not.toContain(unknownMatchId1);
    expect(result).not.toContain(unknownMatchId2);
    expect(result).not.toContain(unknownMatchId1.slice(0, 8));
    expect(result).not.toContain(unknownMatchId2.slice(0, 8));
  });

  it("formatOverlapMatchLabels formats zero known and one unknown", () => {
    const result = formatOverlapMatchLabels([unknownMatchId1], mockMatches);
    expect(result).toBe(phase4ScheduleCopy.anAffectedMatch);
    expect(result).not.toContain(unknownMatchId1);
  });

  it("formatOverlapMatchLabels formats zero known and multiple unknowns", () => {
    const result = formatOverlapMatchLabels([unknownMatchId1, unknownMatchId2], mockMatches);
    expect(result).toBe(phase4ScheduleCopy.oneOrMoreAffectedMatches);
    expect(result).not.toContain(unknownMatchId1);
    expect(result).not.toContain(unknownMatchId2);
  });
});

describe("NoSolutionOfficialDiagnostics component rendering", () => {
  describe("official_unavailable", () => {
    it("renders resolved match with code, round label, and match deep link", () => {
      const diagnostics: readonly ScheduleOfficialDiagnostic[] = [
        {
          code: "official_unavailable",
          severity: "required",
          matchIds: [match1Id],
        },
      ];

      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics,
        }),
      );

      expect(html).toContain("M1 (Round 1)");
      expect(html).toContain(
        `/organiser/competitions/${encodeURIComponent(competitionId)}/officials?match=${encodeURIComponent(match1Id)}`,
      );
      expect(html).toContain(phase4ScheduleCopy.reviewOfficials);
      expect(html).toContain(phase4ScheduleCopy.officialUnavailableForMatch);
    });

    it("renders unresolved match with generic copy, no UUID/fragment, and general link without ?match=", () => {
      const diagnostics: readonly ScheduleOfficialDiagnostic[] = [
        {
          code: "official_unavailable",
          severity: "required",
          matchIds: [unknownMatchId1],
        },
      ];

      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics,
        }),
      );

      // Verifies no UUID leakage
      expect(html).not.toContain(unknownMatchId1);
      expect(html).not.toContain(unknownMatchId1.slice(0, 8));

      // Verifies human-safe registered copy
      expect(html).toContain(phase4ScheduleCopy.anAffectedMatch);

      // Verifies general link without ?match=
      expect(html).toContain(`/organiser/competitions/${encodeURIComponent(competitionId)}/officials`);
      expect(html).not.toContain("?match=");
      expect(html).toContain(phase4ScheduleCopy.reviewOfficials);
    });
  });

  describe("official_overlap", () => {
    it("renders all resolved matches with codes and general link", () => {
      const diagnostics: readonly ScheduleOfficialDiagnostic[] = [
        {
          code: "official_overlap",
          severity: "required",
          matchIds: [match1Id, match2Id],
        },
      ];

      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics,
        }),
      );

      expect(html).toContain("M1, M2");
      expect(html).toContain(`/organiser/competitions/${encodeURIComponent(competitionId)}/officials`);
      expect(html).not.toContain("?match=");
      expect(html).toContain(phase4ScheduleCopy.officialOverlapForMatches);
    });

    it("renders 1 resolved and 1 unresolved match with human-safe copy and no UUID leakage", () => {
      const diagnostics: readonly ScheduleOfficialDiagnostic[] = [
        {
          code: "official_overlap",
          severity: "required",
          matchIds: [match1Id, unknownMatchId1],
        },
      ];

      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics,
        }),
      );

      expect(html).not.toContain(unknownMatchId1);
      expect(html).not.toContain(unknownMatchId1.slice(0, 8));
      expect(html).toContain("M1 and another affected match");
      expect(html).not.toContain("?match=");
      expect(html).toContain(`/organiser/competitions/${encodeURIComponent(competitionId)}/officials`);
    });

    it("renders 1 resolved and multiple unresolved matches with human-safe copy and no UUID leakage", () => {
      const diagnostics: readonly ScheduleOfficialDiagnostic[] = [
        {
          code: "official_overlap",
          severity: "required",
          matchIds: [match1Id, unknownMatchId1, unknownMatchId2],
        },
      ];

      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics,
        }),
      );

      expect(html).not.toContain(unknownMatchId1);
      expect(html).not.toContain(unknownMatchId2);
      expect(html).not.toContain(unknownMatchId1.slice(0, 8));
      expect(html).not.toContain(unknownMatchId2.slice(0, 8));
      expect(html).toContain("M1 and one or more affected matches");
      expect(html).not.toContain("?match=");
    });

    it("renders multiple unresolved matches with human-safe copy and no UUID leakage", () => {
      const diagnostics: readonly ScheduleOfficialDiagnostic[] = [
        {
          code: "official_overlap",
          severity: "required",
          matchIds: [unknownMatchId1, unknownMatchId2],
        },
      ];

      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics,
        }),
      );

      expect(html).not.toContain(unknownMatchId1);
      expect(html).not.toContain(unknownMatchId2);
      expect(html).not.toContain(unknownMatchId1.slice(0, 8));
      expect(html).not.toContain(unknownMatchId2.slice(0, 8));
      expect(html).toContain(phase4ScheduleCopy.oneOrMoreAffectedMatches);
      expect(html).not.toContain("?match=");
    });

    it("renders single unresolved match with human-safe copy and no UUID leakage", () => {
      const diagnostics: readonly ScheduleOfficialDiagnostic[] = [
        {
          code: "official_overlap",
          severity: "required",
          matchIds: [unknownMatchId1],
        },
      ];

      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics,
        }),
      );

      expect(html).not.toContain(unknownMatchId1);
      expect(html).not.toContain(unknownMatchId1.slice(0, 8));
      expect(html).toContain(phase4ScheduleCopy.anAffectedMatch);
      expect(html).not.toContain("?match=");
    });
  });

  describe("fallback and empty states", () => {
    it("renders generic notice when diagnostics is null", () => {
      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics: null,
        }),
      );

      expect(html).toContain(phase4ScheduleCopy.noFeasibleScheduleGeneric);
      expect(html).not.toContain(phase4ScheduleCopy.officialConflictsDetected);
    });

    it("renders generic notice when diagnostics array is empty", () => {
      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics: [],
        }),
      );

      expect(html).toContain(phase4ScheduleCopy.noFeasibleScheduleGeneric);
      expect(html).not.toContain(phase4ScheduleCopy.officialConflictsDetected);
    });

    it("renders generic notice when error is true", () => {
      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics: [
            {
              code: "official_unavailable",
              severity: "required",
              matchIds: [match1Id],
            },
          ],
          error: true,
        }),
      );

      expect(html).toContain(phase4ScheduleCopy.noFeasibleScheduleGeneric);
      expect(html).not.toContain(phase4ScheduleCopy.officialConflictsDetected);
    });

    it("renders loading notice when loading is true and diagnostics is null", () => {
      const html = renderToString(
        React.createElement(NoSolutionOfficialDiagnostics, {
          competitionId,
          matches: mockMatches,
          diagnostics: null,
          loading: true,
        }),
      );

      expect(html).toContain(phase4ScheduleCopy.loading);
    });
  });
});
