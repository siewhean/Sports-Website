import { describe, expect, it } from "vitest";
import {
  createDemoOfficialWorkspace,
  isAvailabilityMutationResponse,
  isMatchOfficialsMutationResponse,
  isOfficialMutationResponse,
  isOfficialResponse,
  isOfficialWorkspaceResponse,
  isRfc3339DateTime,
  isUuid,
  officialWorkspaceUnavailableDocument,
  parseOfficialWorkspaceResponse,
  phase4OfficialsCopy,
} from "./phase4-officials";

describe("phase4-officials read model", () => {
  const competitionId = "10000000-0000-4000-8000-000000000001";
  const official1Id = "60000000-0000-4000-8000-000000000001";
  const match1Id = "30000000-0000-4000-8000-000000000001";

  const validPayload = {
    officials: [
      {
        id: official1Id,
        competition_id: competitionId,
        name: "Official Alpha",
        default_role: "Lead Referee",
        archived: false,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    ],
    availability: {
      [official1Id]: [
        {
          starts_at: "2026-08-15T09:00:00.000Z",
          ends_at: "2026-08-15T12:00:00.000Z",
        },
      ],
    },
    assignments: [
      {
        match_id: match1Id,
        official_id: official1Id,
        assigned_role: "Lead Referee",
        official: {
          id: official1Id,
          name: "Official Alpha",
          default_role: "Lead Referee",
          archived: false,
        },
      },
    ],
  };

  it("parses valid upstream response into client workspace document", () => {
    const doc = parseOfficialWorkspaceResponse(validPayload, competitionId, true);
    expect(doc).not.toBeNull();
    expect(doc?.state).toBe("ready");
    expect(doc?.competitionId).toBe(competitionId);
    expect(doc?.canEdit).toBe(true);

    expect(doc?.officials).toHaveLength(1);
    expect(doc?.officials[0]).toEqual({
      id: official1Id,
      competitionId,
      name: "Official Alpha",
      defaultRole: "Lead Referee",
      archived: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(doc?.availability[official1Id]).toEqual([
      {
        startsAt: "2026-08-15T09:00:00.000Z",
        endsAt: "2026-08-15T12:00:00.000Z",
      },
    ]);

    expect(doc?.assignments).toEqual([
      {
        matchId: match1Id,
        officialId: official1Id,
        assignedRole: "Lead Referee",
        official: {
          id: official1Id,
          name: "Official Alpha",
          defaultRole: "Lead Referee",
          archived: false,
        },
      },
    ]);
  });

  it("rejects root payload with unknown fields", () => {
    const malformed = { ...validPayload, unexpected_secret: "leak" };
    expect(parseOfficialWorkspaceResponse(malformed, competitionId)).toBeNull();
  });

  it("rejects official with unknown fields", () => {
    const malformed = {
      ...validPayload,
      officials: [
        {
          ...validPayload.officials[0],
          account_id: "private_acc",
        },
      ],
    };
    expect(parseOfficialWorkspaceResponse(malformed, competitionId)).toBeNull();
  });

  it("rejects official with empty name", () => {
    const malformed = {
      ...validPayload,
      officials: [
        {
          ...validPayload.officials[0],
          name: "",
        },
      ],
    };
    expect(parseOfficialWorkspaceResponse(malformed, competitionId)).toBeNull();
  });

  it("rejects availability window where starts_at >= ends_at", () => {
    const malformed = {
      ...validPayload,
      availability: {
        [official1Id]: [
          {
            starts_at: "2026-08-15T12:00:00.000Z",
            ends_at: "2026-08-15T09:00:00.000Z",
          },
        ],
      },
    };
    expect(parseOfficialWorkspaceResponse(malformed, competitionId)).toBeNull();
  });

  it("rejects assignment with unknown fields", () => {
    const malformed = {
      ...validPayload,
      assignments: [
        {
          ...validPayload.assignments[0],
          unknown_field: true,
        },
      ],
    };
    expect(parseOfficialWorkspaceResponse(malformed, competitionId)).toBeNull();
  });

  it("generates deterministic demo workspace for fixtures", () => {
    const demo = createDemoOfficialWorkspace("singapore-open");
    expect(demo.state).toBe("ready");
    expect(demo.officials.length).toBeGreaterThanOrEqual(3);

    const active = demo.officials.filter((o) => !o.archived);
    const archived = demo.officials.filter((o) => o.archived);
    expect(active.length).toBe(2);
    expect(archived.length).toBe(1);

    expect(demo.officials.find((o) => o.name === "Official A")).toBeDefined();
    expect(demo.officials.find((o) => o.name === "Official B")).toBeDefined();
    expect(demo.officials.find((o) => o.name === "Archived Official C")).toBeDefined();

    const officialA = demo.officials.find((o) => o.name === "Official A")!;
    expect(demo.availability[officialA.id]?.length).toBeGreaterThan(0);
    expect(demo.assignments.some((a) => a.officialId === officialA.id)).toBe(true);

    const officialB = demo.officials.find((o) => o.name === "Official B")!;
    expect(demo.availability[officialB.id]?.length).toBeGreaterThan(0);
    expect(demo.assignments.some((a) => a.officialId === officialB.id)).toBe(true);
  });

  it("provides fallback unavailable document", () => {
    const doc = officialWorkspaceUnavailableDocument(competitionId, "offline", false);
    expect(doc.state).toBe("offline");
    expect(doc.canEdit).toBe(false);
    expect(doc.officials).toEqual([]);
    expect(doc.availability).toEqual({});
    expect(doc.assignments).toEqual([]);
  });

  it("formats copy pluralisation correctly", () => {
    expect(phase4OfficialsCopy.assignmentsCount(0)).toBe("0 assignments");
    expect(phase4OfficialsCopy.assignmentsCount(1)).toBe("1 assignment");
    expect(phase4OfficialsCopy.assignmentsCount(2)).toBe("2 assignments");
    expect(phase4OfficialsCopy.windowsCount(0)).toBe("0 windows");
    expect(phase4OfficialsCopy.windowsCount(1)).toBe("1 window");
    expect(phase4OfficialsCopy.windowsCount(2)).toBe("2 windows");
  });

  describe("UUID validation helper", () => {
    it("accepts valid RFC4122 UUIDs", () => {
      expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
      expect(isUuid("10000000-0000-4000-8000-000000000001")).toBe(true);
      expect(isUuid("c0000000-0000-0000-0000-000000000001")).toBe(true);
    });

    it("rejects malformed or non-UUID inputs", () => {
      expect(isUuid("abc")).toBe(false);
      expect(isUuid("")).toBe(false);
      expect(isUuid("6000")).toBe(false);
      expect(isUuid("not-a-uuid-string-of-length-thirty-six")).toBe(false);
      expect(isUuid(null)).toBe(false);
      expect(isUuid(undefined)).toBe(false);
      expect(isUuid(12345)).toBe(false);
    });
  });

  describe("RFC3339 date-time validation helper", () => {
    it("accepts valid RFC3339 date-times with Z or numeric offsets", () => {
      expect(isRfc3339DateTime("2026-09-29T15:30:00Z")).toBe(true);
      expect(isRfc3339DateTime("2026-09-29T15:30:00.000Z")).toBe(true);
      expect(isRfc3339DateTime("2026-09-29T23:30:00+08:00")).toBe(true);
      expect(isRfc3339DateTime("2026-09-29T23:30:00-05:00")).toBe(true);
    });

    it("rejects non-RFC3339 date strings", () => {
      expect(isRfc3339DateTime("2026-09-29")).toBe(false);
      expect(isRfc3339DateTime("09/29/2026")).toBe(false);
      expect(isRfc3339DateTime("2026-09-29 15:30")).toBe(false);
      expect(isRfc3339DateTime("15:30")).toBe(false);
      expect(isRfc3339DateTime("")).toBe(false);
      expect(isRfc3339DateTime("invalid-timestamp")).toBe(false);
      expect(isRfc3339DateTime(null)).toBe(false);
    });
  });

  describe("strict upstream response parsing", () => {
    it("isOfficialResponse rejects non-UUID id or competition_id", () => {
      const valid = {
        id: official1Id,
        competition_id: competitionId,
        name: "Official A",
        default_role: "Lead",
        archived: false,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      };
      expect(isOfficialResponse(valid)).toBe(true);
      expect(isOfficialResponse({ ...valid, id: "not-a-uuid" })).toBe(false);
      expect(isOfficialResponse({ ...valid, competition_id: "not-a-uuid" })).toBe(false);
      expect(isOfficialResponse({ ...valid, created_at: "2026-08-01" })).toBe(false);
    });

    it("isOfficialMutationResponse rejects non-UUID official", () => {
      expect(
        isOfficialMutationResponse({
          official: {
            id: "not-a-uuid",
            competition_id: competitionId,
            name: "Official A",
            default_role: null,
            archived: false,
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-01T00:00:00.000Z",
          },
          bumped_revision: true,
        }),
      ).toBe(false);
    });

    it("isAvailabilityMutationResponse rejects non-RFC3339 window timestamp", () => {
      expect(
        isAvailabilityMutationResponse({
          windows: [{ starts_at: "2026-08-15 09:00", ends_at: "2026-08-15 12:00" }],
          bumped_revision: true,
        }),
      ).toBe(false);
    });

    it("isMatchOfficialsMutationResponse rejects non-UUID match_id or official_id", () => {
      expect(
        isMatchOfficialsMutationResponse({
          assignments: [{ match_id: "not-a-uuid", official_id: official1Id, assigned_role: null }],
          bumped_revision: true,
        }),
      ).toBe(false);
      expect(
        isMatchOfficialsMutationResponse({
          assignments: [{ match_id: match1Id, official_id: "6000", assigned_role: null }],
          bumped_revision: true,
        }),
      ).toBe(false);
      expect(
        isMatchOfficialsMutationResponse({
          assignments: [
            {
              match_id: match1Id,
              official_id: official1Id,
              assigned_role: "Lead",
              official: {
                id: "not-a-uuid",
                name: "Official A",
                default_role: null,
                archived: false,
              },
            },
          ],
          bumped_revision: true,
        }),
      ).toBe(false);
    });

    it("isOfficialWorkspaceResponse rejects non-UUID availability map keys", () => {
      const invalidKeys = {
        ...validPayload,
        availability: {
          "not-a-uuid-key": [{ starts_at: "2026-08-15T09:00:00.000Z", ends_at: "2026-08-15T12:00:00.000Z" }],
        },
      };
      expect(isOfficialWorkspaceResponse(invalidKeys)).toBe(false);
      expect(parseOfficialWorkspaceResponse(invalidKeys, competitionId)).toBeNull();
    });
  });
});
