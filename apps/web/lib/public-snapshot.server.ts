import "server-only";
import { isPublicCompetitionSlug, PublicDataUnavailableError, readPublicSnapshot } from "@/lib/phase2-public.server";
import {
  PUBLIC_SNAPSHOT_CDN_MAX_AGE_SECONDS,
  PUBLIC_SNAPSHOT_STALE_WHILE_REVALIDATE_SECONDS,
  PUBLIC_SNAPSHOT_VERSION,
  type PublicSnapshotPayload,
} from "@/lib/public-snapshot";

export const SHARED_CACHE_CONTROL = `public, max-age=0, s-maxage=${PUBLIC_SNAPSHOT_CDN_MAX_AGE_SECONDS}, stale-while-revalidate=${PUBLIC_SNAPSHOT_STALE_WHILE_REVALIDATE_SECONDS}`;
// A missing competition is cached briefly so typo'd or retired QR links cannot hammer the API.
const NOT_FOUND_CACHE_CONTROL = "public, max-age=0, s-maxage=10";

const baseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
} as const;

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, ...headers } });
}

/*
 * Always answers 200 with the full body (never a function-level 304): the CDN must be able to store a complete
 * representation, and it answers conditional If-None-Match requests from that stored copy itself.
 */
export async function publicSnapshotResponse(slug: string): Promise<Response> {
  if (!isPublicCompetitionSlug(slug))
    return json({ code: "not_found" }, 404, { "cache-control": NOT_FOUND_CACHE_CONTROL });
  try {
    const snapshot = await readPublicSnapshot(slug);
    if (snapshot.status === "not_found") {
      return json({ code: "not_found" }, 404, { "cache-control": NOT_FOUND_CACHE_CONTROL });
    }
    // ETag values must be visible ASCII without quotes (RFC 9110 etagc); body and header carry the same value.
    const etag = snapshot.etag.replace(/[^\x21\x23-\x7e]/gu, "-") || "0";
    const payload: PublicSnapshotPayload = {
      version: PUBLIC_SNAPSHOT_VERSION,
      etag,
      competition: snapshot.competition,
    };
    return json(payload, 200, { "cache-control": SHARED_CACHE_CONTROL, etag: `"${etag}"` });
  } catch (error) {
    const upstreamStatus = error instanceof PublicDataUnavailableError ? error.status : null;
    console.error("MATCHDAY public snapshot unavailable", { slug, upstreamStatus });
    return json({ code: "unavailable" }, 503, { "cache-control": "no-store", "retry-after": "5" });
  }
}
