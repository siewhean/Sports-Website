import type { PublicProjectionFreshness } from "@matchday/contracts";

export const gateCC4PublicCacheControl = "public, max-age=0, s-maxage=15, must-revalidate";

export type GateCC4PublicHeaders = Readonly<{
  etag: string;
  "last-modified": string;
  "cache-control": string;
  "x-matchday-schedule-version": string;
  "x-matchday-result-version": string;
  "x-matchday-projection-version": string;
}>;

function positiveVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function timestamp(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}

function quotedEtag(value: string): string {
  const trimmed = value.trim();
  if (/^(?:W\/)?"[^"\r\n]+"$/u.test(trimmed)) return trimmed;
  if (!/^[A-Za-z0-9._:-]{1,250}$/u.test(trimmed)) throw new Error("Public projection ETag is invalid");
  return `"${trimmed}"`;
}

export function gateCC4PublicHeaders(freshness: PublicProjectionFreshness): GateCC4PublicHeaders {
  nonNegativeVersion(freshness.schedule_version, "Schedule version");
  nonNegativeVersion(freshness.result_version, "Result version");
  positiveVersion(freshness.projection_version, "Projection version");
  const generatedAt = timestamp(freshness.generated_at, "Projection generation time");
  const sourceUpdatedAt = timestamp(freshness.source_updated_at, "Projection source update time");
  if (generatedAt.getTime() < sourceUpdatedAt.getTime()) {
    throw new Error("Public projection cannot be generated before its source update");
  }
  return {
    etag: quotedEtag(freshness.etag),
    "last-modified": sourceUpdatedAt.toUTCString(),
    "cache-control": gateCC4PublicCacheControl,
    "x-matchday-schedule-version": String(freshness.schedule_version),
    "x-matchday-result-version": String(freshness.result_version),
    "x-matchday-projection-version": String(freshness.projection_version),
  };
}

function etagMatches(headerValue: string, currentEtag: string): boolean {
  return headerValue
    .split(",")
    .map((value) => value.trim())
    .some((candidate) => candidate === "*" || candidate === currentEtag || candidate.replace(/^W\//u, "") === currentEtag.replace(/^W\//u, ""));
}

export function gateCC4PublicConditionalStatus(
  freshness: PublicProjectionFreshness,
  requestHeaders: Readonly<Record<string, string | string[] | undefined>>,
): 200 | 304 {
  const responseHeaders = gateCC4PublicHeaders(freshness);
  const lower = Object.fromEntries(Object.entries(requestHeaders).map(([key, value]) => [key.toLowerCase(), value]));
  const ifNoneMatch = lower["if-none-match"];
  if (typeof ifNoneMatch === "string" && etagMatches(ifNoneMatch, responseHeaders.etag)) return 304;
  if (Array.isArray(ifNoneMatch) && ifNoneMatch.some((value) => etagMatches(value, responseHeaders.etag))) return 304;

  // RFC conditional-request precedence: a present If-None-Match controls the
  // response even when it does not match. Only consult time when no ETag
  // condition was supplied.
  if (ifNoneMatch !== undefined) return 200;
  const ifModifiedSince = lower["if-modified-since"];
  const candidate = Array.isArray(ifModifiedSince) ? ifModifiedSince[0] : ifModifiedSince;
  if (!candidate) return 200;
  const since = new Date(candidate);
  if (!Number.isFinite(since.getTime())) return 200;
  const modified = new Date(responseHeaders["last-modified"]);
  return modified.getTime() <= since.getTime() ? 304 : 200;
}
