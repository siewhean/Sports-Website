import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchOfficialAssignments } from "@/components/phase4/officials/MatchOfficialAssignments";
import { OfficialsRosterView } from "@/components/phase4/officials/OfficialsRosterView";
import {
  createDemoOfficialWorkspace,
  isMatchOfficialsMutationResponse,
  phase4OfficialsCopy,
  type OfficialWorkspaceDocument,
} from "@/lib/phase4-officials";
import { validateMatchAssignmentsBody } from "@/lib/phase4-officials-bff.server";
import type { ScheduleDocument, ScheduleMatch } from "@/lib/phase4-schedule";

const competitionId = "10000000-0000-4000-8000-000000000001";
const match1Id = "30000000-0000-4000-8000-000000000001";
const match2Id = "30000000-0000-4000-8000-000000000002";

function createTestScheduleDocument(matches: ScheduleMatch[] = []): ScheduleDocument {
  return {
    state: "ready",
    competitionId,
    competitionName: "Singapore Open",
    timeZone: "Asia/Singapore",
    publicationRevision: "pub-1",
    sourceRevision: 1,
    capacityRevision: 1,
    constraints: {},
    canEdit: true,
    canPublish: true,
    activeJob: null,
    latestNoSolutionJob: null,
    currentRevision: {
      id: "rev-1",
      revision: 1,
      parentRevisionId: null,
      status: "ready_for_review",
      editableUntil: null,
      publishedAt: null,
      expiredAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      quality: null,
      assignments: [
        {
          matchId: match1Id,
          divisionId: "div-1",
          areaId: "pitch-1",
          intervalId: "int-1",
          slotId: "slot-1",
          startsAt: "2026-08-15T01:00:00.000Z", // 09:00 SGT
          endsAt: "2026-08-15T01:30:00.000Z", // 09:30 SGT
          fixed: false,
        },
      ],
      violations: [],
    },
    revisions: [],
    alternatives: [],
    areas: [{ id: "pitch-1", name: "Pitch 1", kind: "Standard" }],
    slots: [],
    matches,
    locks: [],
    warnings: [],
  };
}

