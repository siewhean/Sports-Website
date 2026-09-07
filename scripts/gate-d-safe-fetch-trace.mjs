/**
 * Control-plane diagnostic for a failed controlled-staging qualification.
 *
 * This module runs before the immutable candidate's QA-011 harness. It never
 * reads or emits request headers/bodies (which include scoring credentials),
 * and records response metadata only for rejected scoring mutations.
 */
const originalFetch = globalThis.fetch;

globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const request = args[0];
  const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;

  if (!url.includes("/api/v1/scoring/events") || response.ok) return response;

  let code = "non_json_error";
  try {
    const body = await response.clone().json();
    if (typeof body?.error?.code === "string") code = body.error.code;
  } catch {
    // The response metadata remains sufficient when an intermediary sent HTML.
  }
  console.log(`[gate-d-control] rejected scoring mutation: status=${response.status} code=${code}`);
  return response;
};
