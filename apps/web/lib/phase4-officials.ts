import type { SurfaceState } from "./phase2";

export const phase4OfficialsCopy = {
  title: "Officials",
  intro: "Manage competition officials, their availability, and match assignments.",
  rosterTitle: "Officials roster",
  activeOfficials: "Active officials",
  archivedOfficials: "Archived officials",
  showArchived: "Show archived",
  hideArchived: "Hide archived",
  noOfficials: "No active officials added yet.",
  noArchivedOfficials: "No archived officials.",
  addOfficial: "Add official",
  roleLabel: "Default role",
  unassignedRole: "No default role",
  assignmentsLabel: "Assignments",
  availabilityLabel: "Availability",
  archivedBadge: "Archived",
  readOnlyNotice: "Roster is in read-only mode.",
  assignmentsCount: (n: number) => (n === 1 ? "1 assignment" : `${n} assignments`),
  windowsCount: (n: number) => (n === 1 ? "1 window" : `${n} windows`),
  errorTitle: "Officials unavailable",
  errorBody: "Unable to load officials at this time.",
} as const;

export type OfficialView = {
  id: string;
  competitionId: string;
  name: string;
  defaultRole: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AvailabilityWindowView = {
  startsAt: string;
  endsAt: string;
};

export type MatchOfficialAssignmentView = {
  matchId: string;
  officialId: string;
  assignedRole: string | null;
  official?: {
    id: string;
    name: string;
    defaultRole: string | null;
    archived: boolean;
  };
};

export type OfficialWorkspace = {
  officials: OfficialView[];
  availability: Record<string, AvailabilityWindowView[]>;
  assignments: MatchOfficialAssignmentView[];
};

export type OfficialWorkspaceDocument = {
  state: SurfaceState;
  competitionId: string;
  officials: OfficialView[];
  availability: Record<string, AvailabilityWindowView[]>;
  assignments: MatchOfficialAssignmentView[];
  canEdit: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

export function parseOfficialWorkspaceResponse(
  value: unknown,
  competitionId: string,
  canEdit = true,
): OfficialWorkspaceDocument | null {
  const root = record(value);
  if (!root || !exact(root, ["officials", "availability", "assignments"])) {
    return null;
  }

  if (!Array.isArray(root.officials) || !Array.isArray(root.assignments)) {
    return null;
  }

  const availabilityRaw = record(root.availability);
  if (!availabilityRaw) return null;

  const officials: OfficialView[] = [];
  for (const item of root.officials) {
    const row = record(item);
    if (!row || !exact(row, ["id", "competition_id", "name", "default_role", "archived", "created_at", "updated_at"])) {
      return null;
    }
    if (!nonEmpty(row.id) || !nonEmpty(row.competition_id)) return null;
    if (typeof row.name !== "string" || row.name.length < 1 || row.name.length > 80) return null;
    if (
      row.default_role !== null &&
      (typeof row.default_role !== "string" || row.default_role.length < 1 || row.default_role.length > 40)
    ) {
      return null;
    }
    if (typeof row.archived !== "boolean") return null;
    if (!isoDate(row.created_at) || !isoDate(row.updated_at)) return null;

    officials.push({
      id: row.id,
      competitionId: row.competition_id,
      name: row.name,
      defaultRole: row.default_role,
      archived: row.archived,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  const availability: Record<string, AvailabilityWindowView[]> = {};
  for (const [officialId, windowsRaw] of Object.entries(availabilityRaw)) {
    if (!nonEmpty(officialId) || !Array.isArray(windowsRaw)) return null;
    const windowList: AvailabilityWindowView[] = [];
    for (const w of windowsRaw) {
      const windowRow = record(w);
      if (!windowRow || !exact(windowRow, ["starts_at", "ends_at"])) return null;
      if (!isoDate(windowRow.starts_at) || !isoDate(windowRow.ends_at)) return null;
      if (Date.parse(windowRow.starts_at) >= Date.parse(windowRow.ends_at)) return null;
      windowList.push({
        startsAt: windowRow.starts_at,
        endsAt: windowRow.ends_at,
      });
    }
    availability[officialId] = windowList;
  }

  const assignments: MatchOfficialAssignmentView[] = [];
  for (const item of root.assignments) {
    const row = record(item);
    if (!row) return null;
    const hasOfficial = "official" in row;
    const expectedKeys = hasOfficial
      ? ["match_id", "official_id", "assigned_role", "official"]
      : ["match_id", "official_id", "assigned_role"];
    if (!exact(row, expectedKeys)) return null;
    if (!nonEmpty(row.match_id) || !nonEmpty(row.official_id)) return null;
    if (
      row.assigned_role !== null &&
      (typeof row.assigned_role !== "string" || row.assigned_role.length < 1 || row.assigned_role.length > 40)
    ) {
      return null;
    }

    let nestedOfficial: MatchOfficialAssignmentView["official"] = undefined;
    if (hasOfficial && row.official !== undefined) {
      const offRow = record(row.official);
      if (!offRow || !exact(offRow, ["id", "name", "default_role", "archived"])) return null;
      if (!nonEmpty(offRow.id)) return null;
      if (typeof offRow.name !== "string" || offRow.name.length < 1 || offRow.name.length > 80) return null;
      if (
        offRow.default_role !== null &&
        (typeof offRow.default_role !== "string" || offRow.default_role.length < 1 || offRow.default_role.length > 40)
      ) {
        return null;
      }
      if (typeof offRow.archived !== "boolean") return null;
      nestedOfficial = {
        id: offRow.id,
        name: offRow.name,
        defaultRole: offRow.default_role,
        archived: offRow.archived,
      };
    }

    assignments.push({
      matchId: row.match_id,
      officialId: row.official_id,
      assignedRole: row.assigned_role,
      official: nestedOfficial,
    });
  }

  return {
    state: "ready",
    competitionId,
    officials,
    availability,
    assignments,
    canEdit,
  };
}

export function officialWorkspaceUnavailableDocument(
  competitionId: string,
  state: SurfaceState,
  canEdit = false,
): OfficialWorkspaceDocument {
  return {
    state,
    competitionId,
    officials: [],
    availability: {},
    assignments: [],
    canEdit,
  };
}

export function createDemoOfficialWorkspace(competitionId: string): OfficialWorkspaceDocument {
  const officialAId = "60000000-0000-4000-8000-000000000001";
  const officialBId = "60000000-0000-4000-8000-000000000002";
  const officialCId = "60000000-0000-4000-8000-000000000003";

  const match1Id = "30000000-0000-4000-8000-000000000001";
  const match2Id = "30000000-0000-4000-8000-000000000002";

  return {
    state: "ready",
    competitionId,
    canEdit: true,
    officials: [
      {
        id: officialAId,
        competitionId,
        name: "Official A",
        defaultRole: "Lead Official",
        archived: false,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
      {
        id: officialBId,
        competitionId,
        name: "Official B",
        defaultRole: "Line Judge",
        archived: false,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
      {
        id: officialCId,
        competitionId,
        name: "Archived Official C",
        defaultRole: "Timekeeper",
        archived: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
    ],
    availability: {
      [officialAId]: [
        {
          startsAt: "2026-08-15T01:00:00.000Z",
          endsAt: "2026-08-15T05:00:00.000Z",
        },
        {
          startsAt: "2026-08-15T06:00:00.000Z",
          endsAt: "2026-08-15T10:00:00.000Z",
        },
      ],
      [officialBId]: [
        {
          startsAt: "2026-08-15T02:00:00.000Z",
          endsAt: "2026-08-15T08:00:00.000Z",
        },
      ],
      [officialCId]: [],
    },
    assignments: [
      {
        matchId: match1Id,
        officialId: officialAId,
        assignedRole: "Lead Official",
        official: {
          id: officialAId,
          name: "Official A",
          defaultRole: "Lead Official",
          archived: false,
        },
      },
      {
        matchId: match2Id,
        officialId: officialBId,
        assignedRole: "Line Judge",
        official: {
          id: officialBId,
          name: "Official B",
          defaultRole: "Line Judge",
          archived: false,
        },
      },
    ],
  };
}
