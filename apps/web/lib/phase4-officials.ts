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
  detailsTitle: "Official details",
  selectOfficialPrompt: "Select an official to view their details.",
  editOfficial: "Edit official",
  archiveOfficial: "Archive official",
  restoreOfficial: "Restore official",
  cancel: "Cancel",
  save: "Save changes",
  saving: "Saving...",
  creating: "Creating...",
  archiving: "Archiving...",
  restoring: "Restoring...",
  createTitle: "Add official",
  editTitle: "Edit official details",
  nameLabel: "Name",
  namePlaceholder: "e.g. Aisha Tan",
  rolePlaceholder: "e.g. Lead official",
  nameRequired: "Name is required.",
  nameTooLong: "Name must be 80 characters or fewer.",
  roleTooLong: "Default role must be 40 characters or fewer.",
  duplicateNameError: "An active official with this name already exists.",
  archiveConfirmTitle: (name: string) => `Archive ${name}?`,
  archiveNoticeGeneral:
    "Archived officials remain in historical records and existing assignments. They cannot receive new assignments until restored.",
  archiveNoticeAssignments: (count: number) =>
    `This official currently has ${count === 1 ? "1 match assignment" : `${count} match assignments`}. Those assignments will remain recorded.`,
  confirmArchive: "Archive official",
  officialCreated: "Official added.",
  officialUpdated: "Official details saved.",
  officialArchived: "Official archived.",
  officialRestored: "Official restored.",
  scheduleInvalidatedNotice:
    "This official was assigned to a match. Scheduling inputs changed and the schedule must be regenerated or revalidated.",
  reviewScheduleLink: "Review schedule",
  genericMutationError: "The official could not be updated. Refresh and try again.",
  refreshFailed: "Unable to refresh officials. Please reload the page.",
  statusLabel: "Status notification",
  errorAlertLabel: "Error alert",
  selectedOfficialBadge: "Selected",
  officialNotFound: "The requested official could not be found.",
  sessionExpired: "Your session has expired. Please sign in again.",
  accessDenied: "You do not have permission to make changes.",
  revisionConflict: "The competition has changed. Please refresh the page.",
  originRejected: "Request was rejected due to an invalid origin.",
  commandResponseInvalid: "Received an unexpected response from the server.",
  apiUnavailable: "The service is temporarily unavailable. Please try again later.",
  validationFailed: "Please check the information provided and try again.",
  errorTitle: "Officials unavailable",
  errorBody: "Unable to load officials at this time.",
} as const;

export function officialCommandErrorMessage(status: number, code?: string | null): string {
  switch (code) {
    case "OFFICIAL_NAME_CONFLICT":
      return phase4OfficialsCopy.duplicateNameError;
    case "OFFICIAL_NOT_FOUND":
      return phase4OfficialsCopy.officialNotFound;
    case "VALIDATION_ERROR":
      return phase4OfficialsCopy.validationFailed;
    case "REVISION_CONFLICT":
      return phase4OfficialsCopy.revisionConflict;
    case "AUTH_REQUIRED":
      return phase4OfficialsCopy.sessionExpired;
    case "ORIGIN_REJECTED":
      return phase4OfficialsCopy.originRejected;
    case "COMMAND_RESPONSE_INVALID":
      return phase4OfficialsCopy.commandResponseInvalid;
    case "API_UNAVAILABLE":
      return phase4OfficialsCopy.apiUnavailable;
    default:
      if (status === 401) return phase4OfficialsCopy.sessionExpired;
      if (status === 403) return phase4OfficialsCopy.accessDenied;
      if (status === 404) return phase4OfficialsCopy.officialNotFound;
      if (status === 409) return phase4OfficialsCopy.duplicateNameError;
      return phase4OfficialsCopy.genericMutationError;
  }
}

export const phase4OfficialsMachine = {
  validationError: "VALIDATION_ERROR",
  commandResponseInvalid: "COMMAND_RESPONSE_INVALID",
  authRequired: "AUTH_REQUIRED",
  apiUnavailable: "API_UNAVAILABLE",
  upstreamError: "UPSTREAM_ERROR",
  noStore: "no-store",
  cacheControl: "cache-control",
  get: "GET",
  post: "POST",
  patch: "PATCH",
  put: "PUT",
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

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export function isRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string" || !RFC3339_PATTERN.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time);
}

export function isoDate(value: unknown): value is string {
  return isRfc3339DateTime(value);
}

export function isOfficialResponse(value: unknown): boolean {
  const row = record(value);
  if (!row || !exact(row, ["id", "competition_id", "name", "default_role", "archived", "created_at", "updated_at"])) {
    return false;
  }
  if (!isUuid(row.id) || !isUuid(row.competition_id)) return false;
  if (typeof row.name !== "string" || row.name.length < 1 || row.name.length > 80) return false;
  if (
    row.default_role !== null &&
    (typeof row.default_role !== "string" || row.default_role.length < 1 || row.default_role.length > 40)
  ) {
    return false;
  }
  if (typeof row.archived !== "boolean") return false;
  if (!isRfc3339DateTime(row.created_at) || !isRfc3339DateTime(row.updated_at)) return false;
  return true;
}

export function isOfficialMutationResponse(value: unknown): boolean {
  const root = record(value);
  if (!root || !exact(root, ["official", "bumped_revision"])) return false;
  if (typeof root.bumped_revision !== "boolean") return false;
  return isOfficialResponse(root.official);
}

