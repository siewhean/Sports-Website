import "server-only";

import { cookies, headers } from "next/headers";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { requestCanForwardSessionCookie } from "@/lib/phase3-origin";
import {
  createDemoOfficialWorkspace,
  officialWorkspaceUnavailableDocument,
  parseOfficialWorkspaceResponse,
  type OfficialWorkspaceDocument,
} from "@/lib/phase4-officials";

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

export async function getOfficialWorkspace(competitionId: string, canEdit = true): Promise<OfficialWorkspaceDocument> {
  if (demoFixturesEnabled()) {
    return createDemoOfficialWorkspace(competitionId, canEdit);
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
