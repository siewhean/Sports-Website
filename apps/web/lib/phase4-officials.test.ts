import { describe, expect, it } from "vitest";
import {
  createDemoOfficialWorkspace,
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
});