export function isAvailabilityMutationResponse(value: unknown): boolean {
  const root = record(value);
  if (!root || !exact(root, ["windows", "bumped_revision"])) return false;
  if (typeof root.bumped_revision !== "boolean") return false;
  if (!Array.isArray(root.windows)) return false;
  for (const w of root.windows) {
    const row = record(w);
    if (!row || !exact(row, ["starts_at", "ends_at"])) return false;
    if (!isRfc3339DateTime(row.starts_at) || !isRfc3339DateTime(row.ends_at)) return false;
    if (Date.parse(row.starts_at) >= Date.parse(row.ends_at)) return false;
  }
  return true;
}

export function isMatchOfficialsMutationResponse(value: unknown): boolean {
  const root = record(value);
  if (!root || !exact(root, ["assignments", "bumped_revision"])) return false;
  if (typeof root.bumped_revision !== "boolean") return false;
  if (!Array.isArray(root.assignments)) return false;
  for (const a of root.assignments) {
    const row = record(a);
    if (!row) return false;
    const hasOfficial = "official" in row;
    const expectedKeys = hasOfficial
      ? ["assigned_role", "match_id", "official", "official_id"]
      : ["assigned_role", "match_id", "official_id"];
    if (!exact(row, expectedKeys)) return false;
    if (!isUuid(row.match_id) || !isUuid(row.official_id)) return false;
    if (
      row.assigned_role !== null &&
      (typeof row.assigned_role !== "string" || row.assigned_role.length < 1 || row.assigned_role.length > 40)
    ) {
      return false;
    }
    if (hasOfficial && row.official !== undefined) {
      const off = record(row.official);
      if (!off || !exact(off, ["archived", "default_role", "id", "name"])) return false;
      if (!isUuid(off.id)) return false;
      if (typeof off.name !== "string" || off.name.length < 1 || off.name.length > 80) return false;
      if (
        off.default_role !== null &&
        (typeof off.default_role !== "string" || off.default_role.length < 1 || off.default_role.length > 40)
      ) {
        return false;
      }
      if (typeof off.archived !== "boolean") return false;
    }
  }
  return true;
}

export function isOfficialWorkspaceResponse(value: unknown): boolean {
  const root = record(value);
  if (!root || !exact(root, ["officials", "availability", "assignments"])) return false;
  if (!Array.isArray(root.officials) || !Array.isArray(root.assignments)) return false;
  const availabilityRaw = record(root.availability);
  if (!availabilityRaw) return false;

  for (const item of root.officials) {
    if (!isOfficialResponse(item)) return false;
  }

  for (const [officialId, windowsRaw] of Object.entries(availabilityRaw)) {
    if (!isUuid(officialId) || !Array.isArray(windowsRaw)) return false;
    for (const w of windowsRaw) {
      const windowRow = record(w);
      if (!windowRow || !exact(windowRow, ["starts_at", "ends_at"])) return false;
      if (!isRfc3339DateTime(windowRow.starts_at) || !isRfc3339DateTime(windowRow.ends_at)) return false;
      if (Date.parse(windowRow.starts_at) >= Date.parse(windowRow.ends_at)) return false;
    }
  }

  for (const item of root.assignments) {
    const row = record(item);
    if (!row) return false;
    const hasOfficial = "official" in row;
    const expectedKeys = hasOfficial
      ? ["assigned_role", "match_id", "official", "official_id"]
      : ["assigned_role", "match_id", "official_id"];
    if (!exact(row, expectedKeys)) return false;
    if (!isUuid(row.match_id) || !isUuid(row.official_id)) return false;
    if (
      row.assigned_role !== null &&
      (typeof row.assigned_role !== "string" || row.assigned_role.length < 1 || row.assigned_role.length > 40)
    ) {
      return false;
    }
    if (hasOfficial && row.official !== undefined) {
      const off = record(row.official);
      if (!off || !exact(off, ["archived", "default_role", "id", "name"])) return false;
      if (!isUuid(off.id)) return false;
      if (typeof off.name !== "string" || off.name.length < 1 || off.name.length > 80) return false;
      if (
        off.default_role !== null &&
        (typeof off.default_role !== "string" || off.default_role.length < 1 || off.default_role.length > 40)
      ) {
        return false;
      }
      if (typeof off.archived !== "boolean") return false;
    }
  }

  return true;
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
    if (!isUuid(row.id) || !isUuid(row.competition_id)) return null;
    if (typeof row.name !== "string" || row.name.length < 1 || row.name.length > 80) return null;
    if (
      row.default_role !== null &&
      (typeof row.default_role !== "string" || row.default_role.length < 1 || row.default_role.length > 40)
    ) {
      return null;
    }
    if (typeof row.archived !== "boolean") return null;
    if (!isRfc3339DateTime(row.created_at) || !isRfc3339DateTime(row.updated_at)) return null;

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
    if (!isUuid(officialId) || !Array.isArray(windowsRaw)) return null;
    const windowList: AvailabilityWindowView[] = [];
    for (const w of windowsRaw) {
      const windowRow = record(w);
      if (!windowRow || !exact(windowRow, ["starts_at", "ends_at"])) return null;
      if (!isRfc3339DateTime(windowRow.starts_at) || !isRfc3339DateTime(windowRow.ends_at)) return null;
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
    if (!isUuid(row.match_id) || !isUuid(row.official_id)) return null;
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
      if (!isUuid(offRow.id)) return null;
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

export function createDemoOfficialWorkspace(competitionId: string, canEdit = true): OfficialWorkspaceDocument {
  const officialAId = "60000000-0000-4000-8000-000000000001";
  const officialBId = "60000000-0000-4000-8000-000000000002";
  const officialCId = "60000000-0000-4000-8000-000000000003";

  const match1Id = "30000000-0000-4000-8000-000000000001";
  const match2Id = "30000000-0000-4000-8000-000000000002";

  return {
    state: "ready",
    competitionId,
    canEdit,
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
