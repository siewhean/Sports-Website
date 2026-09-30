import "server-only";

import { cookies, headers } from "next/headers";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { requestCanForwardSessionCookie } from "@/lib/phase3-origin";
import {
  createDemoOfficialWorkspace,
  officialWorkspaceUnavailableDocument,
  parseOfficialWorkspaceResponse,
  type MatchOfficialAssignmentView,
  type OfficialWorkspaceDocument,
  type SurfaceState,
} from "@/lib/phase4-officials";

const globalForDemo = globalThis as unknown as {
  __demoOfficialWorkspaces?: Map<string, OfficialWorkspaceDocument>;
};

const demoWorkspaces = globalForDemo.__demoOfficialWorkspaces ?? new Map<string, OfficialWorkspaceDocument>();
if (!globalForDemo.__demoOfficialWorkspaces) {
  globalForDemo.__demoOfficialWorkspaces = demoWorkspaces;
}

export function getDemoOfficialWorkspace(competitionId: string, canEdit = true): OfficialWorkspaceDocument {
  const existing = demoWorkspaces.get(competitionId);
  if (existing) {
    return { ...existing, canEdit };
  }
  const initial = createDemoOfficialWorkspace(competitionId, canEdit);
  demoWorkspaces.set(competitionId, initial);
  return initial;
}

export function resetDemoOfficialWorkspaces(): void {
  demoWorkspaces.clear();
}

export function updateDemoMatchAssignments(
  competitionId: string,
  matchId: string,
  assignments: { official_id: string; assigned_role: string | null }[],
): MatchOfficialAssignmentView[] {
  const current = getDemoOfficialWorkspace(competitionId, true);
  const otherAssignments = current.assignments.filter((a) => a.matchId !== matchId);
  const newAssignments: MatchOfficialAssignmentView[] = assignments.map((a) => {
    const off = current.officials.find((o) => o.id === a.official_id);
    return {
      matchId,
      officialId: a.official_id,
      assignedRole: a.assigned_role,
      official: off
        ? {
            id: off.id,
            name: off.name,
            defaultRole: off.defaultRole,
            archived: off.archived,
          }
        : undefined,
    };
  });
  const updated: OfficialWorkspaceDocument = {
    ...current,
    assignments: [...otherAssignments, ...newAssignments],
  };
  demoWorkspaces.set(competitionId, updated);
  return newAssignments;
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
  if (previewState && previewState !== "ready") {
    return officialWorkspaceUnavailableDocument(competitionId, previewState, canEdit);
  }

  if (demoFixturesEnabled()) {
    return getDemoOfficialWorkspace(competitionId, canEdit);
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
