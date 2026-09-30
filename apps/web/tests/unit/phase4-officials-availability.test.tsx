import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OfficialAvailabilityEditor } from "@/components/phase4/officials/OfficialAvailabilityEditor";
import { OfficialDetails } from "@/components/phase4/officials/OfficialDetails";
import {
  formatWindowDisplay,
  officialCommandErrorMessage,
  phase4OfficialsCopy,
  type AvailabilityWindowView,
  type OfficialView,
} from "@/lib/phase4-officials";

const competitionId = "10000000-0000-4000-8000-000000000001";
const officialId = "60000000-0000-4000-8000-000000000001";

const sampleActiveOfficial: OfficialView = {
  id: officialId,
  competitionId,
  name: "Morgan Bailey",
  defaultRole: "Lead Referee",
  archived: false,
  createdAt: "2026-09-29T10:00:00Z",
  updatedAt: "2026-09-29T10:00:00Z",
};

const sampleArchivedOfficial: OfficialView = {
  id: "60000000-0000-4000-8000-000000000002",
  competitionId,
  name: "Taylor Quinn",
  defaultRole: "Line Judge",
  archived: true,
  createdAt: "2026-09-29T10:00:00Z",
  updatedAt: "2026-09-29T10:00:00Z",
};

describe("SCH-006 Checkpoint 5.3 — Competition-Timezone Official Availability", () => {
  describe("Civil-Time Window Display & Formatting", () => {
    it("formats single-day window in competition timezone", () => {
      // 2026-10-01 09:00 to 13:00 SGT (UTC+8) -> 01:00 to 05:00 UTC
      const startsAt = "2026-10-01T01:00:00.000Z";
      const endsAt = "2026-10-01T05:00:00.000Z";
      const formatted = formatWindowDisplay(startsAt, endsAt, "Asia/Singapore");

      expect(formatted.crossMidnight).toBe(false);
      expect(formatted.time).toBe("09:00–13:00");
      expect(formatted.text).toContain("09:00–13:00");
      expect(formatted.text).toContain("1 Oct 2026");
    });

    it("formats cross-midnight window in competition timezone", () => {
      // 2026-10-01 23:30 to 2026-10-02 01:00 SGT (UTC+8) -> 15:30 to 17:00 UTC
      const startsAt = "2026-10-01T15:30:00.000Z";
      const endsAt = "2026-10-01T17:00:00.000Z";
      const formatted = formatWindowDisplay(startsAt, endsAt, "Asia/Singapore");

      expect(formatted.crossMidnight).toBe(true);
      expect(formatted.text).toContain("1 Oct 2026 23:30");
      expect(formatted.text).toContain("2 Oct 2026 01:00");
    });

    it("preserves formatted display independent of host process.env.TZ", () => {
      const originalTz = process.env.TZ;
      try {
        process.env.TZ = "America/New_York";
        const startsAt = "2026-10-01T01:00:00.000Z";
        const endsAt = "2026-10-01T05:00:00.000Z";
        const sgFormatted = formatWindowDisplay(startsAt, endsAt, "Asia/Singapore");
        expect(sgFormatted.time).toBe("09:00–13:00");
        expect(sgFormatted.text).toContain("1 Oct 2026");

        process.env.TZ = "Pacific/Honolulu";
        const honoluluFormatted = formatWindowDisplay(startsAt, endsAt, "Asia/Singapore");
        expect(honoluluFormatted.time).toBe("09:00–13:00");
        expect(honoluluFormatted.text).toContain("1 Oct 2026");
      } finally {
        process.env.TZ = originalTz;
      }
    });
  });

  describe("OfficialDetails Availability UX", () => {
    it("renders competition timezone notice and empty state when no windows set", () => {
      const html = renderToString(
        React.createElement(OfficialDetails, {
          official: sampleActiveOfficial,
          assignmentCount: 0,
          windowCount: 0,
          windows: [],
          timeZone: "Asia/Singapore",
          canEdit: true,
          busy: null,
          isArchiveConfirm: false,
          onOpenEdit: () => {},
          onOpenAvailabilityEdit: () => {},
          onRequestArchive: () => {},
          onConfirmArchive: () => {},
          onCancelArchive: () => {},
          onRestore: () => {},
        }),
      );

      expect(html).toContain("Competition timezone: Asia/Singapore");
      expect(html).toContain(phase4OfficialsCopy.noAvailabilityWindows);
      expect(html).toContain(phase4OfficialsCopy.editAvailability);
    });

    it("renders formatted windows in list items", () => {
      const windows: AvailabilityWindowView[] = [
        {
          startsAt: "2026-10-01T01:00:00.000Z",
          endsAt: "2026-10-01T05:00:00.000Z",
        },
        {
          startsAt: "2026-10-01T15:30:00.000Z",
          endsAt: "2026-10-01T17:00:00.000Z",
        },
      ];

      const html = renderToString(
        React.createElement(OfficialDetails, {
          official: sampleActiveOfficial,
          assignmentCount: 0,
          windowCount: 2,
          windows,
          timeZone: "Asia/Singapore",
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

      expect(html).toContain("09:00–13:00");
      expect(html).toContain("1 Oct 2026 23:30 – 2 Oct 2026 01:00");
      expect(html).not.toContain(phase4OfficialsCopy.noAvailabilityWindows);
    });

    it("renders archived read-only view with restore prompt and suppresses edit button", () => {
      const windows: AvailabilityWindowView[] = [
        {
          startsAt: "2026-10-01T01:00:00.000Z",
          endsAt: "2026-10-01T05:00:00.000Z",
        },
      ];

      const html = renderToString(
        React.createElement(OfficialDetails, {
          official: sampleArchivedOfficial,
          assignmentCount: 0,
          windowCount: 1,
          windows,
          timeZone: "Asia/Singapore",
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

      // Windows still visible
      expect(html).toContain("09:00–13:00");
      // Read-only prompt displayed
      expect(html).toContain(phase4OfficialsCopy.restoreToEditAvailability);
      // Edit availability button suppressed
      expect(html).not.toContain(phase4OfficialsCopy.editAvailability);
    });

    it("disables edit availability button when workspaceOutOfSync is true", () => {
      const html = renderToString(
        React.createElement(OfficialDetails, {
          official: sampleActiveOfficial,
          assignmentCount: 0,
          windowCount: 0,
          windows: [],
          timeZone: "Asia/Singapore",
          canEdit: true,
          busy: null,
          workspaceOutOfSync: true,
          isArchiveConfirm: false,
          onOpenEdit: () => {},
          onOpenAvailabilityEdit: () => {},
          onRequestArchive: () => {},
          onConfirmArchive: () => {},
          onCancelArchive: () => {},
          onRestore: () => {},
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.editAvailability);
      // Button must have disabled attribute
      expect(html).toContain('disabled=""');
    });
  });

  describe("OfficialAvailabilityEditor Component", () => {
    it("renders editor pre-populated in competition timezone", () => {
      const initialWindows: AvailabilityWindowView[] = [
        {
          // 09:00 to 13:00 SGT
          startsAt: "2026-10-01T01:00:00.000Z",
          endsAt: "2026-10-01T05:00:00.000Z",
        },
      ];

      const html = renderToString(
        React.createElement(OfficialAvailabilityEditor, {
          official: sampleActiveOfficial,
          initialWindows,
          timeZone: "Asia/Singapore",
          onSubmit: () => {},
          onCancel: () => {},
          busy: false,
        }),
      );

      expect(html).toContain(phase4OfficialsCopy.availabilityEditorTitle);
      expect(html).toContain("Morgan Bailey");
      expect(html).toContain("Times are entered in Asia/Singapore.");
      expect(html).toContain('value="2026-10-01"');
      expect(html).toContain('value="09:00"');
      expect(html).toContain('value="13:00"');
      expect(html).toContain(phase4OfficialsCopy.addWindow);
      expect(html).toContain(phase4OfficialsCopy.removeWindow);
      expect(html).toContain(phase4OfficialsCopy.saveAvailability);
    });

    it("renders server error alert when serverError prop is provided", () => {
      const html = renderToString(
        React.createElement(OfficialAvailabilityEditor, {
          official: sampleActiveOfficial,
          initialWindows: [],
          timeZone: "Asia/Singapore",
          onSubmit: () => {},
          onCancel: () => {},
          busy: false,
          serverError: phase4OfficialsCopy.availabilityInvalid,
        }),
      );

      expect(html).toContain('id="availability-editor-error"');
      expect(html).toContain(phase4OfficialsCopy.availabilityInvalid);
    });
  });

  describe("Error Mapping for Availability & Archive", () => {
    it("maps OFFICIAL_AVAILABILITY_INVALID to availabilityInvalid error copy", () => {
      expect(officialCommandErrorMessage(400, "OFFICIAL_AVAILABILITY_INVALID")).toBe(
        phase4OfficialsCopy.availabilityInvalid,
      );
    });

    it("maps OFFICIAL_ARCHIVED to officialArchivedError copy", () => {
      expect(officialCommandErrorMessage(400, "OFFICIAL_ARCHIVED")).toBe(phase4OfficialsCopy.officialArchivedError);
    });
  });

  describe("DST and Copy Invariants", () => {
    it("formats DST gap message with time, timezone, and date", () => {
      const msg = phase4OfficialsCopy.dstGapError("02:30", "America/New_York", "2026-03-08");
      expect(msg).toContain("02:30 does not exist in America/New_York on 2026-03-08");
      expect(msg).toContain("daylight-saving time change");
    });

    it("has all required availability copy strings defined", () => {
      expect(phase4OfficialsCopy.scheduleInvalidatedNotice).toContain("This official was assigned to a match");
      expect(phase4OfficialsCopy.reviewScheduleLink).toBe("Review schedule");
      expect(phase4OfficialsCopy.availabilitySaved).toBe("Availability saved.");
      expect(phase4OfficialsCopy.availabilityInvalid).toBe("Availability windows are invalid. Check dates and times.");
      expect(phase4OfficialsCopy.endMustBeAfterStart).toBe("End time must be after start time.");
    });
  });
});