describe("SCH-006 Checkpoint 5.4 — Match Official Assignment UX & Conflict Hints", () => {
  const sampleMatches: ScheduleMatch[] = [
    {
      id: match1Id,
      divisionId: "div-1",
      divisionName: "Open Division",
      roundLabel: "Semi-final",
      code: "M12",
      homeLabel: "Team Alpha",
      awayLabel: "Team Beta",
      durationMinutes: 30,
      dependencyMatchIds: [],
      status: "scheduled",
    },
    {
      id: match2Id,
      divisionId: "div-1",
      divisionName: "Open Division",
      roundLabel: "Final",
      code: "M14",
      homeLabel: "Team Gamma",
      awayLabel: "Team Delta",
      durationMinutes: 30,
      dependencyMatchIds: [],
      status: "unscheduled",
    },
  ];

  describe("Deep Link & Match Selection (CP 5.4.0)", () => {
    it("selects valid initialMatchId passed via deep link", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const scheduleDoc = createTestScheduleDocument(sampleMatches);

      const html = renderToString(
        React.createElement(OfficialsRosterView, {
          document: doc,
          scheduleDocument: scheduleDoc,
          initialMatchId: match2Id,
        }),
      );

      // Match 2 (M14) should be selected in the select option
      expect(html).toContain(`value="${match2Id}" selected`);
      expect(html).toContain("M14 — Final · Team Gamma vs Team Delta · Open Division");
    });

    it("safely falls back to first match when initialMatchId is invalid (e.g. random UUID)", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const scheduleDoc = createTestScheduleDocument(sampleMatches);

      const html = renderToString(
        React.createElement(OfficialsRosterView, {
          document: doc,
          scheduleDocument: scheduleDoc,
          initialMatchId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        }),
      );

      // Falls back to match 1
      expect(html).toContain(`value="${match1Id}" selected`);
      expect(html).not.toContain("Match not found: ffffffff");
    });

    it("safely handles empty matches list", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const scheduleDoc = createTestScheduleDocument([]);

      const html = renderToString(
        React.createElement(OfficialsRosterView, {
          document: doc,
          scheduleDocument: scheduleDoc,
          initialMatchId: match1Id,
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.noMatchesAvailable);
    });
  });

  describe("Match Presentation & Time Summary (CP 5.4.1)", () => {
    it("displays scheduled date, time, and pitch name for scheduled match", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const scheduleDoc = createTestScheduleDocument(sampleMatches);

      const html = renderToString(
        React.createElement(OfficialsRosterView, {
          document: doc,
          scheduleDocument: scheduleDoc,
          initialMatchId: match1Id,
          timeZone: "Asia/Singapore",
        }),
      );

      // Match 1 is scheduled at 2026-08-15 01:00 UTC (09:00 SGT) on Pitch 1
      expect(html).toContain("15 Aug 2026, 09:00–09:30, Pitch 1");
    });

    it("displays Currently unscheduled for match with no schedule assignment", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const scheduleDoc = createTestScheduleDocument(sampleMatches);

      const html = renderToString(
        React.createElement(OfficialsRosterView, {
          document: doc,
          scheduleDocument: scheduleDoc,
          initialMatchId: match2Id, // match2 is unscheduled in revision
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.currentlyUnscheduled);
      expect(html).toContain(phase4OfficialsCopy.scheduleMatchForConflictsNotice);
    });

    it("shows current assigned officials count and names in view mode", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      // Demo workspace has Official A assigned to match1Id
      const scheduleDoc = createTestScheduleDocument(sampleMatches);

      const html = renderToString(
        React.createElement(OfficialsRosterView, {
          document: doc,
          scheduleDocument: scheduleDoc,
          initialMatchId: match1Id,
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.assignedOfficialsCount(1));
      expect(html).toContain("Official A");
      expect(html).toContain("Lead Official");
    });
  });

  describe("Editor Candidate Set & Archived Rules (CP 5.4.2)", () => {
    it("includes active officials in candidate checklist in edit mode", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const scheduleDoc = createTestScheduleDocument(sampleMatches);

      const html = renderToString(
        React.createElement(MatchOfficialAssignments, {
          selectedMatchId: match1Id,
          onSelectMatch: () => {},
          scheduleDocument: scheduleDoc,
          workspace: doc,
          isEditing: true,
          onOpenEdit: () => {},
          onCancelEdit: () => {},
          onSaveAssignments: async () => {},
          busy: null,
          workspaceOutOfSync: false,
        }),
      );

      // Active officials Official A and Official B should be present
      expect(html).toContain("Official A");
      expect(html).toContain("Official B");
      // Unassigned archived Official C must NOT be in candidate list
      expect(html).not.toContain("Archived Official C");
    });

    it("includes archived official in candidate list IF currently assigned to selected match", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      // Assign archived official C to match1
      const archivedOfficialId = "60000000-0000-4000-8000-000000000003";
      const docWithArchivedAssignment: OfficialWorkspaceDocument = {
        ...doc,
        assignments: [
          ...doc.assignments,
          {
            matchId: match1Id,
            officialId: archivedOfficialId,
            assignedRole: "Timekeeper",
          },
        ],
      };
      const scheduleDoc = createTestScheduleDocument(sampleMatches);

      const html = renderToString(
        React.createElement(MatchOfficialAssignments, {
          selectedMatchId: match1Id,
          onSelectMatch: () => {},
          scheduleDocument: scheduleDoc,
          workspace: docWithArchivedAssignment,
          isEditing: true,
          onOpenEdit: () => {},
          onCancelEdit: () => {},
          onSaveAssignments: async () => {},
          busy: null,
          workspaceOutOfSync: false,
        }),
      );

      // Assigned archived official MUST be visible with Archived badge
      expect(html).toContain("Archived Official C");
      expect(html).toContain(phase4OfficialsCopy.archivedBadge);
      // Checkbox is checked (selected)
      expect(html).toMatch(new RegExp(`id="match-official-${archivedOfficialId}"[^>]*checked=""`));
    });
  });

  describe("Permission and Sync Invariants", () => {
    it("suppresses Edit match officials button when canEdit is false", () => {
      const doc = createDemoOfficialWorkspace(competitionId, false);
      const scheduleDoc = createTestScheduleDocument(sampleMatches);

      const html = renderToString(
        React.createElement(MatchOfficialAssignments, {
          selectedMatchId: match1Id,
          onSelectMatch: () => {},
          scheduleDocument: scheduleDoc,
          workspace: doc,
          isEditing: false,
          onOpenEdit: () => {},
          onCancelEdit: () => {},
          onSaveAssignments: async () => {},
          busy: null,
          workspaceOutOfSync: false,
        }),
      );

      expect(html).not.toContain(phase4OfficialsCopy.editMatchOfficials);
    });

    it("suppresses Edit match officials button when workspaceOutOfSync is true", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const scheduleDoc = createTestScheduleDocument(sampleMatches);

      const html = renderToString(
        React.createElement(MatchOfficialAssignments, {
          selectedMatchId: match1Id,
          onSelectMatch: () => {},
          scheduleDocument: scheduleDoc,
          workspace: doc,
          isEditing: false,
          onOpenEdit: () => {},
          onCancelEdit: () => {},
          onSaveAssignments: async () => {},
          busy: null,
          workspaceOutOfSync: true,
        }),
      );

      expect(html).not.toContain(phase4OfficialsCopy.editMatchOfficials);
    });
  });

  describe("Mutation Response & BFF Validation Semantics", () => {
    it("isMatchOfficialsMutationResponse validates valid response", () => {
      expect(
        isMatchOfficialsMutationResponse({
          assignments: [
            {
              match_id: match1Id,
              official_id: "60000000-0000-4000-8000-000000000001",
              assigned_role: "Lead Judge",
            },
          ],
          bumped_revision: true,
        }),
      ).toBe(true);

      // Empty assignments array is valid
      expect(
        isMatchOfficialsMutationResponse({
          assignments: [],
          bumped_revision: false,
        }),
      ).toBe(true);
    });

    it("isMatchOfficialsMutationResponse rejects invalid payloads", () => {
      // Extra unexpected keys
      expect(
        isMatchOfficialsMutationResponse({
          assignments: [],
          bumped_revision: false,
          extra: 123,
        }),
      ).toBe(false);

      // Non-boolean bumped_revision
      expect(
        isMatchOfficialsMutationResponse({
          assignments: [],
          bumped_revision: "true",
        }),
      ).toBe(false);

      // Overlong role (>40)
      expect(
        isMatchOfficialsMutationResponse({
          assignments: [
            {
              match_id: match1Id,
              official_id: "60000000-0000-4000-8000-000000000001",
              assigned_role: "A".repeat(41),
            },
          ],
          bumped_revision: true,
        }),
      ).toBe(false);
    });

    it("validateMatchAssignmentsBody enforces max 64 and duplicate check", () => {
      // Empty set is valid
      const emptyRes = validateMatchAssignmentsBody({ assignments: [] });
      expect(emptyRes.ok).toBe(true);

      // Duplicate check
      const dupRes = validateMatchAssignmentsBody({
        assignments: [
          { official_id: "60000000-0000-4000-8000-000000000001", assigned_role: null },
          { official_id: "60000000-0000-4000-8000-000000000001", assigned_role: "Second" },
        ],
      });
      expect(dupRes.ok).toBe(false);
      if (!dupRes.ok) {
        expect(dupRes.message).toContain("Duplicate official assignment");
      }

      // 65 assignments rejected
      const overlimit = Array.from({ length: 65 }, (_, i) => ({
        official_id: `60000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        assigned_role: null,
      }));
      const limitRes = validateMatchAssignmentsBody({ assignments: overlimit });
      expect(limitRes.ok).toBe(false);
      if (!limitRes.ok) {
        expect(limitRes.message).toContain("Maximum 64");
      }
    });
  });
});
