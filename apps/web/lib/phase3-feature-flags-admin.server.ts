import "server-only";

import { cookies, headers } from "next/headers";
import { featureFlags } from "@matchday/feature-flags";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { requestCanForwardSessionCookie } from "@/lib/phase3-origin";
import {
  parseFeatureFlagAudit,
  parseFeatureFlagList,
  parseFeatureFlagSummary,
  type FeatureFlagAdminDocument,
  type FeatureFlagAdminState,
  type FeatureFlagAuditEvent,
  type FeatureFlagSummary,
} from "@/lib/phase3-feature-flags-admin";

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
  if (!requestCanForwardSessionCookie(requestHeaders, apiUrl.hostname, process.env.MATCHDAY_PUBLIC_ORIGIN)) {
    return null;
  }
  const store = await cookies();
  for (const name of ["__Host-matchday_session", "matchday_session"]) {
    const value = store.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

async function adminAuthState(response: Response): Promise<FeatureFlagAdminState> {
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const error = payload?.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : null;
  const code = typeof error?.code === "string" ? error.code : "";
  return code.includes("EXPIRED")
    ? "expired"
    : code.includes("REVOKED") || code.includes("INACTIVE")
      ? "revoked"
      : "permission";
}

function demoDocument(activeKey?: string): FeatureFlagAdminDocument {
  const demoFlags: FeatureFlagSummary[] = Object.entries(featureFlags).map(([key, def]) => ({
    key,
    description: def.description,
    defaultValue: def.defaultValue,
    valueType: typeof def.defaultValue,
    overridesCount: 0,
    overrides: [],
  }));
  const activeFlagKey = activeKey && activeKey in featureFlags ? activeKey : (demoFlags[0]?.key ?? null);
  const activeFlagDetail = demoFlags.find((f) => f.key === activeFlagKey) ?? null;
  return {
    state: "ready",
    canManage: true,
    flags: demoFlags,
    activeFlagKey,
    activeFlagDetail,
    auditEvents: [],
  };
}

export async function getFeatureFlagsAdminDocument(
  flagKeyValue?: string,
  previewState?: string,
): Promise<FeatureFlagAdminDocument> {
  if (demoFixturesEnabled()) {
    if (previewState && ["error", "offline", "permission", "empty"].includes(previewState)) {
      return {
        state: previewState as FeatureFlagAdminState,
        canManage: false,
        flags: [],
        activeFlagKey: null,
      };
    }
    return demoDocument(flagKeyValue);
  }

  const base = apiBaseUrl();
  if (!base) {
    return { state: "error", canManage: false, flags: [], activeFlagKey: null };
  }
  const cookie = await sessionCookie(base);
  if (!cookie) {
    return { state: "permission", canManage: false, flags: [], activeFlagKey: null };
  }

  try {
    const listResponse = await fetch(new URL("/api/v1/admin/feature-flags", base), {
      cache: "no-store",
      headers: { accept: "application/json", cookie },
    });

    if (listResponse.status === 401 || listResponse.status === 403) {
      return {
        state: await adminAuthState(listResponse),
        canManage: false,
        flags: [],
        activeFlagKey: null,
      };
    }
    if (!listResponse.ok) {
      return { state: "error", canManage: false, flags: [], activeFlagKey: null };
    }

    const listPayload = await listResponse.json().catch(() => null);
    const flags = parseFeatureFlagList(listPayload);
    if (!flags) {
      return { state: "error", canManage: false, flags: [], activeFlagKey: null };
    }

    const activeFlagKey =
      flagKeyValue && flags.some((f) => f.key === flagKeyValue) ? flagKeyValue : (flags[0]?.key ?? null);

    let activeFlagDetail: FeatureFlagSummary | null = null;
    let auditEvents: readonly FeatureFlagAuditEvent[] = [];

    if (activeFlagKey) {
      const [detailResponse, auditResponse] = await Promise.all([
        fetch(new URL(`/api/v1/admin/feature-flags/${encodeURIComponent(activeFlagKey)}`, base), {
          cache: "no-store",
          headers: { accept: "application/json", cookie },
        }),
        fetch(new URL(`/api/v1/admin/feature-flags/${encodeURIComponent(activeFlagKey)}/audit`, base), {
          cache: "no-store",
          headers: { accept: "application/json", cookie },
        }),
      ]);

      if (detailResponse.ok) {
        const detailPayload = await detailResponse.json().catch(() => null);
        activeFlagDetail = parseFeatureFlagSummary(detailPayload);
      }
      if (auditResponse.ok) {
        const auditPayload = await auditResponse.json().catch(() => null);
        auditEvents = parseFeatureFlagAudit(auditPayload) ?? [];
      }
    }

    return {
      state: flags.length > 0 ? "ready" : "empty",
      canManage: true,
      flags,
      activeFlagKey,
      activeFlagDetail,
      auditEvents,
    };
  } catch {
    return { state: "offline", canManage: false, flags: [], activeFlagKey: null };
  }
}
