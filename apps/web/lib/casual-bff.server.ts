import "server-only";

function unavailable(): Response {
  return Response.json(
    { message: "Casual games are temporarily unavailable. Please try again shortly." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export async function forwardCasualRequest(request: Request): Promise<Response> {
  const configured = process.env.RENDER_API_ORIGIN?.trim() || process.env.MATCHDAY_API_BASE_URL?.trim();
  if (!configured) return unavailable();
  let backend: URL;
  try {
    backend = new URL(configured);
    if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password) return unavailable();
  } catch {
    return unavailable();
  }
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith("/api/v1/casual/"))
    return Response.json({ message: "Not found." }, { status: 404 });
  const target = new URL(incoming.pathname + incoming.search, backend);
  if (target.origin === incoming.origin) return unavailable();
  const headers = new Headers({ accept: "application/json" });
  for (const name of [
    "content-type",
    "cookie",
    "origin",
    "x-csrf-token",
    "x-casual-host-token",
    "x-casual-viewer-token",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      ...(request.method === "POST" ? { body: await request.text() } : {}),
    });
    // A missing backend route must not look like a missing web page to the host.
    if (upstream.status === 404 && request.method === "POST" && incoming.pathname === "/api/v1/casual/games")
      return unavailable();
    if (!upstream.headers.get("content-type")?.includes("application/json")) return unavailable();
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "private, no-store" },
    });
  } catch {
    return unavailable();
  }
}
