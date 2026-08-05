import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { cookieHostMatches } from "./phase2-organiser";
import { requestOriginMatchesHost } from "./phase3-origin";

function apiBaseUrl(): URL | null {
  const configured = process.env.MATCHDAY_API_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function sessionCookie(request: NextRequest, apiUrl: URL): string | null {
  if (!cookieHostMatches(request.headers.get("host"), apiUrl.hostname)) return null;
  for (const name of ["__Host-matchday_session", "matchday_session"] as const) {
    const value = request.cookies.get(name)?.value;
    if (value && !/[\u0000-\u001f\u007f;]/u.test(value)) return `${name}=${value}`;
  }
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isoDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function csrfToken(value: unknown): string | null {
  if (!record(value) || !record(value.account)) return null;
  const keys = Object.keys(value).sort().join(",");
  const accountKeys = Object.keys(value.account).sort().join(",");
  if (
    keys !== "absolute_expires_at,account,csrf_token,idle_expires_at" ||
    accountKeys !== "display_name,email_verified_at,id,primary_email" ||
    typeof value.csrf_token !== "string" ||
    value.csrf_token.length < 16 ||
    !isoDate(value.idle_expires_at) ||
    !isoDate(value.absolute_expires_at)
  ) {
    return null;
  }
  return value.csrf_token;
}

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function safeDownloadName(value: string | null): string | null {
  if (!value) return null;
  const match = /^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]{0,180}\.pdf)"$/u.exec(value);
  return match?.[1] ?? null;
}

export async function forwardGateCC4BinaryMutation(request: NextRequest, path: string): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  const requestHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
  const requestProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || request.nextUrl.protocol;
  if (!requestOrigin || !requestOriginMatchesHost(requestOrigin, requestHost, requestProtocol)) {
    return error(403, "ORIGIN_REJECTED", "Request origin is not allowed");
  }
  const base = apiBaseUrl();
  if (!base) return error(503, "API_UNAVAILABLE", "The export service is unavailable");
  const cookie = sessionCookie(request, base);
  if (!cookie) return error(401, "AUTH_REQUIRED", "An authenticated session is required");

  try {
    const identityResponse = await fetch(new URL("/api/v1/identity/me", base), {
      cache: "no-store",
      headers: { accept: "application/json", cookie },
    });
    if (!identityResponse.ok) {
      return error(identityResponse.status === 403 ? 403 : 401, "AUTH_REQUIRED", "The session could not be verified");
    }
    const csrf = csrfToken(await identityResponse.json().catch(() => null));
    if (!csrf) return error(502, "IDENTITY_RESPONSE_INVALID", "The identity service returned an invalid response");

    const upstream = await fetch(new URL(path, base), {
      method: "POST",
      cache: "no-store",
      headers: {
        accept: "application/pdf",
        cookie,
        origin: requestOrigin,
        "x-csrf-token": csrf,
      },
    });
    if (!upstream.ok) {
      const payload: unknown = await upstream.json().catch(() => null);
      return record(payload) && record(payload.error)
        ? NextResponse.json(payload, { status: upstream.status })
        : error(upstream.status, "UPSTREAM_ERROR", "The export command failed");
    }
    if (upstream.headers.get("content-type")?.split(";")[0] !== "application/pdf") {
      return error(502, "EXPORT_RESPONSE_INVALID", "The export service returned an invalid content type");
    }
    const filename = safeDownloadName(upstream.headers.get("content-disposition"));
    const contentSha256 = upstream.headers.get("x-matchday-content-sha256");
    const sourceFingerprint = upstream.headers.get("x-matchday-source-fingerprint");
    if (
      !filename ||
      !contentSha256 ||
      !/^[a-f0-9]{64}$/u.test(contentSha256) ||
      !sourceFingerprint ||
      !/^[a-f0-9]{64}$/u.test(sourceFingerprint)
    ) {
      return error(502, "EXPORT_RESPONSE_INVALID", "The export service returned incomplete integrity metadata");
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "x-content-type-options": "nosniff",
        "x-matchday-content-sha256": contentSha256,
        "x-matchday-source-fingerprint": sourceFingerprint,
        "x-matchday-schedule-version": upstream.headers.get("x-matchday-schedule-version") ?? "",
        "x-matchday-result-version": upstream.headers.get("x-matchday-result-version") ?? "",
        "x-matchday-export-manifest-id": upstream.headers.get("x-matchday-export-manifest-id") ?? "",
        "x-matchday-idempotent-replay": upstream.headers.get("x-matchday-idempotent-replay") ?? "false",
      },
    });
  } catch {
    return error(503, "API_UNAVAILABLE", "The export service is unavailable");
  }
}
