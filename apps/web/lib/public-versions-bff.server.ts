import "server-only";
import { configuredPublicOrigin } from "./phase3-origin";

function failure(status: number): Response {
  return Response.json(
    { message: "Live results are unavailable." },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

// Public versions contain publication identifiers only. Never proxy private
// routes or carry organiser cookies/credentials across this streaming boundary.
export async function forwardPublicVersionStream(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  if (request.method !== "GET") return failure(405);
  if (!/^\/api\/v1\/public\/competitions\/[^/]+\/versions$/u.test(incoming.pathname)) return failure(404);
  const backend = configuredPublicOrigin(
    process.env.RENDER_API_ORIGIN?.trim() || process.env.MATCHDAY_API_BASE_URL?.trim(),
  );
  if (!backend || backend === incoming.origin) return failure(503);
  try {
    const upstream = await fetch(new URL(incoming.pathname, backend), {
      headers: { accept: "text/event-stream" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]),
    });
    if (upstream.status !== 200) {
      await upstream.body?.cancel();
      return failure([401, 403, 404].includes(upstream.status) ? upstream.status : 502);
    }
    if (!upstream.body || !/^text\/event-stream(?:;|$)/iu.test(upstream.headers.get("content-type") ?? "")) {
      await upstream.body?.cancel();
      return failure(502);
    }
    return new Response(upstream.body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch {
    return failure(503);
  }
}
