import "server-only";

import { cookies, headers } from "next/headers";
import { SPORT_PACKS, type SportId, type SportPackOverride } from "@matchday/domain";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { cookieHostMatches } from "@/lib/phase2-organiser";
import {
  parseSportSettingsResponse,
  type SportSettingsContext,
  type SportSettingsDocument,
  type SportSettingsSurfaceState,
} from "@/lib/phase3-sport-settings";
import {
  parseSportPackAdminIndex,
  parseSportPackAdminRead,
  type SportDefaultsAdminDocument,
  type SportPackAdminState,
} from "@/lib/phase3-sport-pack-admin";

const previewStates = new Set<SportSettingsSurfaceState>([
  "ready",
  "loading",
  "empty",
  "error",
  "offline",
  "conflict",
  "read-only",
  "permission",
  "unavailable",
]);

function safePreviewState(value?: string): SportSettingsSurfaceState {
  if (!demoFixturesEnabled()) return "ready";
  return value && previewStates.has(value as SportSettingsSurfaceState)
    ? (value as SportSettingsSurfaceState)
    : "ready";
}

function safeAdminPreviewState(value?: string): SportPackAdminState {
  if (!demoFixturesEnabled()) return "ready";
  const states = new Set<SportPackAdminState>([
    "ready",
    "loading",
    "empty",
    "error",
    "offline",
    "conflict",
    "permission",
    "expired",
    "revoked",
  ]);
  return value && states.has(value as SportPackAdminState) ? (value as SportPackAdminState) : "ready";
}

async function adminAuthState(response: Response): Promise<SportPackAdminState> {
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const error = payload?.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : null;
  const code = typeof error?.code === "string" ? error.code : "";
  return code.includes("EXPIRED")
    ? "expired"
    : code.includes("REVOKED") || code.includes("INACTIVE")
      ? "revoked"
      : "permission";
}

