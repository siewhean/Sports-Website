/**
 * PDPA-oriented scrubbing for Sentry events. Pure and dependency-free so it can
 * be unit tested without the SDK. Copy of
 * packages/observability/src/sentry-scrub.ts; keep the two in sync.
 */
const FILTERED = "[Filtered]";
const MAX_DEPTH = 12;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
const EMBEDDED_URL_PATTERN = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gu;
const OPAQUE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{32,}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SENSITIVE_KEY_PATTERN =
  /cookie|authorization|csrf|xsrf|scoring-session|scoring_session|session[-_]?(id|token)|token|secret|password|passwd|api[-_]?key|x-forwarded-for|x-real-ip|email|phone|mobile/iu;
const DROPPED_REQUEST_KEYS = ["cookies", "query_string", "data"] as const;

function redactPathSegments(value: string): string {
  return value
    .split("/")
    .map((segment) => (OPAQUE_SEGMENT_PATTERN.test(segment) && !UUID_PATTERN.test(segment) ? ":redacted" : segment))
    .join("/");
}

/** Removes query strings/fragments from URLs and masks email-like text. */
export function scrubSentryString(value: string): string {
  let result = value;
  if (/^(?:https?:\/\/|\/)/u.test(result)) {
    result = result.replace(/[?#].*$/su, "");
    result = redactPathSegments(result);
  } else {
    result = result.replace(EMBEDDED_URL_PATTERN, "$1");
  }
  return result.replace(EMAIL_PATTERN, "[email]");
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubSentryString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? FILTERED : scrubValue(item, depth + 1);
  }
  return output;
}

/**
 * Sentry `beforeSend` / `beforeSendTransaction` implementation. Returns null
 * (drops the event) if scrubbing itself fails, rather than risk leaking PII.
 */
export function scrubSentryEvent<T extends object>(event: T): T | null {
  try {
    const scrubbed = scrubValue(event, 0) as Record<string, unknown>;
    delete scrubbed.user;
    delete scrubbed.server_name;
    const request = scrubbed.request;
    if (request && typeof request === "object") {
      for (const key of DROPPED_REQUEST_KEYS) delete (request as Record<string, unknown>)[key];
    }
    return scrubbed as T;
  } catch {
    return null;
  }
}

/** Scrubs a breadcrumb; used for `beforeBreadcrumb`. */
export function scrubSentryBreadcrumb<T extends object>(breadcrumb: T): T {
  return (scrubValue(breadcrumb, 0) ?? breadcrumb) as T;
}
