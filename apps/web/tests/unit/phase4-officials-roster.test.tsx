import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OfficialDetails } from "@/components/phase4/officials/OfficialDetails";
import { OfficialForm } from "@/components/phase4/officials/OfficialForm";
import { OfficialRoster } from "@/components/phase4/officials/OfficialRoster";
import { OfficialsRosterView } from "@/components/phase4/officials/OfficialsRosterView";
import {
  createDemoOfficialWorkspace,
  officialCommandErrorMessage,
  phase4OfficialsCopy,
  type OfficialView,
  type OfficialWorkspaceDocument,
} from "@/lib/phase4-officials";

const competitionId = "10000000-0000-4000-8000-000000000001";

describe("SCH-006 Checkpoint 5.2 — Editable Officials Roster", () => {
  describe("Read-only and Editability Permissions", () => {
    it("renders read-only notice and suppresses edit actions when canEdit is false", () => {
      const doc = createDemoOfficialWorkspace(competitionId, false);
      const html = renderToString(React.createElement(OfficialsRosterView, { document: doc }));

      expect(html).toContain(phase4OfficialsCopy.readOnlyNotice);
      expect(html).not.toContain(phase4OfficialsCopy.addOfficial);
      expect(html).not.toContain(phase4OfficialsCopy.editOfficial);
      expect(html).not.toContain(phase4OfficialsCopy.archiveOfficial);
      expect(html).not.toContain(phase4OfficialsCopy.restoreOfficial);
    });

    it("renders add official and edit actions when canEdit is true", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const html = renderToString(React.createElement(OfficialsRosterView, { document: doc }));

      expect(html).not.toContain(phase4OfficialsCopy.readOnlyNotice);
      expect(html).toContain(phase4OfficialsCopy.addOfficial);
      expect(html).toContain(phase4OfficialsCopy.editOfficial);
      expect(html).toContain(phase4OfficialsCopy.archiveOfficial);
    });
  });

  describe("Initial Selection Semantics", () => {
    it("selects first active official by default and displays details", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const firstActive = doc.officials.find((o) => !o.archived)!;
      const html = renderToString(React.createElement(OfficialsRosterView, { document: doc }));

      expect(html).toContain(firstActive.name);
      expect(html).toContain(firstActive.defaultRole ?? "");
      expect(html).toContain(phase4OfficialsCopy.selectedOfficialBadge);
    });

    it("renders prompt when there are no active officials", () => {
      const emptyDoc: OfficialWorkspaceDocument = {
        state: "ready",
        competitionId,
        canEdit: true,
        officials: [],
        availability: {},
        assignments: [],
      };
      const html = renderToString(React.createElement(OfficialsRosterView, { document: emptyDoc }));

      expect(html).toContain(phase4OfficialsCopy.noOfficials);
      expect(html).toContain(phase4OfficialsCopy.selectOfficialPrompt);
    });

    it("hides archived officials by default and displays toggle count", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const archived = doc.officials.filter((o) => o.archived);
      const html = renderToString(React.createElement(OfficialsRosterView, { document: doc }));

      expect(html).toContain(`${phase4OfficialsCopy.showArchived} (${archived.length})`);
      expect(html).not.toContain(phase4OfficialsCopy.archivedOfficials);
      for (const o of archived) {
        expect(html).not.toContain(o.name);
      }
    });
  });

  describe("OfficialRoster subcomponent", () => {
    it("renders active officials with windows count and assignment count", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const html = renderToString(
        React.createElement(OfficialRoster, {
          officials: doc.officials,
          availability: doc.availability,
          assignments: doc.assignments,
          selectedOfficialId: doc.officials[0]!.id,
          onSelectOfficial: () => {},
          showArchived: false,
          onToggleShowArchived: () => {},
          canEdit: true,
          onOpenCreate: () => {},
          busy: null,
        }),
      );

      const first = doc.officials[0]!;
      const expectedAssignments = doc.assignments.filter((a) => a.officialId === first.id).length;
      const expectedWindows = (doc.availability[first.id] ?? []).length;
      expect(html).toContain(first.name);
      expect(html).toContain(phase4OfficialsCopy.assignmentsCount(expectedAssignments));
      expect(html).toContain(phase4OfficialsCopy.windowsCount(expectedWindows));
    });

    it("renders archived section when showArchived is true", () => {
      const doc = createDemoOfficialWorkspace(competitionId, true);
      const archived = doc.officials.find((o) => o.archived)!;
      const html = renderToString(
        React.createElement(OfficialRoster, {
          officials: doc.officials,
          availability: doc.availability,
          assignments: doc.assignments,
          selectedOfficialId: doc.officials[0]!.id,
          onSelectOfficial: () => {},
          showArchived: true,
          onToggleShowArchived: () => {},
          canEdit: true,
          onOpenCreate: () => {},
          busy: null,
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.archivedOfficials);
      expect(html).toContain(archived.name);
      expect(html).toContain(phase4OfficialsCopy.archivedBadge);
    });
  });

  describe("OfficialDetails subcomponent", () => {
    const sampleOfficial: OfficialView = {
      id: "60000000-0000-4000-8000-000000000001",
      competitionId,
      name: "Morgan Bailey",
      defaultRole: "Lead Referee",
      archived: false,
      createdAt: "2026-09-29T10:00:00Z",
      updatedAt: "2026-09-29T10:00:00Z",
    };

    it("renders details with role, windows, and assignments", () => {
      const html = renderToString(
        React.createElement(OfficialDetails, {
          official: sampleOfficial,
          assignmentCount: 2,
          windowCount: 3,
          canEdit: true,
          busy: null,
          isArchiveConfirm: false,
          onOpenEdit: () => {},
          onRequestArchive: () => {},
          onConfirmArchive: () => {},
          onCancelArchive: () => {},
          onRestore: () => {},
        }),
      );

      expect(html).toContain("Morgan Bailey");
      expect(html).toContain("Lead Referee");
      expect(html).toContain("3 windows");
      expect(html).toContain("2 assignments");
      expect(html).toContain(phase4OfficialsCopy.editOfficial);
      expect(html).toContain(phase4OfficialsCopy.archiveOfficial);
    });

    it("renders restore button for archived officials", () => {
      const archivedOfficial: OfficialView = {
        ...sampleOfficial,
        archived: true,
      };

      const html = renderToString(
        React.createElement(OfficialDetails, {
          official: archivedOfficial,
          assignmentCount: 0,
          windowCount: 0,
          canEdit: true,
          busy: null,
          isArchiveConfirm: false,
          onOpenEdit: () => {},
          onRequestArchive: () => {},
          onConfirmArchive: () => {},
          onCancelArchive: () => {},
          onRestore: () => {},
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.restoreOfficial);
      expect(html).not.toContain(phase4OfficialsCopy.archiveOfficial);
    });

    it("renders two-step confirmation with assignment warning when isArchiveConfirm is true", () => {
      const html = renderToString(
        React.createElement(OfficialDetails, {
          official: sampleOfficial,
          assignmentCount: 3,
          windowCount: 1,
          canEdit: true,
          busy: null,
          isArchiveConfirm: true,
          onOpenEdit: () => {},
          onRequestArchive: () => {},
          onConfirmArchive: () => {},
          onCancelArchive: () => {},
          onRestore: () => {},
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.archiveConfirmTitle(sampleOfficial.name));
      expect(html).toContain(phase4OfficialsCopy.archiveNoticeGeneral);
      expect(html).toContain(phase4OfficialsCopy.archiveNoticeAssignments(3));
      expect(html).toContain(phase4OfficialsCopy.confirmArchive);
      expect(html).toContain(phase4OfficialsCopy.cancel);
    });
  });

  describe("OfficialForm subcomponent", () => {
    it("renders create form with empty fields, labels, and placeholders", () => {
      const html = renderToString(
        React.createElement(OfficialForm, {
          mode: "create",
          onSubmit: () => {},
          onCancel: () => {},
          busy: false,
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.createTitle);
      expect(html).toContain(phase4OfficialsCopy.nameLabel);
      expect(html).toContain(phase4OfficialsCopy.roleLabel);
      expect(html).toContain(phase4OfficialsCopy.namePlaceholder);
      expect(html).toContain(phase4OfficialsCopy.rolePlaceholder);
      expect(html).toContain(phase4OfficialsCopy.addOfficial);
      expect(html).toContain(phase4OfficialsCopy.cancel);
    });

    it("renders edit form prefilled with existing values", () => {
      const sampleOfficial: OfficialView = {
        id: "60000000-0000-4000-8000-000000000001",
        competitionId,
        name: "Devon Reed",
        defaultRole: "Line Judge",
        archived: false,
        createdAt: "2026-09-29T10:00:00Z",
        updatedAt: "2026-09-29T10:00:00Z",
      };

      const html = renderToString(
        React.createElement(OfficialForm, {
          mode: "edit",
          initialOfficial: sampleOfficial,
          onSubmit: () => {},
          onCancel: () => {},
          busy: false,
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.editTitle);
      expect(html).toContain('value="Devon Reed"');
      expect(html).toContain('value="Line Judge"');
      expect(html).toContain(phase4OfficialsCopy.save);
    });

    it("renders server error alert when error is provided", () => {
      const html = renderToString(
        React.createElement(OfficialForm, {
          mode: "create",
          onSubmit: () => {},
          onCancel: () => {},
          busy: false,
          serverError: phase4OfficialsCopy.duplicateNameError,
        }),
      );

      expect(html).toContain('role="alert"');
      expect(html).toContain(phase4OfficialsCopy.duplicateNameError);
    });
  });

  describe("Error Mapping Helper", () => {
    it("maps OFFICIAL_NAME_CONFLICT to duplicate name error", () => {
      expect(officialCommandErrorMessage(409, "OFFICIAL_NAME_CONFLICT")).toBe(phase4OfficialsCopy.duplicateNameError);
      expect(officialCommandErrorMessage(409)).toBe(phase4OfficialsCopy.duplicateNameError);
    });

    it("maps OFFICIAL_NOT_FOUND to not found error", () => {
      expect(officialCommandErrorMessage(404, "OFFICIAL_NOT_FOUND")).toBe(phase4OfficialsCopy.officialNotFound);
      expect(officialCommandErrorMessage(404)).toBe(phase4OfficialsCopy.officialNotFound);
    });

    it("maps VALIDATION_ERROR to validation failed error", () => {
      expect(officialCommandErrorMessage(400, "VALIDATION_ERROR")).toBe(phase4OfficialsCopy.validationFailed);
    });

    it("maps REVISION_CONFLICT to revision conflict error", () => {
      expect(officialCommandErrorMessage(409, "REVISION_CONFLICT")).toBe(phase4OfficialsCopy.revisionConflict);
    });

    it("maps AUTH_REQUIRED and 401 to session expired error", () => {
      expect(officialCommandErrorMessage(401, "AUTH_REQUIRED")).toBe(phase4OfficialsCopy.sessionExpired);
      expect(officialCommandErrorMessage(401)).toBe(phase4OfficialsCopy.sessionExpired);
    });

    it("maps 403 to access denied error", () => {
      expect(officialCommandErrorMessage(403)).toBe(phase4OfficialsCopy.accessDenied);
    });
  });
});
