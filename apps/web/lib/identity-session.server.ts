import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";

const sessionCookieNames = ["__Host-matchday_session", "matchday_session"] as const;

export type CurrentIdentity = Readonly<{
  accountId: string;
  displayName: string;
}>;

export type CurrentIdentitySession =
  | Readonly<{ status: "authenticated"; identity: CurrentIdentity }>
  | Readonly<{ status: "step_up_required" }>
  | Readonly<{ status: "unauthenticated" }>;

function identityApiOrigin(): URL | null {
  const configured = (process.env.RENDER_API_ORIGIN ?? process.env.MATCHDAY_API_BASE_URL)?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseIdentity(payload: unknown): CurrentIdentity | null {
  if (!isRecord(payload) || !isRecord(payload.account)) return null;
  const { id, display_name: displayName } = payload.account;
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 128 ||
    typeof displayName !== "string" ||
    displayName.trim().length < 1 ||
    displayName.length > 100
  ) {
    return null;
  }
  return { accountId: id, displayName };
}

export const readCurrentIdentitySession = cache(async (): Promise<CurrentIdentitySession> => {
  const cookieStore = await cookies();
  const session = sessionCookieNames
    .map((name) => ({ name, value: cookieStore.get(name)?.value }))
    .find((candidate) => Boolean(candidate.value));
  if (!session?.value) return { status: "unauthenticated" };

  const apiOrigin = identityApiOrigin();
  if (!apiOrigin) return { status: "unauthenticated" };

  try {
    const response = await fetch(new URL("/api/v1/identity/me", apiOrigin), {
      cache: "no-store",
      headers: {
        accept: "application/json",
        cookie: `${session.name}=${encodeURIComponent(session.value)}`,
      },
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const identity = parseIdentity(payload);
      return identity ? { status: "authenticated", identity } : { status: "unauthenticated" };
    }
    if (
      response.status === 403 &&
      isRecord(payload) &&
      isRecord(payload.error) &&
      payload.error.code === "STEP_UP_REQUIRED"
    ) {
      return { status: "step_up_required" };
    }
    return { status: "unauthenticated" };
  } catch {
    return { status: "unauthenticated" };
  }
});
