import "server-only";
import { isIP } from "node:net";

function unavailable(): Response {
  return Response.json(
    { message: "Casual games are temporarily unavailable. Please try again shortly." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export function extractTrustedClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim());
    // In Caddy -> web, Caddy appends the connecting client's IP to the end of X-Forwarded-For.
    // If a browser passes forged IPs, Caddy appends the real IP after them.
    // Traversing from right to left selects the authentic client IP appended by the trusted ingress proxy.
    for (let i = parts.length - 1; i >= 0; i--) {
      const candidate = parts[i];
      if (candidate && isIP(candidate)) {
        return candidate;
      }
    }
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp && isIP(realIp)) {
    return realIp;
  }
  return "127.0.0.1";
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
  const clientIp = extractTrustedClientIp(request);
  headers.set("x-forwarded-for", clientIp);
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
