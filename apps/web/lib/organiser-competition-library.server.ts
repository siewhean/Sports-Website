import "server-only";

import { cookies, headers } from "next/headers";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { requestCanForwardSessionCookie } from "@/lib/phase3-origin";
import {
  organiserCompetitionLibraryCopy,
  parseOrganiserCompetitionLibrary,
  type OrganiserCompetitionLibraryItem,
} from "@/lib/organiser-competition-library";

export type OrganiserCompetitionLibraryReadResult =
  | { state: "ready"; competitions: OrganiserCompetitionLibraryItem[] }
  | { state: "permission" }
  | { state: "error" };

const sessionCookieNames = ["__Host-matchday_session", "matchday_session"] as const;

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
  for (const name of sessionCookieNames) {
    const value = cookieStore.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

export async function getOrganiserCompetitionLibrary(): Promise<OrganiserCompetitionLibraryReadResult> {
  if (demoFixturesEnabled()) return { state: "ready", competitions: [] };

  const baseUrl = apiBaseUrl();
  if (!baseUrl) return { state: "error" };
  const cookie = await sessionCookieHeader(baseUrl);
  if (!cookie) return { state: "permission" };

  try {
    const response = await fetch(new URL("/api/v1/organiser/competitions", baseUrl), {
      headers: { accept: "application/json", cookie },
      cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) return { state: "permission" };
    if (!response.ok) return { state: "error" };
    const payload: unknown = await response.json();
    const competitions = parseOrganiserCompetitionLibrary(payload);
    return competitions ? { state: "ready", competitions } : { state: "error" };
  } catch (error) {
    console.error(organiserCompetitionLibraryCopy.loadError, error);
    return { state: "error" };
  }
}
