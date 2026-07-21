import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { cookieHostMatches } from "@/lib/phase2-organiser";
import { requestOriginMatchesHost } from "@/lib/phase3-origin";

type Validator = (value: unknown) => boolean;

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

function sessionCookie(request: NextRequest, apiUrl: URL): string | null {
  if (!cookieHostMatches(request.headers.get("host"), apiUrl.hostname)) return null;
  for (const name of ["__Host-matchday_session", "matchday_session"]) {
    const value = request.cookies.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/.test(value)) return `${name}=${value}`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function csrfTokenFromSession(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.account)) return null;
  const accountKeys = Object.keys(value.account).sort().join(",");
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !== "absolute_expires_at,account,csrf_token,idle_expires_at" ||
    accountKeys !== "display_name,email_verified_at,id,primary_email" ||
    typeof value.account.id !== "string" ||
    typeof value.account.primary_email !== "string" ||
    typeof value.account.display_name !== "string" ||
    (value.account.email_verified_at !== null && !isIsoDate(value.account.email_verified_at)) ||
    typeof value.csrf_token !== "string" ||
    value.csrf_token.length < 16 ||
    !isIsoDate(value.idle_expires_at) ||
    !isIsoDate(value.absolute_expires_at)
  )
    return null;
  return value.csrf_token;
}

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function jsonBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export async function forwardPhase3Mutation(
  request: NextRequest,
  input: { method: "PUT" | "POST" | "DELETE"; path: string; body?: Record<string, unknown>; validate: Validator },
) {
  const requestOrigin = request.headers.get("origin");
  const requestHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
  const requestProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || request.nextUrl.protocol;
  if (!requestOriginMatchesHost(requestOrigin, requestHost, requestProtocol))
    return error(403, "ORIGIN_REJECTED", "Request origin is not allowed");
  const base = apiBaseUrl();
  if (!base) return error(503, "API_UNAVAILABLE", "The settings service is unavailable");
  const cookie = sessionCookie(request, base);
  if (!cookie) return error(401, "AUTH_REQUIRED", "An authenticated session is required");
  try {
    const identityResponse = await fetch(new URL("/api/v1/identity/me", base), {
      cache: "no-store",
      headers: { accept: "application/json", cookie },
    });
    if (!identityResponse.ok)
      return error(identityResponse.status === 403 ? 403 : 401, "AUTH_REQUIRED", "The session could not be verified");
    const csrf = csrfTokenFromSession(await identityResponse.json().catch(() => null));
    if (!csrf) return error(502, "IDENTITY_RESPONSE_INVALID", "The identity service returned an invalid response");
    const response = await fetch(new URL(input.path, base), {
      method: input.method,
      cache: "no-store",
      headers: {
        accept: "application/json",
        cookie,
        origin: request.nextUrl.origin,
        "x-csrf-token": csrf,
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (
        isRecord(payload) &&
        isRecord(payload.error) &&
        typeof payload.error.code === "string" &&
        typeof payload.error.message === "string"
      ) {
        return NextResponse.json(payload, { status: response.status });
      }
      return error(response.status, "UPSTREAM_ERROR", "The settings command failed");
    }
    if (!input.validate(payload))
      return error(502, "COMMAND_RESPONSE_INVALID", "The settings service returned an invalid response");
    return NextResponse.json(payload);
  } catch {
    return error(503, "API_UNAVAILABLE", "The settings service is unavailable");
  }
}

export function isSettingsMutationResponse(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["competition_id", "division_id", "revision"])) return false;
  return (
    typeof value.competition_id === "string" &&
    (value.division_id === null || typeof value.division_id === "string") &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 1
  );
}

export function isCopyResponse(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["competition_id", "revision"]) &&
    typeof value.competition_id === "string" &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 1
  );
}

export function isDefaultResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = ["account_id", "sport_code", "source_pack_version", "settings", "updated_at"];
  return (
    hasExactKeys(value, allowed) &&
    typeof value.account_id === "string" &&
    typeof value.sport_code === "string" &&
    typeof value.source_pack_version === "string" &&
    isRecord(value.settings) &&
    isIsoDate(value.updated_at)
  );
}
