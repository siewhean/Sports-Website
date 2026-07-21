import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { cookieHostMatches } from "@/lib/phase2-organiser";

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

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function forwardScheduleRead(request: NextRequest, path: string, validate: Validator) {
  const base = apiBaseUrl();
  if (!base) return error(503, "API_UNAVAILABLE", "The schedule service is unavailable");
  const cookie = sessionCookie(request, base);
  if (!cookie) return error(401, "AUTH_REQUIRED", "An authenticated session is required");
  try {
    const response = await fetch(new URL(path, base), {
      cache: "no-store",
      headers: { accept: "application/json", cookie },
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (isUpstreamError(payload)) return NextResponse.json(payload, { status: response.status });
      return error(response.status, "UPSTREAM_ERROR", "The schedule read failed");
    }
    if (!validate(payload)) return error(502, "SCHEDULE_RESPONSE_INVALID", "The schedule service returned an invalid response");
    return NextResponse.json(payload);
  } catch {
    return error(503, "API_UNAVAILABLE", "The schedule service is unavailable");
  }
}

function isUpstreamError(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (!payload.error || typeof payload.error !== "object" || Array.isArray(payload.error)) return false;
  const upstream = payload.error as Record<string, unknown>;
  return typeof upstream.code === "string" && typeof upstream.message === "string";
}
