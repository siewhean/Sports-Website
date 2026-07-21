import "server-only";

import { cookies, headers } from "next/headers";
import { cookieHostMatches } from "@/lib/phase2-organiser";
import {
  parseStandingsSnapshot,
  type ResultsDocument,
  type ResultsSurfaceState,
  type StandingsGroup,
  type StandingsRow,
} from "@/lib/phase3-results";

const previewStates = new Set<ResultsSurfaceState>([
  "ready",
  "loading",
  "empty",
  "error",
  "offline",
  "permission",
  "read-only",
]);

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

async function requestContext(apiUrl: URL): Promise<{ cookie: string; origin: string } | null> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() || requestHeaders.get("host");
  if (!host || !cookieHostMatches(host, apiUrl.hostname) || /[\u0000-\u001f\u007f/\\]/.test(host)) return null;
  const forwarded = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwarded === "https" ? "https" : "http";
  const store = await cookies();
  for (const name of ["__Host-matchday_session", "matchday_session"] as const) {
    const value = store.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value))
      return { cookie: `${name}=${value}`, origin: `${protocol}://${host}` };
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function csrfToken(value: unknown): string | null {
  const payload = record(value);
  return payload && typeof payload.csrf_token === "string" && payload.csrf_token.length >= 16
    ? payload.csrf_token
    : null;
}

function unavailable(
  input: ResultsInput,
  state: ResultsSurfaceState,
  snapshot: ResultsDocument["snapshot"] = null,
): ResultsDocument {
  return {
    state,
    competitionId: input.competitionId,
    competitionName: input.competitionName,
    divisionId: input.divisionId,
    divisionName: input.divisionName,
    timeZone: input.timeZone,
    canRecalculate: false,
    currentResultVersion: input.currentResultVersion,
    snapshot,
    advancement: { status: "not-returned", slots: [], changes: [], conflicts: [] },
  };
}

function demoRow(
  entryId: string,
  entryName: string,
  rank: number,
  played: number,
  won: number,
  drawn: number,
  scoreFor: number,
  scoreAgainst: number,
  points: number,
  resolvedBy: StandingsRow["resolvedBy"],
): StandingsRow {
  return {
    rank,
    displayOrder: rank,
    entryId,
    entryName,
    seed: rank,
    status: "active",
    eligibleForAdvancement: true,
    played,
    won,
    drawn,
    lost: played - won - drawn,
    tablePoints: points,
    scoreFor,
    scoreAgainst,
    scoreDifference: scoreFor - scoreAgainst,
    segmentsWon: 0,
    segmentsLost: 0,
    disciplinePoints: rank === 1 ? 1 : 0,
    sportingTie: false,
    resolvedBy,
    explanations: [
      {
        criterion: resolvedBy === "head_to_head" ? "head_to_head" : "table_points",
        value: resolvedBy === "head_to_head" ? "won direct meeting" : points,
        comparedWithinEntryIds: [],
        summary:
          resolvedBy === "head_to_head"
            ? "The direct meeting separated otherwise level teams."
            : `${points} table points from ${played} final matches.`,
      },
    ],
  };
}

function demoGroup(input: ResultsInput, groupId: string, rows: readonly StandingsRow[]): StandingsGroup {
  return {
    snapshotId: `standings-6-${groupId}`,
    competitionId: input.competitionId,
    divisionId: input.divisionId,
    groupId,
    resultVersion: 6,
    configVersion: "canoe-polo-standings-v1",
    calculatedAt: "2026-08-16T05:42:18.000Z",
    fingerprint: `8fd37a19d6b4${groupId === "group-a" ? "a101" : "b202"}`,
    rows,
  };
}

