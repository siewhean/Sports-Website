import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { headers as requestHeaders } from "next/headers";

/*
 * Signed end-user IP forwarding for server-side API calls.
 *
 * Every BFF fetch reaches the API from the web server's own address, so
 * without this all spectators and scorers share one API rate-limit bucket.
 * We derive the browser's IP from the hop that is trustworthy in each
 * topology and send it upstream with an HMAC the API verifies
 * (apps/api/src/client-ip.ts; keep the format byte-identical):
 *
 *   x-matchday-client-ip:           <canonical IP>
 *   x-matchday-client-ip-signature: v1.<unix seconds>.<base64url HMAC-SHA256(secret,
 *                                   "matchday-client-ip:v1:<ip>:<unix seconds>")>
 *
 * Trust model (MATCHDAY_CLIENT_IP_SOURCE, auto-detected when unset):
 * - "vercel" (default when VERCEL=1): Vercel's edge overwrites x-real-ip and
 *   x-forwarded-for with the connecting client's address, so a browser cannot
 *   spoof them. We read x-real-ip, then the first x-forwarded-for entry.
 * - "proxy" (default elsewhere, e.g. OCI): exactly one reverse proxy we
 *   control (Caddy) sits in front of Next and is the only way to reach it.
 *   Caddy does not trust inbound X-Forwarded-For from the internet, so the
 *   right-most entry is always the address Caddy itself observed. Anything to
 *   its left may be browser-supplied and is ignored.
 * - "none": never forward (the API then falls back to its transport peer).
 *
 * Without MATCHDAY_CLIENT_IP_SECRET nothing is sent: an unsigned IP header is
 * ignored by the API anyway and must never be relied upon.
 */
export const CLIENT_IP_HEADER = "x-matchday-client-ip";
export const CLIENT_IP_SIGNATURE_HEADER = "x-matchday-client-ip-signature";

type Environment = Readonly<Record<string, string | undefined>>;
export type ClientIpSource = "vercel" | "proxy" | "none";

let warnedMissingSecret = false;

export function canonicalClientIp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (candidate.startsWith("[") && candidate.endsWith("]")) candidate = candidate.slice(1, -1);
  if (candidate.length === 0 || candidate.length > 45) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(candidate);
  if (mapped?.[1]) candidate = mapped[1];
  const family = isIP(candidate);
  if (family === 4) return candidate;
  if (family === 6) return candidate.toLowerCase();
  return null;
}

export function clientIpSource(env: Environment = process.env): ClientIpSource {
  const configured = env.MATCHDAY_CLIENT_IP_SOURCE?.trim().toLowerCase();
  if (configured === "vercel" || configured === "proxy" || configured === "none") return configured;
  return env.VERCEL === "1" ? "vercel" : "proxy";
}

/** Derives the end-user IP from the incoming request headers for the configured topology. */
export function resolveIncomingClientIp(incoming: Headers, env: Environment = process.env): string | null {
  const source = clientIpSource(env);
  if (source === "none") return null;
  if (source === "vercel") {
    const realIp = canonicalClientIp(incoming.get("x-real-ip"));
    if (realIp) return realIp;
    const forwarded = incoming.get("x-vercel-forwarded-for") ?? incoming.get("x-forwarded-for");
    return canonicalClientIp(forwarded?.split(",", 1)[0]);
  }
  const forwarded = incoming.get("x-forwarded-for");
  if (!forwarded) return null;
  const entries = forwarded.split(",");
  // Only the right-most hop was written by our ingress; never search leftwards
  // for a "valid" value, since everything to the left is client-controlled.
  return canonicalClientIp(entries[entries.length - 1]);
}

function configuredSecret(env: Environment): string | null {
  const secret = env.MATCHDAY_CLIENT_IP_SECRET?.trim();
  if (secret && Buffer.byteLength(secret, "utf8") >= 32) return secret;
  if (!warnedMissingSecret && env.NODE_ENV === "production") {
    warnedMissingSecret = true;
    console.warn(
      "MATCHDAY_CLIENT_IP_SECRET is unset or shorter than 32 bytes; API rate limits will treat all BFF traffic as one client.",
    );
  }
  return null;
}

export function signClientIp(ip: string, secret: string, nowMs = Date.now()): string {
  const timestamp = Math.floor(nowMs / 1_000);
  const mac = createHmac("sha256", secret)
    .update(`matchday-client-ip:v1:${ip}:${timestamp}`, "utf8")
    .digest("base64url");
  return `v1.${timestamp}.${mac}`;
}

/** Signed forwarding headers for an explicit incoming request (route handlers, tests). */
export function clientIpHeadersFor(
  incoming: Headers,
  env: Environment = process.env,
  nowMs = Date.now(),
): Record<string, string> {
  const secret = configuredSecret(env);
  if (!secret) return {};
  const ip = resolveIncomingClientIp(incoming, env);
  if (!ip) return {};
  return { [CLIENT_IP_HEADER]: ip, [CLIENT_IP_SIGNATURE_HEADER]: signClientIp(ip, secret, nowMs) };
}

/**
 * Signed forwarding headers for the current request, read via next/headers.
 * Safe to call from Server Components, Server Functions and Route Handlers;
 * returns {} outside a request scope (build, tests, background work).
 * Note: reading request headers opts the calling route into dynamic rendering.
 */
export async function clientIpForwardingHeaders(incoming?: Headers): Promise<Record<string, string>> {
  if (incoming) return clientIpHeadersFor(incoming);
  try {
    return clientIpHeadersFor(await requestHeaders());
  } catch {
    return {};
  }
}

function withHeaders(init: RequestInit | undefined, extra: Record<string, string>): RequestInit | undefined {
  const existing = init?.headers;
  const hasSpoofable =
    existing instanceof Headers
      ? existing.has(CLIENT_IP_HEADER) || existing.has(CLIENT_IP_SIGNATURE_HEADER)
      : Array.isArray(existing)
        ? existing.some(([name]) => [CLIENT_IP_HEADER, CLIENT_IP_SIGNATURE_HEADER].includes(name.toLowerCase()))
        : existing
          ? Object.keys(existing).some((name) =>
              [CLIENT_IP_HEADER, CLIENT_IP_SIGNATURE_HEADER].includes(name.toLowerCase()),
            )
          : false;
  if (Object.keys(extra).length === 0 && !hasSpoofable) return init;
  const merged = new Headers(existing);
  merged.delete(CLIENT_IP_HEADER);
  merged.delete(CLIENT_IP_SIGNATURE_HEADER);
  for (const [name, value] of Object.entries(extra)) merged.set(name, value);
  return { ...init, headers: merged };
}

/**
 * `fetch` for server-side calls to the Matchday API: identical to fetch, plus
 * the signed end-user IP of the request being served. Never forwards
 * caller-supplied x-matchday-client-ip* headers.
 */
export async function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, withHeaders(init, await clientIpForwardingHeaders()));
}
