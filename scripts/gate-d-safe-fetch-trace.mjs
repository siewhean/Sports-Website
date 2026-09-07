/**
 * Control-plane diagnostic for a failed controlled-staging qualification.
 *
 * This module runs before the immutable candidate's QA-011 harness. It never
 * reads or emits request headers/bodies (which include scoring credentials),
 * and records response metadata only for rejected scoring mutations.
 */
const originalFetch = globalThis.fetch;
const expectedMatchBySessionId = new Map();

globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const request = args[0];
  const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;

  if (url.includes("/api/v1/scoring/access/exchange") && response.ok) {
    try {
      const requestBody = typeof args[1]?.body === "string" ? JSON.parse(args[1].body) : undefined;
      const responseBody = await response.clone().json();
      if (typeof requestBody?.expected_match_id === "string" && typeof responseBody?.session_id === "string") {
        expectedMatchBySessionId.set(responseBody.session_id, requestBody.expected_match_id);
      }
    } catch {
      // The immutable harness performs the authoritative access-contract check.
    }
  }

  if (!url.includes("/api/v1/scoring/events")) return response;

  let code = "non_json_error";
  let outcome = "unavailable";
  let aggregateVersionKind = "unavailable";
  let aggregateVersion = -1;
  let matchIdentity = "unavailable";
  try {
    const body = await response.clone().json();
    if (typeof body?.error?.code === "string") code = body.error.code;
    if (typeof body?.outcome === "string") outcome = body.outcome;
    aggregateVersionKind = typeof body?.aggregate_version;
    if (Number.isSafeInteger(body?.aggregate_version)) aggregateVersion = body.aggregate_version;
    const headers = args[1]?.headers;
    const sessionId =
      headers instanceof Headers
        ? headers.get("x-scoring-session-id")
        : typeof headers?.["x-scoring-session-id"] === "string"
          ? headers["x-scoring-session-id"]
          : undefined;
    if (typeof body?.match_id === "string" && sessionId) {
      matchIdentity = body.match_id === expectedMatchBySessionId.get(sessionId) ? "matched" : "mismatched";
    }
  } catch {
    // The response metadata remains sufficient when an intermediary sent HTML.
  }
  if (!response.ok || outcome !== "accepted" || aggregateVersion >= 31) {
    console.log(
      `[gate-d-control] scoring mutation: status=${response.status} outcome=${outcome} aggregate_version=${aggregateVersion} aggregate_version_type=${aggregateVersionKind} match_identity=${matchIdentity} code=${code}`,
    );
  }
  return response;
};
