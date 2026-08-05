import "server-only";

import { cookies, headers } from "next/headers";
import { demoCompetitionReadPort, phase2Competition, type CompetitionView } from "@/lib/phase2";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { cookieHostMatches, isOrganiserWorkspacePayload, toOrganiserCompetitionView } from "@/lib/phase2-organiser";

export type OrganiserCompetitionReadResult =
  | { state: "ready"; competition: CompetitionView }
  | { state: "permission" }
  | { state: "notFound" }
  | { state: "error" };

const competitionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  const requestHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() || requestHeaders.get("host");
  if (!cookieHostMatches(requestHost, apiUrl.hostname)) return null;

  const cookieStore = await cookies();
  for (const name of sessionCookieNames) {
    const value = cookieStore.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

export async function getOrganiserCompetitionView(id: string): Promise<OrganiserCompetitionReadResult> {
  if (demoFixturesEnabled()) {
    const competition = await demoCompetitionReadPort.getBySlug(id);
    if (!competition && id !== phase2Competition.id) return { state: "notFound" };
    const demo = competition ?? phase2Competition;
    return { state: "ready", competition: demo };
  }
  if (!competitionIdPattern.test(id)) return { state: "notFound" };

  const baseUrl = apiBaseUrl();
  if (!baseUrl) return { state: "error" };
  const cookie = await sessionCookieHeader(baseUrl);
  if (!cookie) return { state: "permission" };

  try {
    const response = await fetch(new URL(`/api/v1/competitions/${encodeURIComponent(id)}`, baseUrl), {
      headers: { accept: "application/json", cookie },
      cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) return { state: "permission" };
    if (response.status === 404) return { state: "notFound" };
    if (!response.ok) return { state: "error" };
    const payload: unknown = await response.json();
    return isOrganiserWorkspacePayload(payload)
      ? { state: "ready", competition: toOrganiserCompetitionView(payload) }
      : { state: "error" };
  } catch {
    return { state: "error" };
  }
}
