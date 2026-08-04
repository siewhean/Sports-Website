import type { C5WorkloadExecutor } from "@matchday/observability";

function validEtag(value: string | null): value is string {
  return value !== null && value.length > 2 && value.length <= 512;
}

function validLastModified(value: string | null): boolean {
  return value !== null && Number.isFinite(Date.parse(value));
}

/**
 * Exercises the canonical unauthenticated public-truth surface only. Each
 * sample requires an authoritative 200 read followed by an ETag-bound 304;
 * response bodies are deliberately discarded.
 */
export function createGateCC5PublicCurrentExecutor(
  input: Readonly<{ apiOrigin: string; slug: string }>,
): C5WorkloadExecutor {
  const endpoint = new URL(`/api/v1/public/competitions/${encodeURIComponent(input.slug)}/current`, input.apiOrigin);
  return async (invocation) => {
    const initial = await fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: invocation.signal,
    });
    const etag = initial.headers.get("etag");
    const lastModified = initial.headers.get("last-modified");
    const cacheControl = initial.headers.get("cache-control");
    if (
      initial.status !== 200 ||
      !validEtag(etag) ||
      !validLastModified(lastModified) ||
      cacheControl === null ||
      !cacheControl.includes("public")
    ) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `public_current_initial_http_${String(initial.status)}` },
      };
    }
    // Drain the payload before the conditional read so the measured request
    // exercises the same response lifecycle as a browser/public client.
    await initial.arrayBuffer();
    const conditional = await fetch(endpoint, {
      headers: { "if-none-match": etag },
      signal: invocation.signal,
    });
    if (
      conditional.status !== 304 ||
      conditional.headers.get("etag") !== etag ||
      conditional.headers.get("last-modified") !== lastModified
    ) {
      return {
        outcome: "unexpected_failure",
        correctness: { passed: false, failureCode: `public_current_conditional_http_${String(conditional.status)}` },
      };
    }
    return { outcome: "success", correctness: { passed: true } };
  };
}