function documentForState(context: SportSettingsContext, state: SportSettingsSurfaceState): SportSettingsDocument {
  const pack = SPORT_PACKS.canoe_polo;
  const override: SportPackOverride = state === "ready" && context.scope === "competition" ? { slotMinutes: 35 } : {};
  const recommended = { ...pack.recommendedSettings };
  return {
    state,
    context,
    sportId: pack.sportId,
    sportName: pack.displayName,
    packSchemaVersion: pack.schemaVersion,
    packVersion: pack.version,
    packStatus: pack.status,
    authority: pack.authority,
    definitions: pack.settingsSchema,
    recommended,
    effective: { ...recommended, ...override },
    override,
    mode: Object.keys(override).length ? "customised" : "recommended",
    revision: 4,
    definitionHash: "demo-canoe-polo-draft-1",
    packDefinition: pack,
    canEdit: state === "ready",
    capabilities: { save: false, saveDefault: false, copyPrevious: false },
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

async function sessionCookie(apiUrl: URL): Promise<string | null> {
  const requestHeaders = await headers();
  if (!cookieHostMatches(requestHeaders.get("host"), apiUrl.hostname)) return null;
  const store = await cookies();
  for (const name of ["__Host-matchday_session", "matchday_session"]) {
    const value = store.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

async function readSettings(context: SportSettingsContext): Promise<SportSettingsDocument> {
  const base = apiBaseUrl();
  if (!base) return documentForState(context, "error");
  const cookie = await sessionCookie(base);
  if (!cookie) return documentForState(context, "permission");
  try {
    const suffix = context.divisionId ? `/divisions/${encodeURIComponent(context.divisionId)}/settings` : "/settings";
    const response = await fetch(
      new URL(`/api/v1/competitions/${encodeURIComponent(context.competitionId)}${suffix}`, base),
      { cache: "no-store", headers: { accept: "application/json", cookie } },
    );
    if (response.status === 401 || response.status === 403) return documentForState(context, "permission");
    if (response.status === 404) return documentForState(context, "empty");
    if (!response.ok) return documentForState(context, "error");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return documentForState(context, "error");
    }
    return parseSportSettingsResponse(payload, context) ?? documentForState(context, "error");
  } catch {
    return documentForState(context, "offline");
  }
}

export async function getSportSettingsDocument(input: {
  competitionId: string;
  competitionName: string;
  divisionId?: string;
  divisionName?: string;
  previewState?: string;
}): Promise<SportSettingsDocument> {
  const context: SportSettingsContext = {
    scope: input.divisionId ? "division" : "competition",
    competitionId: input.competitionId,
    competitionName: input.competitionName,
    ...(input.divisionId ? { divisionId: input.divisionId } : {}),
    ...(input.divisionName ? { divisionName: input.divisionName } : {}),
  };
  const preview = safePreviewState(input.previewState);
  if (demoFixturesEnabled()) {
    if (context.scope === "division" && preview === "ready") return documentForState(context, "unavailable");
    return documentForState(context, preview);
  }
  return readSettings(context);
}

export async function getSportDefaultsAdminDocument(
  sportIdValue?: string,
  versionValue?: string,
  previewState?: string,
): Promise<SportDefaultsAdminDocument> {
  if (!sportIdValue || !(sportIdValue in SPORT_PACKS)) {
    return { state: "error", canManage: false, activeSportId: null, versions: [] };
  }
  const activeSportId = sportIdValue as SportId;
  if (demoFixturesEnabled()) {
    const state = safeAdminPreviewState(previewState);
    const createdAt = "2026-07-17T00:00:00.000Z";
    return {
      state,
      canManage: false,
      activeSportId,
      versions:
        state === "empty"
          ? []
          : Object.values(SPORT_PACKS).map((pack) => ({
              sportCode: pack.sportId,
              version: pack.version,
              schemaVersion: pack.schemaVersion,
              definition: pack,
              definitionHash: "a".repeat(64),
              status: "draft" as const,
              revision: 1,
              createdBy: null,
              createdAt,
              activatedBy: null,
              activatedAt: null,
              supersededAt: null,
              supersededBy: null,
              supersededByVersion: null,
              readOnly: true as const,
            })),
    };
  }
  const base = apiBaseUrl();
  if (!base) return { state: "error", canManage: false, activeSportId, versions: [] };
  const cookie = await sessionCookie(base);
  if (!cookie) return { state: "permission", canManage: false, activeSportId, versions: [] };
  try {
    const sportIds = Object.keys(SPORT_PACKS) as SportId[];
    const indexResponses = await Promise.all(
      sportIds.map((sportId) =>
        fetch(new URL(`/api/v1/admin/sport-packs/${encodeURIComponent(sportId)}`, base), {
          cache: "no-store",
          headers: { accept: "application/json", cookie },
        }),
      ),
    );
    const authFailure = indexResponses.find((response) => response.status === 401 || response.status === 403);
    if (authFailure) {
      return { state: await adminAuthState(authFailure), canManage: false, activeSportId, versions: [] };
    }
    if (indexResponses.some((response) => !response.ok))
      return { state: "error", canManage: false, activeSportId, versions: [] };
    const indexes = await Promise.all(
      indexResponses.map(async (response) => parseSportPackAdminIndex(await response.json().catch(() => null))),
    );
    if (indexes.some((index) => !index)) return { state: "error", canManage: false, activeSportId, versions: [] };
    const targets = indexes.flatMap((index) =>
      index!.versions.map((version) => ({ sportCode: index!.sportCode, summary: version })),
    );
    const detailResponses = await Promise.all(
      targets.map((target) =>
        fetch(
          new URL(
            `/api/v1/admin/sport-packs/${encodeURIComponent(target.sportCode)}/${encodeURIComponent(target.summary.version)}`,
            base,
          ),
          { cache: "no-store", headers: { accept: "application/json", cookie } },
        ),
      ),
    );
    const detailAuthFailure = detailResponses.find((response) => response.status === 401 || response.status === 403);
    if (detailAuthFailure)
      return { state: await adminAuthState(detailAuthFailure), canManage: false, activeSportId, versions: [] };
    if (detailResponses.some((response) => !response.ok))
      return { state: "error", canManage: false, activeSportId, versions: [] };
    const versions = await Promise.all(
      detailResponses.map(async (response) => parseSportPackAdminRead(await response.json().catch(() => null))),
    );
    if (
      versions.some((version, index) => {
        const target = targets[index];
        return (
          !version ||
          !target ||
          version.sportCode !== target.sportCode ||
          version.version !== target.summary.version ||
          version.schemaVersion !== target.summary.schemaVersion ||
          version.definitionHash !== target.summary.definitionHash ||
          version.status !== target.summary.status ||
          version.revision !== target.summary.revision ||
          version.createdAt !== target.summary.createdAt ||
          version.activatedAt !== target.summary.activatedAt ||
          version.supersededAt !== target.summary.supersededAt
        );
      })
    )
      return { state: "error", canManage: false, activeSportId, versions: [] };
    const requestedVersion = versionValue?.trim();
    const ordered = versions
      .filter((version): version is NonNullable<typeof version> => version !== null)
      .sort((left, right) => {
        if (left.sportCode === activeSportId && left.version === requestedVersion) return -1;
        if (right.sportCode === activeSportId && right.version === requestedVersion) return 1;
        if (left.sportCode === activeSportId && left.status === "active") return -1;
        if (right.sportCode === activeSportId && right.status === "active") return 1;
        return 0;
      });
    return { state: ordered.length ? "ready" : "empty", canManage: true, activeSportId, versions: ordered };
  } catch {
    return { state: "offline", canManage: false, activeSportId, versions: [] };
  }
}
