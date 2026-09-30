import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchOfficialsSummary } from "@/components/phase4/schedule/MatchOfficialsSummary";
import {
  phase4OfficialsCopy,
  toScheduleOfficialsProjection,
  type OfficialWorkspaceDocument,
  type ScheduleOfficialsProjection,
} from "@/lib/phase4-officials";

const competitionId = "10000000-0000-4000-8000-000000000001";
const match1Id = "30000000-0000-4000-8000-000000000001";
const match2Id = "30000000-0000-4000-8000-000000000002";
const officialAId = "60000000-0000-4000-8000-000000000001";
const officialBId = "60000000-0000-4000-8000-000000000002";
const officialCId = "60000000-0000-4000-8000-000000000003";

function createMockWorkspace(canEdit = true): OfficialWorkspaceDocument {
  return {
    state: "ready",
    competitionId,
    canEdit,
    officials: [
      {
        id: officialAId,
        competitionId,
        name: "Aisha Tan",
        defaultRole: "Lead Official",
        archived: false,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: officialBId,
        competitionId,
        name: "Marcus Koh",
        defaultRole: "Line Judge",
        archived: false,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: officialCId,
        competitionId,
        name: "Daniel Lim",
        defaultRole: null,
        archived: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
    availability: {
      [officialAId]: [{ startsAt: "2026-10-01T09:00:00.000Z", endsAt: "2026-10-01T17:00:00.000Z" }],
      [officialBId]: [],
      [officialCId]: [],
    },
    assignments: [
      {
        matchId: match1Id,
        officialId: officialAId,
        assignedRole: "Head Referee",
      },
      {
        matchId: match1Id,
        officialId: officialBId,
        assignedRole: null,
      },
      {
        matchId: match2Id,
        officialId: officialCId,
        assignedRole: null,
      },
    ],
  };
}

describe("Schedule Officials Integration (CP 5.5)", () => {
  describe("toScheduleOfficialsProjection", () => {
    it("creates a narrow projection excluding availability and timestamps", () => {
      const workspace = createMockWorkspace(true);
      const projection = toScheduleOfficialsProjection(workspace);

      expect(projection.state).toBe("ready");
      expect(projection.canEdit).toBe(true);

      // Verify availability is NOT in projection
      expect((projection as unknown as Record<string, unknown>).availability).toBeUndefined();

      // Verify officials have only id, name, defaultRole, archived
      expect(projection.officials).toHaveLength(3);
      expect(projection.officials[0]).toEqual({
        id: officialAId,
        name: "Aisha Tan",
        defaultRole: "Lead Official",
        archived: false,
      });
      expect((projection.officials[0] as unknown as Record<string, unknown>).createdAt).toBeUndefined();
      expect((projection.officials[0] as unknown as Record<string, unknown>).updatedAt).toBeUndefined();

      // Verify archived official is retained
      const archived = projection.officials.find((o) => o.id === officialCId);
      expect(archived).toBeDefined();
      expect(archived?.archived).toBe(true);

      // Verify assignments membership retained
      expect(projection.assignments).toHaveLength(3);
      expect(projection.assignments[0]).toEqual({
        matchId: match1Id,
        officialId: officialAId,
        assignedRole: "Head Referee",
      });
    });

    it("preserves read-only canEdit state", () => {
      const workspace = createMockWorkspace(false);
      const projection = toScheduleOfficialsProjection(workspace);
      expect(projection.canEdit).toBe(false);
    });

    it("preserves non-ready surface state", () => {
      const workspace: OfficialWorkspaceDocument = {
        ...createMockWorkspace(),
        state: "error",
      };
      const projection = toScheduleOfficialsProjection(workspace);
      expect(projection.state).toBe("error");
    });
  });

  describe("MatchOfficialsSummary Component", () => {
    it("renders single assigned official with assigned role", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [{ id: officialAId, name: "Aisha Tan", defaultRole: "Lead Official", archived: false }],
        assignments: [{ matchId: match1Id, officialId: officialAId, assignedRole: "Lead Official" }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain("Officials");
      expect(html).toContain("Aisha Tan");
      expect(html).toContain("Lead Official");
      expect(html).toContain(phase4OfficialsCopy.manageOfficials);
      expect(html).toContain(`/organiser/competitions/${competitionId}/officials?match=${match1Id}`);
    });

    it("renders multiple assigned officials distinguishing assigned role vs default role", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [
          { id: officialAId, name: "Aisha Tan", defaultRole: "Lead Official", archived: false },
          { id: officialBId, name: "Marcus Koh", defaultRole: "Line Judge", archived: false },
        ],
        assignments: [
          { matchId: match1Id, officialId: officialAId, assignedRole: "Table Official" },
          { matchId: match1Id, officialId: officialBId, assignedRole: null },
        ],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      // Aisha Tan has explicit assigned role
      expect(html).toContain("Aisha Tan");
      expect(html).toContain("Table Official");

      // Marcus Koh has null assigned role -> shows Default role: Line Judge
      expect(html).toContain("Marcus Koh");
      expect(html).toContain(phase4OfficialsCopy.defaultRoleHelper("Line Judge"));
    });

    it("renders 'No assigned role' when both assignedRole and defaultRole are null", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [{ id: officialAId, name: "Aisha Tan", defaultRole: null, archived: false }],
        assignments: [{ matchId: match1Id, officialId: officialAId, assignedRole: null }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain("Aisha Tan");
      expect(html).toContain(phase4OfficialsCopy.noAssignedRole);
    });

    it("renders 'Archived' badge for archived official and retains assignment", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [{ id: officialCId, name: "Daniel Lim", defaultRole: "Timekeeper", archived: true }],
        assignments: [{ matchId: match1Id, officialId: officialCId, assignedRole: "Timekeeper" }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain("Daniel Lim");
      expect(html).toContain(phase4OfficialsCopy.archivedBadge);
      expect(html).toContain("Timekeeper");
    });

    it("renders 'No officials assigned' when match has zero assignments", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [{ id: officialAId, name: "Aisha Tan", defaultRole: "Lead Official", archived: false }],
        assignments: [{ matchId: "other-match", officialId: officialAId, assignedRole: null }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain(phase4OfficialsCopy.noOfficialsAssigned);
      expect(html).toContain(phase4OfficialsCopy.manageOfficials);
      expect(html).not.toContain("Aisha Tan");
    });

    it("renders 'Unknown official' when assignment official cannot be resolved, without leaking raw UUID", () => {
      const unresolvableId = "99999999-9999-4000-8000-999999999999";
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: true,
        officials: [], // empty officials roster
        assignments: [{ matchId: match1Id, officialId: unresolvableId, assignedRole: "Lead Official" }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain(phase4OfficialsCopy.unknownOfficial);
      expect(html).not.toContain(unresolvableId);
      expect(html).toContain("Lead Official");
    });

    it("renders 'Official assignments are temporarily unavailable' on workspace read error", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "error",
        canEdit: true,
        officials: [],
        assignments: [],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain(phase4OfficialsCopy.officialsUnavailable);
      expect(html).not.toContain(phase4OfficialsCopy.noOfficialsAssigned);
    });

    it("renders 'View officials' when canEdit is false", () => {
      const projection: ScheduleOfficialsProjection = {
        state: "ready",
        canEdit: false,
        officials: [{ id: officialAId, name: "Aisha Tan", defaultRole: "Lead Official", archived: false }],
        assignments: [{ matchId: match1Id, officialId: officialAId, assignedRole: "Lead Official" }],
      };

      const html = renderToString(
        <MatchOfficialsSummary competitionId={competitionId} matchId={match1Id} officialsProjection={projection} />,
      );

      expect(html).toContain(phase4OfficialsCopy.viewOfficials);
      expect(html).not.toContain(phase4OfficialsCopy.manageOfficials);
    });
  });
});
