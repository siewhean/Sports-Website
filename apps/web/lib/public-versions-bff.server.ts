import "server-only";
import { apiFetch } from "./client-ip.server";
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
  const upstreamAbort = new AbortController();
  let closeDownstream: (() => void) | undefined;
  const onAbort = () => {
    closeDownstream?.();
    // Next can abort with a generic destination-closed Error. Normalize that
    // expected downstream cancellation before it reaches the upstream reader.
    upstreamAbort.abort(new DOMException("Client disconnected", "AbortError"));
  };
  const cleanup = () => request.signal.removeEventListener("abort", onAbort);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  try {
    const upstream = await apiFetch(new URL(incoming.pathname, backend), {
      headers: { accept: "text/event-stream" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.any([upstreamAbort.signal, AbortSignal.timeout(35_000)]),
    });
    if (upstream.status !== 200) {
      cleanup();
      await upstream.body?.cancel();
      return failure([401, 403, 404].includes(upstream.status) ? upstream.status : 502);
    }
    if (!upstream.body || !/^text\/event-stream(?:;|$)/iu.test(upstream.headers.get("content-type") ?? "")) {
      cleanup();
      await upstream.body?.cancel();
      return failure(502);
    }
    const reader = upstream.body.getReader();
    let ended = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        closeDownstream = () => {
          if (ended) return;
          ended = true;
          cleanup();
          controller.close();
        };
        if (request.signal.aborted) onAbort();
      },
      async pull(controller) {
        try {
          const result = await reader.read();
          if (ended) return;
          if (result.done) closeDownstream?.();
          else controller.enqueue(result.value);
        } catch (error) {
          if (ended) return;
          ended = true;
          cleanup();
          // Only a real downstream abort is a normal close. Timeout, network
          // failure and malformed upstream streams remain observable errors.
          if (request.signal.aborted) controller.close();
          else controller.error(error);
        }
      },
      async cancel() {
        ended = true;
        cleanup();
        try {
          await reader.cancel();
        } finally {
          upstreamAbort.abort(new DOMException("Client disconnected", "AbortError"));
        }
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch {
    cleanup();
    return failure(503);
  }
}
