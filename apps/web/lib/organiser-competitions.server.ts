import "server-only";

import { cookies, headers } from "next/headers";
import { cookieHostMatches, publicRequestHost } from "@/lib/phase2-organiser";

export type OrganiserCompetitionListItem = {
  id: string;
  name: string;
  slug: string;
  sport_code: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";
  status: string;
  starts_on: string;
  ends_on: string;
  organisation_name: string;
  membership_role: "owner" | "organiser" | "viewer";
};

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
  if (!cookieHostMatches(publicRequestHost(await headers()), apiUrl.hostname)) return null;
  const cookieStore = await cookies();
  for (const name of sessionCookieNames) {
    const value = cookieStore.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

function isCompetitionList(value: unknown): value is OrganiserCompetitionListItem[] {
  const sports = new Set(["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"]);
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.organisation_name === "string" &&
        typeof item.starts_on === "string" &&
        typeof item.ends_on === "string" &&
        typeof item.sport_code === "string" &&
        sports.has(item.sport_code),
    )
  );
}

export async function getOrganiserCompetitions(): Promise<
  { state: "ready"; competitions: OrganiserCompetitionListItem[] } | { state: "permission" | "error" }
> {
  const baseUrl = apiBaseUrl();
  if (!baseUrl) return { state: "error" };
  const cookie = await sessionCookieHeader(baseUrl);
  if (!cookie) return { state: "permission" };
  try {
    const response = await fetch(new URL("/api/v1/competitions", baseUrl), {
      headers: { accept: "application/json", cookie },
      cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) return { state: "permission" };
    if (!response.ok) return { state: "error" };
    const payload: unknown = await response.json();
    return isCompetitionList(payload) ? { state: "ready", competitions: payload } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}
