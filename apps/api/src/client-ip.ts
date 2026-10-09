import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

/*
 * Signed end-user IP forwarding from the web BFF.
 *
 * Every server-side BFF fetch reaches this API from one network peer (the web
 * container on OCI, a Vercel egress IP on previews), so `request.ip` alone puts
 * every spectator and scorer into one rate-limit bucket. The BFF therefore
 * derives the browser's IP from its own trusted ingress and sends:
 *
 *   x-matchday-client-ip:            <canonical IP>
 *   x-matchday-client-ip-signature:  v1.<unix seconds>.<base64url HMAC-SHA256>
 *
 * with HMAC input `matchday-client-ip:v1:<ip>:<unix seconds>`. A browser can
 * send these headers too, so they are only honoured when the HMAC verifies
 * under MATCHDAY_CLIENT_IP_SECRET and the timestamp is fresh. Anything else
 * falls back to Fastify's `request.ip` (which already honours
 * API_TRUSTED_PROXIES), so a forged header can never be worse than sending no
 * header at all. The format must stay byte-identical to
 * apps/web/lib/client-ip.server.ts; both test suites pin the same vector.
 */
export const CLIENT_IP_HEADER = "x-matchday-client-ip";
export const CLIENT_IP_SIGNATURE_HEADER = "x-matchday-client-ip-signature";
export const CLIENT_IP_SIGNATURE_MAX_AGE_SECONDS = 60;
const signatureVersion = "v1";
const signaturePattern = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/u;

declare module "fastify" {
  interface FastifyRequest {
    /** End-user IP used for rate-limit keys; set by buildApp's onRequest hook. */
    matchdayClientIp: string | null;
  }
}

export type SignedClientIpVerification =
  | { status: "valid"; ip: string }
  | { status: "missing" }
  | { status: "invalid"; reason: "malformed" | "expired" | "signature" | "unconfigured" };

/** Canonicalises an IP literal (strips IPv4-mapped IPv6 and brackets); null when invalid. */
export function canonicalClientIp(value: string | undefined | null): string | null {
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

function signaturePayload(ip: string, timestampSeconds: number): string {
  return `matchday-client-ip:${signatureVersion}:${ip}:${timestampSeconds}`;
}

export function signClientIp(ip: string, secret: string, nowMs = Date.now()): string {
  const timestamp = Math.floor(nowMs / 1_000);
  const mac = createHmac("sha256", secret).update(signaturePayload(ip, timestamp), "utf8").digest("base64url");
  return `${signatureVersion}.${timestamp}.${mac}`;
}

function singleHeader(value: string | string[] | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  // A repeated header is ambiguous; never pick one of several candidates.
  return Array.isArray(value) ? (value.length === 1 ? (value[0] ?? null) : null) : value;
}

export function verifySignedClientIp(
  headers: FastifyRequest["headers"],
  secret: string | undefined,
  nowMs = Date.now(),
  maxAgeSeconds = CLIENT_IP_SIGNATURE_MAX_AGE_SECONDS,
): SignedClientIpVerification {
  const rawIp = singleHeader(headers[CLIENT_IP_HEADER]);
  const rawSignature = singleHeader(headers[CLIENT_IP_SIGNATURE_HEADER]);
  if (rawIp === undefined && rawSignature === undefined) return { status: "missing" };
  if (!secret) return { status: "invalid", reason: "unconfigured" };
  if (!rawIp || !rawSignature) return { status: "invalid", reason: "malformed" };
  const ip = canonicalClientIp(rawIp);
  const match = signaturePattern.exec(rawSignature);
  // The signed IP must already be canonical so one IP has exactly one signature.
  if (!ip || ip !== rawIp || !match?.[1] || !match[2]) return { status: "invalid", reason: "malformed" };
  const timestamp = Number(match[1]);
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > maxAgeSeconds) {
    return { status: "invalid", reason: "expired" };
  }
  const expected = createHmac("sha256", secret).update(signaturePayload(ip, timestamp), "utf8").digest();
  const presented = Buffer.from(match[2], "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { status: "invalid", reason: "signature" };
  }
  return { status: "valid", ip };
}

type WarnLogger = { warn: (payload: Record<string, unknown>, message: string) => void };

export type ClientIpResolverOptions = {
  secret: string | undefined;
  logger?: WarnLogger;
  now?: () => number;
  /** Minimum interval between invalid-signature warnings; counts are aggregated in between. */
  warnIntervalMs?: number;
};

/**
 * Returns the IP that rate limits should key on: the verified BFF-forwarded
 * client IP when the signature is valid, otherwise Fastify's `request.ip`.
 * Invalid signatures are logged (throttled) because they indicate either a
 * forging browser or a web/API secret mismatch that silently re-merges buckets.
 */
export function createClientIpResolver(options: ClientIpResolverOptions) {
  const now = options.now ?? Date.now;
  const warnIntervalMs = options.warnIntervalMs ?? 30_000;
  let lastWarnAt = Number.NEGATIVE_INFINITY;
  let suppressed: Record<string, number> = {};
  return (request: FastifyRequest): string => {
    const verification = verifySignedClientIp(request.headers, options.secret, now());
    if (verification.status === "valid") return verification.ip;
    if (verification.status === "invalid") {
      suppressed[verification.reason] = (suppressed[verification.reason] ?? 0) + 1;
      const at = now();
      if (options.logger && at - lastWarnAt >= warnIntervalMs) {
        lastWarnAt = at;
        options.logger.warn(
          { event: "client_ip_signature_rejected", rejected_since_last_warning: suppressed, peer_ip: request.ip },
          "Ignoring unverified forwarded client IP; falling back to the transport peer address",
        );
        suppressed = {};
      }
    }
    return request.ip;
  };
}

function expandIpv6(ip: string): number[] | null {
  let address = ip.split("%", 1)[0] ?? ip;
  // Rewrite an embedded dotted-quad tail (e.g. ::ffff:1.2.3.4) as two hex groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    address = `${address.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = address.split("::");
  const parse = (part: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (rest === undefined && missing !== 0)) return null;
  const groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

/**
 * Rate-limit subject for an IP. IPv6 clients are bucketed by /64 because a
 * single subscriber normally controls a whole /64 and could otherwise rotate
 * addresses to escape per-IP limits.
 */
export function rateLimitIpSubject(ip: string): string {
  const canonical = canonicalClientIp(ip) ?? ip;
  if (isIP(canonical) !== 6) return canonical;
  const groups = expandIpv6(canonical);
  if (!groups) return canonical;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The IP to use for per-client controls; falls back to `request.ip` outside buildApp. */
export function clientIpForRateLimit(request: FastifyRequest): string {
  return request.matchdayClientIp ?? request.ip;
}
