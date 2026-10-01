import { describe, expect, it } from "vitest";
import {
  formatMatchOptionLabel,
  formatScheduledMatchSummary,
  getMatchScheduledInterval,
  officialAvailabilityConflict,
  officialOverlapConflicts,
  type MatchTimeInterval,
} from "@/lib/phase4-official-conflicts";
import { phase4OfficialsCopy } from "@/lib/phase4-officials";

describe("phase4-official-conflicts", () => {
  const officialA = { id: "60000000-0000-4000-8000-000000000001", name: "Aisha Tan" };
  const officialB = { id: "60000000-0000-4000-8000-000000000002", name: "Daniel Lim" };

  const match1Id = "30000000-0000-4000-8000-000000000001";
  const match2Id = "30000000-0000-4000-8000-000000000002";
  const match3Id = "30000000-0000-4000-8000-000000000003";

  const matches = [
    { id: match1Id, code: "M12" },
    { id: match2Id, code: "M14" },
    { id: match3Id, code: "M15" },
  ];

  describe("officialAvailabilityConflict (Requirement 42)", () => {
    // Scheduled match: 2026-10-01 09:00 to 09:30 UTC
    const matchInterval: MatchTimeInterval = {
      startEpochMs: Date.parse("2026-10-01T09:00:00.000Z"),
      endEpochMs: Date.parse("2026-10-01T09:30:00.000Z"),
    };

    it("returns null when match is fully inside availability window", () => {
      const windows = [
        {
          startsAt: "2026-10-01T08:00:00.000Z",
          endsAt: "2026-10-01T10:00:00.000Z",
        },
      ];
      const conflict = officialAvailabilityConflict(officialA, windows, matchInterval);
      expect(conflict).toBeNull();
    });

    it("returns warning when match starts before availability window", () => {
      const windows = [
        {
          startsAt: "2026-10-01T09:15:00.000Z", // starts 15 min after match start
          endsAt: "2026-10-01T10:00:00.000Z",
        },
      ];
      const conflict = officialAvailabilityConflict(officialA, windows, matchInterval);
      expect(conflict).toBe(phase4OfficialsCopy.conflictOfficialUnavailable(officialA.name));
      expect(conflict).toBe("Aisha Tan is not available for this match's current scheduled time.");
    });

    it("returns warning when match ends after availability window", () => {
      const windows = [
        {
          startsAt: "2026-10-01T08:30:00.000Z",
          endsAt: "2026-10-01T09:15:00.000Z", // ends 15 min before match end
        },
      ];
      const conflict = officialAvailabilityConflict(officialA, windows, matchInterval);
      expect(conflict).toBe(phase4OfficialsCopy.conflictOfficialUnavailable(officialA.name));
    });

    it("returns warning when official has zero availability windows", () => {
      const conflict = officialAvailabilityConflict(officialA, [], matchInterval);
      expect(conflict).toBe(phase4OfficialsCopy.conflictOfficialUnavailable(officialA.name));
    });

    it("returns null when one of multiple windows contains match", () => {
      const windows = [
        {
          startsAt: "2026-10-01T06:00:00.000Z",
          endsAt: "2026-10-01T08:00:00.000Z",
        },
        {
          startsAt: "2026-10-01T08:45:00.000Z",
          endsAt: "2026-10-01T10:15:00.000Z",
        },
      ];
      const conflict = officialAvailabilityConflict(officialA, windows, matchInterval);
      expect(conflict).toBeNull();
    });

    it("returns null when match is unscheduled (null interval)", () => {
      const windows = [
        {
          startsAt: "2026-10-01T06:00:00.000Z",
          endsAt: "2026-10-01T08:00:00.000Z",
        },
      ];
      const conflict = officialAvailabilityConflict(officialA, windows, null);
      expect(conflict).toBeNull();
    });
  });

  describe("officialOverlapConflicts (Requirement 43)", () => {
    // Selected match: 09:00 to 09:30 UTC
    const selectedInterval: MatchTimeInterval = {
      startEpochMs: Date.parse("2026-10-01T09:00:00.000Z"),
      endEpochMs: Date.parse("2026-10-01T09:30:00.000Z"),
    };

    it("returns warning when same official has an overlapping match", () => {
      const allAssignments = [
        { matchId: match1Id, officialId: officialA.id },
        { matchId: match2Id, officialId: officialA.id },
      ];
      const scheduleAssignments = [
        {
          matchId: match1Id,
          startsAt: "2026-10-01T09:00:00.000Z",
          endsAt: "2026-10-01T09:30:00.000Z",
        },
        {
          matchId: match2Id,
          startsAt: "2026-10-01T09:15:00.000Z", // Overlaps with 09:00–09:30
          endsAt: "2026-10-01T09:45:00.000Z",
        },
      ];

      const conflicts = officialOverlapConflicts(
        officialA,
        match1Id,
        selectedInterval,
        allAssignments,
        scheduleAssignments,
        matches,
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toBe(phase4OfficialsCopy.conflictOfficialOverlap(officialA.name, "M14"));
      expect(conflicts[0]).toBe("Aisha Tan is also assigned to M14 at this time.");
    });

    it("returns empty array for exact adjacency (09:00–09:30 and 09:30–10:00)", () => {
      const allAssignments = [
        { matchId: match1Id, officialId: officialA.id },
        { matchId: match2Id, officialId: officialA.id },
      ];
      const scheduleAssignments = [
        {
          matchId: match1Id,
          startsAt: "2026-10-01T09:00:00.000Z",
          endsAt: "2026-10-01T09:30:00.000Z",
        },
        {
          matchId: match2Id,
          startsAt: "2026-10-01T09:30:00.000Z", // Starts exactly when M1 ends
          endsAt: "2026-10-01T10:00:00.000Z",
        },
      ];

      const conflicts = officialOverlapConflicts(
        officialA,
        match1Id,
        selectedInterval,
        allAssignments,
        scheduleAssignments,
        matches,
      );

      expect(conflicts).toHaveLength(0);
    });

    it("returns empty array for exact predecessor adjacency (08:30–09:00 and 09:00–09:30)", () => {
      const allAssignments = [
        { matchId: match1Id, officialId: officialA.id },
        { matchId: match2Id, officialId: officialA.id },
      ];
      const scheduleAssignments = [
        {
          matchId: match1Id,
          startsAt: "2026-10-01T09:00:00.000Z",
          endsAt: "2026-10-01T09:30:00.000Z",
        },
        {
          matchId: match2Id,
          startsAt: "2026-10-01T08:30:00.000Z",
          endsAt: "2026-10-01T09:00:00.000Z", // Ends exactly when M1 starts
        },
      ];

      const conflicts = officialOverlapConflicts(
        officialA,
        match1Id,
        selectedInterval,
        allAssignments,
        scheduleAssignments,
        matches,
      );

      expect(conflicts).toHaveLength(0);
    });

    it("returns empty array when matches are non-overlapping with gap", () => {
      const allAssignments = [
        { matchId: match1Id, officialId: officialA.id },
        { matchId: match2Id, officialId: officialA.id },
      ];
      const scheduleAssignments = [
        {
          matchId: match1Id,
          startsAt: "2026-10-01T09:00:00.000Z",
          endsAt: "2026-10-01T09:30:00.000Z",
        },
        {
          matchId: match2Id,
          startsAt: "2026-10-01T11:00:00.000Z",
          endsAt: "2026-10-01T11:30:00.000Z",
        },
      ];

      const conflicts = officialOverlapConflicts(
        officialA,
        match1Id,
        selectedInterval,
        allAssignments,
        scheduleAssignments,
        matches,
      );

      expect(conflicts).toHaveLength(0);
    });

    it("returns empty array when different official is assigned to overlapping match", () => {
      const allAssignments = [
        { matchId: match1Id, officialId: officialA.id },
        { matchId: match2Id, officialId: officialB.id }, // Official B assigned to M14, not Aisha
      ];
      const scheduleAssignments = [
        {
          matchId: match1Id,
          startsAt: "2026-10-01T09:00:00.000Z",
          endsAt: "2026-10-01T09:30:00.000Z",
        },
        {
          matchId: match2Id,
          startsAt: "2026-10-01T09:15:00.000Z",
          endsAt: "2026-10-01T09:45:00.000Z",
        },
      ];

      const conflicts = officialOverlapConflicts(
        officialA,
        match1Id,
        selectedInterval,
        allAssignments,
        scheduleAssignments,
        matches,
      );

      expect(conflicts).toHaveLength(0);
    });

    it("returns empty array when other assigned match is unscheduled", () => {
      const allAssignments = [
        { matchId: match1Id, officialId: officialA.id },
        { matchId: match3Id, officialId: officialA.id }, // match 3 not in schedule assignments
      ];
      const scheduleAssignments = [
        {
          matchId: match1Id,
          startsAt: "2026-10-01T09:00:00.000Z",
          endsAt: "2026-10-01T09:30:00.000Z",
        },
      ];

      const conflicts = officialOverlapConflicts(
        officialA,
        match1Id,
        selectedInterval,
        allAssignments,
        scheduleAssignments,
        matches,
      );

      expect(conflicts).toHaveLength(0);
    });

    it("returns empty array when selected match is unscheduled", () => {
      const allAssignments = [
        { matchId: match1Id, officialId: officialA.id },
        { matchId: match2Id, officialId: officialA.id },
      ];
      const scheduleAssignments = [
        {
          matchId: match2Id,
          startsAt: "2026-10-01T09:15:00.000Z",
          endsAt: "2026-10-01T09:45:00.000Z",
        },
      ];

      const conflicts = officialOverlapConflicts(
        officialA,
        match1Id,
        null, // unscheduled selected match
        allAssignments,
        scheduleAssignments,
        matches,
      );

      expect(conflicts).toHaveLength(0);
    });
  });

  describe("Presentation Helpers", () => {
    it("formats match option label with code and metadata", () => {
      const label = formatMatchOptionLabel({
        code: "M12",
        roundLabel: "Semi-final",
        homeLabel: "Team A",
        awayLabel: "Team B",
        divisionName: "Open Division",
      });
      expect(label).toBe("M12 — Semi-final · Team A vs Team B · Open Division");
    });

    it("formats match option label with only code when metadata is absent", () => {
      const label = formatMatchOptionLabel({ code: "M1" });
      expect(label).toBe("M1");
    });

    it("formats scheduled match summary in competition timezone", () => {
      const areas = [{ id: "pitch-1", name: "Pitch 1" }];
      const assignment = {
        startsAt: "2026-10-01T01:00:00.000Z", // 09:00 SGT
        endsAt: "2026-10-01T01:30:00.000Z", // 09:30 SGT
        areaId: "pitch-1",
      };

      const summary = formatScheduledMatchSummary(assignment, areas, "Asia/Singapore");
      expect(summary.isScheduled).toBe(true);
      expect(summary.dateStr).toBe("1 Oct 2026");
      expect(summary.timeStr).toBe("09:00–09:30");
      expect(summary.areaName).toBe("Pitch 1");
      expect(summary.text).toBe("1 Oct 2026, 09:00–09:30, Pitch 1");
    });

    it("formats unscheduled match summary", () => {
      const summary = formatScheduledMatchSummary(null, [], "Asia/Singapore");
      expect(summary.isScheduled).toBe(false);
      expect(summary.text).toBe("Currently unscheduled");
    });

    it("getMatchScheduledInterval safely extracts interval", () => {
      const assignments = [
        {
          matchId: match1Id,
          startsAt: "2026-10-01T09:00:00.000Z",
          endsAt: "2026-10-01T09:30:00.000Z",
        },
      ];
      expect(getMatchScheduledInterval(match1Id, assignments)).toEqual({
        startEpochMs: Date.parse("2026-10-01T09:00:00.000Z"),
        endEpochMs: Date.parse("2026-10-01T09:30:00.000Z"),
      });
      expect(getMatchScheduledInterval("nonexistent", assignments)).toBeNull();
      expect(getMatchScheduledInterval(match1Id, null)).toBeNull();
    });
  });
});
