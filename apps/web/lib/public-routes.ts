/*
 * Public (spectator) document routes: identical for every visitor, never render per-user data server-side.
 * Keep in sync with PUBLIC_DOCUMENT_PATTERNS in public/sw.js (covered by tests/unit/public-routes.test.ts).
 */
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const MATCH_ID = "[A-Za-z0-9_-]{1,128}";

export const PUBLIC_DOCUMENT_PATTERNS: readonly RegExp[] = [
  /^\/$/u,
  /^\/competitions\/?$/u,
  new RegExp(`^/competitions/${SLUG}/?$`, "u"),
  new RegExp(`^/competitions/${SLUG}/matches/${MATCH_ID}/?$`, "u"),
  /^\/(?:pricing|privacy|terms|cookies|support)\/?$/u,
];

export function isPublicDocumentPath(pathname: string): boolean {
  return PUBLIC_DOCUMENT_PATTERNS.some((pattern) => pattern.test(pathname));
}

/** Response header the proxy adds to public documents so the service worker can recognise them. */
export const PUBLIC_DOCUMENT_HEADER = "x-matchday-public-document";

/**
 * Request header the proxy always overwrites: "live" for RSC requests (router.refresh() after a live version
 * event, client navigations) so they bypass the public Data Cache; "cached" for document loads.
 */
export const PUBLIC_READ_FRESHNESS_HEADER = "x-matchday-public-read";
