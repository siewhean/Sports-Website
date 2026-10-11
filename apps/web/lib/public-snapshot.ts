import type { CompetitionView } from "@/lib/phase2";

/*
 * Cheap live-update path for public competition and match pages (client-safe; no server imports).
 *
 * GET /api/public/competitions/:slug/snapshot returns the exact CompetitionView the server page renders
 * (toCompetitionView over the canonical projection) plus the projection ETag. The response is CDN-cacheable for a
 * couple of seconds, so thousands of spectators polling or reacting to the live `versions` SSE stream collapse into
 * roughly one upstream API read per slug every ~2s instead of one full dynamic page render each.
 *
 * Typical use from a client component:
 *   const result = await fetchPublicSnapshot(slug, etagRef.current, { signal });
 *   if (result.status === "updated") { etagRef.current = result.etag; setCompetition(result.competition); }
 */

export const PUBLIC_SNAPSHOT_VERSION = 1;
export const PUBLIC_SNAPSHOT_CDN_MAX_AGE_SECONDS = 2;
export const PUBLIC_SNAPSHOT_STALE_WHILE_REVALIDATE_SECONDS = 10;

export type PublicSnapshotPayload = {
  version: typeof PUBLIC_SNAPSHOT_VERSION;
  etag: string;
  competition: CompetitionView;
};

export type PublicSnapshotResult =
  | { status: "updated"; etag: string; competition: CompetitionView }
  | { status: "not_modified"; etag: string }
  | { status: "not_found" }
  | { status: "unavailable"; httpStatus: number | null };

export function publicSnapshotPath(slug: string): string {
  return `/api/public/competitions/${encodeURIComponent(slug)}/snapshot`;
}

function quotedEtag(etag: string): string {
  return `"${etag.replaceAll('"', "")}"`;
}

function unquotedEtag(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^W\//u, "").replace(/^"|"$/gu, "") || null;
}

function isSnapshotPayload(value: unknown): value is PublicSnapshotPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const competition = record.competition as Record<string, unknown> | null | undefined;
  return (
    record.version === PUBLIC_SNAPSHOT_VERSION &&
    typeof record.etag === "string" &&
    !!competition &&
    typeof competition === "object" &&
    typeof competition.slug === "string" &&
    Array.isArray(competition.matches)
  );
}

/**
 * Fetches the public view model for `slug`. Pass the last ETag you applied to get `not_modified` cheaply (the CDN
 * answers the conditional request; an equal ETag in a full response is also reported as `not_modified`).
 * Never throws for HTTP or network failures; an aborted `signal` still rejects with AbortError.
 */
export async function fetchPublicSnapshot(
  slug: string,
  etag?: string | null,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<PublicSnapshotResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(publicSnapshotPath(slug), {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json", ...(etag ? { "if-none-match": quotedEtag(etag) } : {}) },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { status: "unavailable", httpStatus: null };
  }
  if (response.status === 304 && etag) return { status: "not_modified", etag };
  if (response.status === 404) return { status: "not_found" };
  if (!response.ok) return { status: "unavailable", httpStatus: response.status };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "unavailable", httpStatus: response.status };
  }
  if (!isSnapshotPayload(payload)) return { status: "unavailable", httpStatus: response.status };
  const current = unquotedEtag(response.headers.get("etag")) ?? payload.etag;
  if (etag && current === etag) return { status: "not_modified", etag };
  return { status: "updated", etag: payload.etag, competition: payload.competition };
}
