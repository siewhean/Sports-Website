import "server-only";

import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";

import { cookies, headers } from "next/headers";
import { requestCanForwardSessionCookie } from "@/lib/phase3-origin";
import { parseCapacityResponse, type CapacityDocument, type CapacitySurfaceState } from "@/lib/phase3-capacity";

const DEMO_IDS = {
  area: "8e66bd53-a9cb-4cde-840a-cc94988ca461",
  available: "75706328-3058-44f0-a06a-8eb08980dd81",
  unavailable: "b640f3a6-3a6f-4376-87a3-f3ac31d071a4",
} as const;

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

async function sessionCookie(apiUrl: URL): Promise<string | null> {
  const requestHeaders = await headers();
  if (!requestCanForwardSessionCookie(requestHeaders, apiUrl.hostname, process.env.MATCHDAY_PUBLIC_ORIGIN)) return null;
  const store = await cookies();
  for (const name of ["__Host-matchday_session", "matchday_session"]) {
    const value = store.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

function unavailable(competitionId: string, competitionName: string, state: CapacitySurfaceState): CapacityDocument {
  return {
    state,
    competitionId,
    competitionName,
    canEdit: false,
    revision: 1,
    timezone: "UTC",
    summary: null,
    areas: [],
  };
}

function demoDocument(competitionId: string, competitionName: string): CapacityDocument {
  const parsed = parseCapacityResponse(
    {
      competition_id: competitionId,
      revision: 4,
      timezone: "Asia/Singapore",
      permission: "write",
      read_only: false,
      areas: [
        {
          id: DEMO_IDS.area,
          name: "Pool A",
          sort_order: 0,
          slot_minutes: 30,
          fixed_reserve_slots: 2,
          availability: [
            {
              id: DEMO_IDS.available,
              date: "2026-08-15",
              start_time: "09:00",
              end_time: "19:00",
              cross_midnight: false,
              starts_at: "2026-08-15T01:00:00.000Z",
              ends_at: "2026-08-15T11:00:00.000Z",
            },
          ],
          unavailable: [
            {
              id: DEMO_IDS.unavailable,
              date: "2026-08-15",
              start_time: "13:00",
              end_time: "14:00",
              cross_midnight: false,
              starts_at: "2026-08-15T05:00:00.000Z",
              ends_at: "2026-08-15T06:00:00.000Z",
            },
          ],
        },
      ],
      effective: {
        timeZone: "Asia/Singapore",
        slotMinutes: 30,
        rawTotalSlots: 18,
        fixedReserveSlots: 2,
        availableMatchSlots: 16,
        requiredMatchSlots: 16,
        remainingMatchSlots: 0,
        status: "tight",
        areas: [
          {
            areaId: DEMO_IDS.area,
            areaName: "Pool A",
            sortOrder: 0,
            usableMinutes: 540,
            rawSlots: 18,
            intervalCount: 2,
          },
        ],
        intervals: [
          {
            id: "effective-a",
            areaId: DEMO_IDS.area,
            areaName: "Pool A",
            startEpochMs: 1786755600000,
            endEpochMs: 1786791600000,
            startIso: "2026-08-15T01:00:00.000Z",
            endIso: "2026-08-15T11:00:00.000Z",
            usableMinutes: 540,
            slots: 18,
            unusedMinutes: 0,
            sourceAvailabilityIds: [DEMO_IDS.available],
          },
        ],
      },
    },
    competitionId,
  );
  if (!parsed) return unavailable(competitionId, competitionName, "error");
  return {
    state: "ready",
    competitionId,
    competitionName,
    canEdit: true,
    revision: parsed.revision,
    timezone: parsed.timezone,
    summary: parsed.effective,
    areas: parsed.areas,
  };
}

export async function getCapacityDocument(
  competitionId: string,
  competitionName: string,
  previewState?: string,
): Promise<CapacityDocument> {
  if (demoFixturesEnabled()) {
    const allowed = new Set<CapacitySurfaceState>([
      "ready",
      "loading",
      "empty",
      "error",
      "offline",
      "permission",
      "read-only",
      "conflict",
    ]);
    const state =
      previewState && allowed.has(previewState as CapacitySurfaceState)
        ? (previewState as CapacitySurfaceState)
        : "ready";
    if (state !== "ready") return unavailable(competitionId, competitionName, state);
    return demoDocument(competitionId, competitionName);
  }
  const base = apiBaseUrl();
  if (!base) return unavailable(competitionId, competitionName, "error");
  const cookie = await sessionCookie(base);
  if (!cookie) return unavailable(competitionId, competitionName, "permission");
  try {
    const response = await fetch(new URL(`/api/v1/competitions/${encodeURIComponent(competitionId)}/capacity`, base), {
      cache: "no-store",
      headers: { accept: "application/json", cookie },
    });
    if (response.status === 401 || response.status === 403)
      return unavailable(competitionId, competitionName, "permission");
    if (!response.ok) return unavailable(competitionId, competitionName, "error");
    const parsed = parseCapacityResponse(await response.json().catch(() => null), competitionId);
    if (!parsed) return unavailable(competitionId, competitionName, "error");
    return {
      state: parsed.readOnly ? "read-only" : parsed.areas.length ? "ready" : "empty",
      competitionId,
      competitionName,
      canEdit: !parsed.readOnly,
      revision: parsed.revision,
      timezone: parsed.timezone,
      summary: parsed.effective,
      areas: parsed.areas,
    };
  } catch {
    return unavailable(competitionId, competitionName, "offline");
  }
}