function demoDocument(input: ResultsInput, state: ResultsSurfaceState): ResultsDocument {
  if (state !== "ready" && state !== "read-only") return unavailable(input, state);
  const groups = {
    "group-a": demoGroup(input, "group-a", [
      demoRow("entry-pasir-ris", "Pasir Ris Rapids", 1, 3, 3, 0, 14, 6, 9, "table_points"),
      demoRow("entry-marina", "Marina Barracudas", 2, 3, 2, 0, 11, 8, 6, "score_difference"),
      demoRow("entry-punggol", "Punggol Current", 3, 3, 1, 0, 7, 12, 3, "score_difference"),
      demoRow("entry-telok", "Telok Ayer Tide", 4, 3, 0, 0, 4, 10, 0, "table_points"),
    ]),
    "group-b": demoGroup(input, "group-b", [
      demoRow("entry-kallang", "Kallang Breakers", 1, 3, 2, 1, 12, 7, 7, "table_points"),
      demoRow("entry-seletar", "Seletar Paddlers", 2, 3, 2, 1, 10, 7, 7, "head_to_head"),
      demoRow("entry-bedok", "Bedok Undertow", 3, 3, 1, 0, 8, 11, 3, "score_difference"),
      demoRow("entry-jurong", "Jurong Wake", 4, 3, 0, 0, 3, 8, 0, "table_points"),
    ]),
  };
  return {
    state,
    competitionId: input.competitionId,
    competitionName: input.competitionName,
    divisionId: input.divisionId,
    divisionName: input.divisionName,
    timeZone: input.timeZone,
    canRecalculate: state === "ready",
    currentResultVersion: Math.max(input.currentResultVersion, 6),
    snapshot: {
      id: "10000000-0000-4000-8000-000000000106",
      competitionId: input.competitionId,
      divisionId: input.divisionId,
      resultVersion: 6,
      groups,
      crossGroup: [
        {
          rank: 1,
          displayOrder: 1,
          groupId: "group-a",
          entryId: "entry-pasir-ris",
          provisional: false,
          resolved: true,
          explanations: [{ criterion: "table_points_per_match", value: "3/1" }],
        },
        {
          rank: 2,
          displayOrder: 2,
          groupId: "group-b",
          entryId: "entry-kallang",
          provisional: false,
          resolved: true,
          explanations: [{ criterion: "table_points_per_match", value: "7/3" }],
        },
      ],
      configVersion: "canoe-polo-standings-v1",
      groupCount: 2,
      sourceResultHash: "39bc004d57bd20df53b4ac4ec1111d27944fd3f329cd65928bd875614decaf12",
      settingsVersion: "canoe-polo-standings-v1",
      snapshotFingerprint: "c9184b3f6bc6ab82",
      createdAt: "2026-08-16T05:42:18.000Z",
      advancementSlots: [
        {
          matchId: "20000000-0000-4000-8000-000000000016",
          slot: "home",
          entryId: "entry-pasir-ris",
          control: "automatic",
          controlledByRuleId: "semi-final-1:home:group-a:1",
          sourceSnapshotId: "10000000-0000-4000-8000-000000000106",
          sourceFingerprint: "8fd37a19d6b4a101",
          resultVersion: 6,
          updatedAt: "2026-08-16T05:42:18.000Z",
        },
        {
          matchId: "20000000-0000-4000-8000-000000000016",
          slot: "away",
          entryId: "entry-seletar",
          control: "manual",
          controlledByRuleId: null,
          sourceSnapshotId: null,
          sourceFingerprint: null,
          resultVersion: 6,
          updatedAt: "2026-08-16T05:43:02.000Z",
        },
      ],
      advancementConflicts: [
        {
          id: "30000000-0000-4000-8000-000000000016",
          ruleId: "semi-final-1:away:group-b:1",
          targetSlotId: "20000000-0000-4000-8000-000000000016:away",
          reason: "target_slot_not_controlled_by_rule",
          status: "open",
          resultVersion: 6,
          createdAt: "2026-08-16T05:43:02.000Z",
        },
      ],
    },
    advancement: {
      status: "persisted",
      slots: [
        {
          matchId: "20000000-0000-4000-8000-000000000016",
          slot: "home",
          entryId: "entry-pasir-ris",
          control: "automatic",
          controlledByRuleId: "semi-final-1:home:group-a:1",
          sourceSnapshotId: "10000000-0000-4000-8000-000000000106",
          sourceFingerprint: "8fd37a19d6b4a101",
          resultVersion: 6,
          updatedAt: "2026-08-16T05:42:18.000Z",
        },
        {
          matchId: "20000000-0000-4000-8000-000000000016",
          slot: "away",
          entryId: "entry-seletar",
          control: "manual",
          controlledByRuleId: null,
          sourceSnapshotId: null,
          sourceFingerprint: null,
          resultVersion: 6,
          updatedAt: "2026-08-16T05:43:02.000Z",
        },
      ],
      changes: [],
      conflicts: [
        {
          id: "30000000-0000-4000-8000-000000000016",
          ruleId: "semi-final-1:away:group-b:1",
          targetSlotId: "20000000-0000-4000-8000-000000000016:away",
          reason: "target_slot_not_controlled_by_rule",
          status: "open",
          resultVersion: 6,
          createdAt: "2026-08-16T05:43:02.000Z",
        },
      ],
    },
  };
}

