import "server-only";

import { cookies, headers } from "next/headers";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { requestCanForwardSessionCookie } from "@/lib/phase3-origin";
import {
  createDemoOfficialWorkspace,
  officialWorkspaceUnavailableDocument,
  parseOfficialWorkspaceResponse,
  phase4OfficialsCopy,
  type MatchOfficialAssignmentView,
  type OfficialWorkspaceDocument,
  type SurfaceState,
} from "@/lib/phase4-officials";

export const DEMO_SCOPE_COOKIE = "matchday_demo_scope";
const DEMO_SCOPE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export function resolveDemoScope(value?: string | null): string {
  if (!value || typeof value !== "string") return "default";
  const trimmed = value.trim();
  if (!DEMO_SCOPE_PATTERN.test(trimmed)) return "default";
  return trimmed;
}

export function demoScopeKey(scope: string, competitionId: string): string {
  return `${resolveDemoScope(scope)}:${competitionId}`;
}

const globalForDemo = globalThis as unknown as {
  __demoOfficialWorkspaces?: Map<string, OfficialWorkspaceDocument>;
};

const demoWorkspaces = globalForDemo.__demoOfficialWorkspaces ?? new Map<string, OfficialWorkspaceDocument>();
if (!globalForDemo.__demoOfficialWorkspaces) {
  globalForDemo.__demoOfficialWorkspaces = demoWorkspaces;
}

export function getDemoOfficialWorkspace(
  competitionId: string,
  canEdit = true,
  scope = "default",
): OfficialWorkspaceDocument {
  const key = demoScopeKey(scope, competitionId);
  const existing = demoWorkspaces.get(key);
  if (existing) {
    return { ...existing, canEdit };
  }
  const initial = createDemoOfficialWorkspace(competitionId, canEdit);
  demoWorkspaces.set(key, initial);
  return initial;
}

export function resetDemoOfficialWorkspaces(scope?: string): void {
  if (scope) {
    const safeScope = resolveDemoScope(scope);
    const prefix = `${safeScope}:`;
    for (const key of Array.from(demoWorkspaces.keys())) {
      if (key.startsWith(prefix)) {
        demoWorkspaces.delete(key);
      }
    }
  } else {
    demoWorkspaces.clear();
  }
}

export type UpdateDemoAssignmentsResult =
  | {
      ok: true;
      assignments: MatchOfficialAssignmentView[];
      bumpedRevision: boolean;
    }
  | {
      ok: false;
      status: number;
      errorCode: string;
      message: string;
    };

export function updateDemoMatchAssignments(
  competitionId: string,
  matchId: string,
  assignments: { official_id: string; assigned_role: string | null }[],
  scope = "default",
): UpdateDemoAssignmentsResult {
  const current = getDemoOfficialWorkspace(competitionId, true, scope);
  const existingMatchAssignments = current.assignments.filter((a) => a.matchId === matchId);
  const existingIds = [...new Set(existingMatchAssignments.map((a) => a.officialId))].sort();

  // 1. Fail-closed: Unknown official ID rejected
  for (const a of assignments) {
    const off = current.officials.find((o) => o.id === a.official_id);
    if (!off) {
      return {
        ok: false,
        status: 404,
        errorCode: "OFFICIAL_NOT_FOUND",
        message: phase4OfficialsCopy.officialNotFound,
      };
    }
  }

  // 2. Fail-closed: Newly assigned archived official rejected
  for (const a of assignments) {
    const off = current.officials.find((o) => o.id === a.official_id)!;
    if (off.archived && !existingIds.includes(off.id)) {
      return {
        ok: false,
        status: 400,
        errorCode: "OFFICIAL_ARCHIVED",
        message: phase4OfficialsCopy.archivedCannotReassign,
      };
    }
  }

  // 3. Compute membership change (official-ID membership only, ignoring order and roles)
  const nextIds = [...new Set(assignments.map((a) => a.official_id))].sort();
  const bumpedRevision =
    existingIds.length !== nextIds.length || existingIds.some((id, index) => id !== nextIds[index]);

  const otherAssignments = current.assignments.filter((a) => a.matchId !== matchId);
  const newAssignments: MatchOfficialAssignmentView[] = assignments.map((a) => {
    const off = current.officials.find((o) => o.id === a.official_id)!;
    return {
      matchId,
      officialId: a.official_id,
      assignedRole: a.assigned_role,
      official: {
        id: off.id,
        name: off.name,
        defaultRole: off.defaultRole,
        archived: off.archived,
      },
    };
  });
  const updated: OfficialWorkspaceDocument = {
    ...current,
    assignments: [...otherAssignments, ...newAssignments],
  };
  const key = demoScopeKey(scope, competitionId);
  demoWorkspaces.set(key, updated);

  return {
    ok: true,
    assignments: newAssignments,
    bumpedRevision,
  };
}

function apiBaseUrl(): URL | null {
  const configured = process.env.MATCHDAY_API_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function sessionCookieHeader(apiUrl: URL): Promise<string | null> {
  const requestHeaders = await headers();
  if (!requestCanForwardSessionCookie(requestHeaders, apiUrl.hostname, process.env.MATCHDAY_PUBLIC_ORIGIN)) return null;
  const cookieStore = await cookies();
  for (const name of ["__Host-matchday_session", "matchday_session"] as const) {
    const value = cookieStore.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

export async function getOfficialWorkspace(
  competitionId: string,
  canEdit = true,
  previewState?: SurfaceState | null,
): Promise<OfficialWorkspaceDocument> {
  if (demoFixturesEnabled()) {
    if (previewState && previewState !== "ready") {
      return officialWorkspaceUnavailableDocument(competitionId, previewState, canEdit);
    }
    const cookieStore = await cookies();
    const scope = resolveDemoScope(cookieStore.get(DEMO_SCOPE_COOKIE)?.value);
    return getDemoOfficialWorkspace(competitionId, canEdit, scope);
  }

  if (previewState && previewState !== "ready" && process.env.NODE_ENV !== "production") {
    return officialWorkspaceUnavailableDocument(competitionId, previewState, canEdit);
  }

  const base = apiBaseUrl();
  if (!base) {
    return officialWorkspaceUnavailableDocument(competitionId, "error", canEdit);
  }

  const cookie = await sessionCookieHeader(base);
  if (!cookie) {
    return officialWorkspaceUnavailableDocument(competitionId, "permission", canEdit);
  }

  try {
    const response = await fetch(
      new URL(`/api/v1/phase4/competitions/${encodeURIComponent(competitionId)}/officials/workspace`, base),
      {
        cache: "no-store",
        headers: {
          accept: "application/json",
          cookie,
        },
      },
    );

    if (response.status === 401 || response.status === 403) {
      return officialWorkspaceUnavailableDocument(competitionId, "permission", canEdit);
    }
    if (response.status === 404) {
      return officialWorkspaceUnavailableDocument(competitionId, "empty", canEdit);
    }
    if (!response.ok) {
      return officialWorkspaceUnavailableDocument(competitionId, "error", canEdit);
    }

    const payload: unknown = await response.json();
    const parsed = parseOfficialWorkspaceResponse(payload, competitionId, canEdit);
    if (!parsed) {
      return officialWorkspaceUnavailableDocument(competitionId, "error", canEdit);
    }
    return parsed;
  } catch {
    return officialWorkspaceUnavailableDocument(competitionId, "offline", canEdit);
  }
}