type ResultsInput = Readonly<{
  competitionId: string;
  competitionName: string;
  divisionId: string;
  divisionName: string;
  timeZone: string;
  currentResultVersion: number;
  previewState?: string;
}>;

export async function getResultsDocument(input: ResultsInput): Promise<ResultsDocument> {
  if (process.env.MATCHDAY_PHASE2_DATA_MODE === "demo") {
    const state =
      input.previewState && previewStates.has(input.previewState as ResultsSurfaceState)
        ? (input.previewState as ResultsSurfaceState)
        : "ready";
    return demoDocument(input, state);
  }
  const base = apiBaseUrl();
  if (!base) return unavailable(input, "error");
  const context = await requestContext(base);
  if (!context) return unavailable(input, "permission");
  try {
    const identity = await fetch(new URL("/api/v1/identity/me", base), {
      cache: "no-store",
      headers: { accept: "application/json", cookie: context.cookie },
    });
    if (identity.status === 401 || identity.status === 403) return unavailable(input, "permission");
    if (!identity.ok) return unavailable(input, "error");
    const csrf = csrfToken(await identity.json().catch(() => null));
    if (!csrf) return unavailable(input, "error");
    const [standingsResponse, settingsResponse] = await Promise.all([
      fetch(
        new URL(
          `/api/v1/competitions/${encodeURIComponent(input.competitionId)}/divisions/${encodeURIComponent(input.divisionId)}/standings`,
          base,
        ),
        {
          cache: "no-store",
          headers: {
            accept: "application/json",
            cookie: context.cookie,
            origin: context.origin,
            "x-csrf-token": csrf,
          },
        },
      ),
      fetch(new URL(`/api/v1/competitions/${encodeURIComponent(input.competitionId)}/settings`, base), {
        cache: "no-store",
        headers: { accept: "application/json", cookie: context.cookie },
      }),
    ]);
    if ([standingsResponse.status, settingsResponse.status].some((status) => status === 401 || status === 403))
      return unavailable(input, "permission");
    if (standingsResponse.status === 404) return unavailable(input, "empty");
    if (!standingsResponse.ok || !settingsResponse.ok) return unavailable(input, "error");
    const [standingsPayload, settingsPayload] = await Promise.all([
      standingsResponse.json().catch(() => null) as Promise<unknown>,
      settingsResponse.json().catch(() => null) as Promise<unknown>,
    ]);
    const snapshot = parseStandingsSnapshot(standingsPayload, input.competitionId, input.divisionId);
    const permission = record(settingsPayload)?.permission;
    if (!snapshot || (permission !== "read" && permission !== "write")) return unavailable(input, "error");
    return {
      state: permission === "write" ? "ready" : "read-only",
      competitionId: input.competitionId,
      competitionName: input.competitionName,
      divisionId: input.divisionId,
      divisionName: input.divisionName,
      timeZone: input.timeZone,
      canRecalculate: permission === "write",
      currentResultVersion: input.currentResultVersion,
      snapshot,
      advancement: {
        status: "persisted",
        slots: snapshot.advancementSlots,
        changes: [],
        conflicts: snapshot.advancementConflicts,
      },
    };
  } catch {
    return unavailable(input, "offline");
  }
}
